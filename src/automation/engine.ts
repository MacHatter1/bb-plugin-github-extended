// The automation engine: per-repository enablement, ordered rules, a gh
// poller that turns pull-request transitions into durable jobs, a worker
// that runs approval-gated actions, and the audit trail. It borrows the
// plugin's gh runner, repository discovery, and review-thread spawning
// through `AutomationDeps` so it shares one GitHub login and one cache.
import { randomUUID } from "node:crypto";
import type { BbPluginApi, PluginRpcHandlers } from "@get-bb/plugin-sdk";
import type { z } from "zod";
import {
  DEFAULT_AUTOMATION_LABEL,
  STARTER_RULES,
  renderTemplate,
  type ActionKind,
  type AuditRecord,
  type AutomationDashboard,
  type AutomationRepository,
  type AutomationRule,
  type GithubQuota,
  type JobActionRun,
  type JobRecord,
  type JobStatus,
  type NormalisedEvent,
  type PollStatus,
  type RuleExecution,
} from "./domain.js";
import {
  POLL_INTERVAL_DEFAULT_SECONDS,
  POLL_JSON_FIELDS,
  POLL_OPEN_LIMIT,
  POLL_RECENT_LIMIT,
  QUOTA_PAUSE_DEFAULT,
  clampPollIntervalSeconds,
  clampQuotaPauseRemaining,
  diffRepoObservation,
  mergePullRequests,
  msUntilQuotaResume,
  nextPollAt,
  observationFromPoll,
  parseGithubBranchRef,
  parseGithubPullList,
  parseSnapshot,
  shouldPauseForQuota,
} from "./poller.js";
import {
  githubGraphqlRateLimitArgs,
  githubRestRateLimitArgs,
  parseGithubGraphqlQuota,
  parseGithubRestQuota,
} from "./quota.js";
import { matchingRules, rulesUsePaths } from "./rules.js";
import { ISSUE_POLL_JSON_FIELDS, diffIssueObservation, issueObservationFromPoll, parseIssueSnapshot, type IssuePollSnapshot } from "./issue-poller.js";
import {
  automationRpcMethods,
  createRuleInputSchema,
  quotaSchema,
  ruleSchema,
} from "./schemas.js";

export const AUTOMATION_MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS automation_repos (
     repo TEXT PRIMARY KEY,
     enabled INTEGER NOT NULL DEFAULT 0,
     base_branch TEXT NOT NULL DEFAULT 'main',
     updated_at TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS automation_rules (
     id TEXT PRIMARY KEY,
     position INTEGER NOT NULL,
     rule_json TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS automation_deliveries (
     delivery_id TEXT PRIMARY KEY,
     event_name TEXT NOT NULL,
     payload_json TEXT NOT NULL,
     received_at TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS automation_jobs (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     delivery_id TEXT NOT NULL UNIQUE REFERENCES automation_deliveries(delivery_id),
     repo TEXT NOT NULL,
     event_json TEXT NOT NULL,
     rules_json TEXT NOT NULL DEFAULT '[]',
     status TEXT NOT NULL DEFAULT 'queued',
     attempts INTEGER NOT NULL DEFAULT 0,
     approved INTEGER NOT NULL DEFAULT 0,
     error TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS automation_action_runs (
     job_id INTEGER NOT NULL,
     rule_id TEXT NOT NULL,
     action_index INTEGER NOT NULL,
     action_kind TEXT NOT NULL,
     status TEXT NOT NULL,
     output TEXT,
     updated_at TEXT NOT NULL,
     PRIMARY KEY (job_id, rule_id, action_index)
   )`,
  `CREATE TABLE IF NOT EXISTS automation_audit (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     created_at TEXT NOT NULL,
     kind TEXT NOT NULL,
     subject TEXT NOT NULL,
     outcome TEXT NOT NULL,
     detail TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS automation_state (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,
  "CREATE INDEX IF NOT EXISTS automation_jobs_repo_id ON automation_jobs (repo, id DESC)",
];

export const AUTOMATION_CHANNEL = "automation-changed";
const QUOTA_CACHE_TTL_MS = 30_000;
const MAX_ATTEMPTS = 3;
const AUDIT_RETENTION = 5_000;
const DASHBOARD_JOBS = 100;
const DASHBOARD_AUDIT = 200;

type Db = ReturnType<BbPluginApi["storage"]["database"]>;

export interface AutomationTrackedRepo {
  repo: string;
  projectId: string | null;
  checkoutPath: string | null;
}

export interface AutomationDeps {
  db: Db;
  log: Pick<BbPluginApi["log"], "info" | "warn">;
  publish: (payload: unknown) => void;
  gh: (args: string[], timeoutMs?: number) => Promise<string>;
  git: (args: string[], timeoutMs?: number) => Promise<string>;
  /** Rejects when the GitHub CLI is missing, unauthenticated, or unreachable. */
  ensureGhReady: () => Promise<void>;
  getDryRun: () => Promise<boolean>;
  listTrackedRepos: () => Promise<AutomationTrackedRepo[]>;
  runReview: (input: {
    repo: string;
    number: number;
    instructions?: string;
    execution?: RuleExecution;
    signal: AbortSignal;
  }) => Promise<{ threadId: string; output: string }>;
  runAgent: (input: {
    event: NormalisedEvent;
    ruleName: string;
    instructions: string;
    execution?: RuleExecution;
    signal: AbortSignal;
  }) => Promise<{ threadId: string; output: string }>;
}

export type CreateRuleInput = z.output<typeof createRuleInputSchema>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function emptyQuota(error: string | null = null): GithubQuota {
  return { available: false, login: null, checkedAt: null, error, graphql: null, rest: null };
}

function createWaiter() {
  let wake: (() => void) | null = null;
  return {
    get sleeping() {
      return wake !== null;
    },
    sleep(ms: number, signal: AbortSignal) {
      return new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", finish);
          if (wake === finish) wake = null;
          resolve();
        };
        const timer = setTimeout(finish, ms);
        wake = finish;
        if (signal.aborted) {
          finish();
          return;
        }
        signal.addEventListener("abort", finish, { once: true });
      });
    },
    interrupt() {
      wake?.();
    },
  };
}

type StoredRepoPoll = { lastPolledAt: string | null; lastError: string | null; lastQueued: number };
type StoredPollStatus = {
  inProgress: boolean;
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  lastError: string | null;
  lastQueued: number;
  repositories: Record<string, StoredRepoPoll>;
};

function emptyPollStatus(): StoredPollStatus {
  return { inProgress: false, lastStartedAt: null, lastFinishedAt: null, lastError: null, lastQueued: 0, repositories: {} };
}

interface JobRow {
  id: number;
  delivery_id: string;
  repo: string;
  event_json: string;
  rules_json: string;
  status: string;
  attempts: number;
  approved: number;
  error: string | null;
  created_at: string;
  updated_at: string;
}

interface ActionRunRow {
  job_id: number;
  rule_id: string;
  action_index: number;
  action_kind: string;
  status: string;
  output: string | null;
  updated_at: string;
}

const JOB_STATUS_SET = new Set<string>(["queued", "running", "pending_approval", "succeeded", "skipped", "dead_letter"]);

export function createAutomationEngine(deps: AutomationDeps) {
  const { db } = deps;
  const now = () => new Date().toISOString();
  const publish = () => deps.publish({ at: Date.now() });

  if ((db.prepare("SELECT count(*) AS count FROM automation_rules").get() as { count: number }).count === 0) {
    const insert = db.prepare("INSERT INTO automation_rules (id, position, rule_json, updated_at) VALUES (?, ?, ?, ?)");
    const at = now();
    db.transaction(() => {
      for (const rule of STARTER_RULES) insert.run(rule.id, rule.order, JSON.stringify(rule), at);
    })();
  }

  function audit(kind: string, subject: string, outcome: string, detail: string): void {
    db.prepare("INSERT INTO automation_audit (created_at, kind, subject, outcome, detail) VALUES (?, ?, ?, ?, ?)")
      .run(now(), kind, subject, outcome, detail.slice(0, 8_000));
    db.prepare(
      "DELETE FROM automation_audit WHERE id <= (SELECT id FROM automation_audit ORDER BY id DESC LIMIT 1 OFFSET ?)",
    ).run(AUDIT_RETENTION);
  }

  const setState = (key: string, value: string) =>
    db.prepare(
      "INSERT INTO automation_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    ).run(key, value, now());
  const getState = (key: string): string | null =>
    (db.prepare("SELECT value FROM automation_state WHERE key = ?").get(key) as { value: string } | undefined)?.value ?? null;
  const deleteState = (key: string) => db.prepare("DELETE FROM automation_state WHERE key = ?").run(key);

  // ------------------------------------------------------------------
  // Repositories: every tracked GitHub+ repo, with automation on/off and
  // its base branch stored locally.
  // ------------------------------------------------------------------
  function repoConfigs(): Map<string, { enabled: boolean; baseBranch: string }> {
    const rows = db.prepare("SELECT repo, enabled, base_branch FROM automation_repos").all() as Array<{
      repo: string;
      enabled: number;
      base_branch: string;
    }>;
    return new Map(rows.map((row) => [row.repo, { enabled: Boolean(row.enabled), baseBranch: row.base_branch }]));
  }

  async function repositories(): Promise<AutomationRepository[]> {
    const tracked = await deps.listTrackedRepos();
    const configs = repoConfigs();
    return tracked
      .map((entry) => {
        const config = configs.get(entry.repo);
        return {
          repo: entry.repo,
          enabled: config?.enabled ?? false,
          baseBranch: config?.baseBranch ?? "main",
          projectId: entry.projectId,
          checkoutPath: entry.checkoutPath,
        };
      })
      .sort((a, b) => a.repo.localeCompare(b.repo));
  }

  async function enabledRepositories(): Promise<AutomationRepository[]> {
    return (await repositories()).filter((repository) => repository.enabled);
  }

  async function setRepository(input: { repo: string; enabled?: boolean; baseBranch?: string }): Promise<AutomationRepository> {
    const current = (await repositories()).find((repository) => repository.repo === input.repo);
    if (current === undefined) throw new Error(`Repository ${input.repo} is not tracked by GitHub+`);
    const enabled = input.enabled ?? current.enabled;
    const baseBranch = input.baseBranch ?? current.baseBranch;
    db.prepare(
      "INSERT INTO automation_repos (repo, enabled, base_branch, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(repo) DO UPDATE SET enabled = excluded.enabled, base_branch = excluded.base_branch, updated_at = excluded.updated_at",
    ).run(input.repo, enabled ? 1 : 0, baseBranch, now());
    if (!enabled || baseBranch !== current.baseBranch) {
      // Re-enabling or retargeting starts from a fresh baseline instead of
      // replaying everything that changed while automation was off.
      deleteState(`poll_snapshot:${input.repo}`);
      deleteState(`issue_poll_snapshot:${input.repo}`);
    }
    audit("repository", input.repo, enabled ? "enabled" : "disabled", `base branch ${baseBranch}`);
    pollWaiter.interrupt();
    publish();
    return { ...current, enabled, baseBranch };
  }

  /** Drop automation config for repositories GitHub+ no longer tracks. */
  function pruneRepositories(tracked: ReadonlySet<string>): void {
    const rows = db.prepare("SELECT repo FROM automation_repos").all() as Array<{ repo: string }>;
    for (const { repo } of rows) {
      if (tracked.has(repo)) continue;
      db.prepare("DELETE FROM automation_repos WHERE repo = ?").run(repo);
      deleteState(`poll_snapshot:${repo}`);
      deleteState(`issue_poll_snapshot:${repo}`);
    }
  }

  // ------------------------------------------------------------------
  // Rules.
  // ------------------------------------------------------------------
  function readRules(): AutomationRule[] {
    const rows = db.prepare("SELECT rule_json FROM automation_rules ORDER BY position, id").all() as Array<{ rule_json: string }>;
    return rows.map((row) => ruleSchema.parse(JSON.parse(row.rule_json)));
  }

  function saveRules(rules: AutomationRule[]): AutomationRule[] {
    const parsed = rules.map((rule) => ruleSchema.parse(rule));
    const ids = new Set<string>();
    for (const rule of parsed) {
      if (ids.has(rule.id)) throw new Error(`Duplicate rule id ${rule.id}`);
      ids.add(rule.id);
    }
    const at = now();
    db.transaction(() => {
      db.prepare("DELETE FROM automation_rules").run();
      const insert = db.prepare("INSERT INTO automation_rules (id, position, rule_json, updated_at) VALUES (?, ?, ?, ?)");
      for (const rule of parsed) insert.run(rule.id, rule.order, JSON.stringify(rule), at);
    })();
    audit("rules", "all", "saved", `${parsed.length} rule(s), ${parsed.filter((rule) => rule.enabled).length} enabled`);
    publish();
    return parsed;
  }

  async function createRule(
    input: CreateRuleInput,
    projectId: string,
  ): Promise<{ rule: AutomationRule; repository: AutomationRepository }> {
    const { repo: requested, ...draft } = input;
    const all = await repositories();
    let repository: AutomationRepository | undefined;
    if (requested !== undefined) {
      repository = all.find((entry) => entry.repo === requested);
      if (repository === undefined) {
        throw new Error(
          `Repository ${requested} is not tracked by GitHub+; attach its BB project or add it under Repositories first`,
        );
      }
    } else {
      const matches = all.filter((entry) => entry.projectId === projectId);
      if (matches.length === 0) {
        throw new Error(
          "No tracked GitHub repository is attached to the current BB project; pass repo explicitly or add the repository in GitHub+ first",
        );
      }
      if (matches.length > 1) {
        throw new Error(
          `Multiple tracked repositories match the current BB project (${matches.map((entry) => entry.repo).join(", ")}); pass repo explicitly`,
        );
      }
      repository = matches[0]!;
    }
    const current = readRules();
    const rule = ruleSchema.parse({
      ...draft,
      id: `rule-${randomUUID().slice(0, 8)}`,
      order: Math.max(0, ...current.map((candidate) => candidate.order)) + 10,
      repos: [repository.repo],
    });
    saveRules([...current, rule]);
    return { rule, repository };
  }

  // ------------------------------------------------------------------
  // Poll settings and status.
  // ------------------------------------------------------------------
  const intervalSeconds = () => clampPollIntervalSeconds(getState("poll_interval_seconds") ?? POLL_INTERVAL_DEFAULT_SECONDS);
  const pollingEnabled = () => getState("polling_enabled") !== "0";
  const quotaPauseRemaining = () => clampQuotaPauseRemaining(getState("quota_pause_remaining") ?? QUOTA_PAUSE_DEFAULT);

  function readPollStatus(): StoredPollStatus {
    const raw = getState("poll_status");
    if (raw === null) return emptyPollStatus();
    try {
      const parsed = JSON.parse(raw) as Partial<StoredPollStatus>;
      return {
        inProgress: Boolean(parsed.inProgress),
        lastStartedAt: parsed.lastStartedAt ?? null,
        lastFinishedAt: parsed.lastFinishedAt ?? null,
        lastError: parsed.lastError ?? null,
        lastQueued: Number(parsed.lastQueued) || 0,
        repositories: parsed.repositories && typeof parsed.repositories === "object" ? parsed.repositories : {},
      };
    } catch {
      return emptyPollStatus();
    }
  }

  const writePollStatus = (status: StoredPollStatus) => setState("poll_status", JSON.stringify(status));

  function readCachedQuota(): GithubQuota | null {
    const raw = getState("github_quota");
    if (raw === null) return null;
    try {
      return quotaSchema.parse(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  function cachedQuotaFresh(): GithubQuota | null {
    const cached = readCachedQuota();
    if (cached?.checkedAt === null || cached?.checkedAt === undefined) return null;
    const at = Date.parse(cached.checkedAt);
    if (Number.isNaN(at) || Date.now() - at >= QUOTA_CACHE_TTL_MS) return null;
    return cached;
  }

  async function fetchQuota(force: boolean): Promise<GithubQuota> {
    if (!force) {
      const fresh = cachedQuotaFresh();
      if (fresh !== null) return fresh;
    }
    let quota: GithubQuota;
    try {
      await deps.ensureGhReady();
      const { login, graphql } = parseGithubGraphqlQuota(await deps.gh(githubGraphqlRateLimitArgs(), 15_000));
      let rest: GithubQuota["rest"] = null;
      try {
        rest = parseGithubRestQuota(await deps.gh(githubRestRateLimitArgs(), 15_000));
      } catch {
        rest = null;
      }
      quota = {
        available: true,
        login,
        checkedAt: now(),
        error: graphql === null ? "GitHub CLI did not return a GraphQL rateLimit payload." : null,
        graphql,
        rest,
      };
    } catch (error) {
      quota = emptyQuota(errorMessage(error));
      quota.checkedAt = now();
    }
    setState("github_quota", JSON.stringify(quota));
    publish();
    return quota;
  }

  function pollStatus(repos: AutomationRepository[]): PollStatus {
    const stored = readPollStatus();
    const enabled = pollingEnabled();
    const threshold = quotaPauseRemaining();
    const quota = readCachedQuota();
    const autoPaused = enabled && shouldPauseForQuota(quota?.graphql?.remaining, threshold);
    const resumeAt = autoPaused ? quota?.graphql?.resetAt ?? null : null;
    const interval = intervalSeconds();
    return {
      enabled,
      intervalSeconds: interval,
      inProgress: stored.inProgress,
      lastStartedAt: stored.lastStartedAt,
      lastFinishedAt: stored.lastFinishedAt,
      lastError: stored.lastError,
      lastQueued: stored.lastQueued,
      autoPaused,
      quotaPauseRemaining: threshold,
      resumeAt,
      nextAt: nextPollAt({
        enabled,
        inProgress: stored.inProgress,
        lastFinishedAt: stored.lastFinishedAt,
        intervalSeconds: interval,
        autoPaused,
        resumeAt,
      }),
      repositories: repos
        .filter((repository) => repository.enabled)
        .map((repository) => {
          const row = stored.repositories[repository.repo];
          return {
            repo: repository.repo,
            lastPolledAt: row?.lastPolledAt ?? null,
            lastError: row?.lastError ?? null,
            lastQueued: row?.lastQueued ?? 0,
          };
        }),
    };
  }

  // ------------------------------------------------------------------
  // Polling: gh issue/pr list for each enabled repository, diffed against the
  // stored snapshot; every new transition becomes one durable job.
  // ------------------------------------------------------------------
  const pollWaiter = createWaiter();
  const workerWaiter = createWaiter();
  let skipScheduledPoll = false;
  let pollLock: Promise<{ queued: number; error: string | null }> | null = null;

  async function pollRepository(repository: AutomationRepository): Promise<{ queued: number; events: number; baseline: boolean; error: string | null }> {
    const observedAt = now();
    const fields = POLL_JSON_FIELDS.join(",");
    const [openRaw, recentRaw] = await Promise.all([
      deps.gh(
        ["pr", "list", "-R", repository.repo, "--state", "open", "--limit", String(POLL_OPEN_LIMIT), "--json", fields],
        60_000,
      ),
      deps.gh(
        [
          "pr", "list", "-R", repository.repo, "--state", "closed", "--limit", String(POLL_RECENT_LIMIT),
          "--search", "sort:updated-desc", "--json", fields,
        ],
        60_000,
      ),
    ]);
    const pullRequests = mergePullRequests([parseGithubPullList(recentRaw), parseGithubPullList(openRaw)]);
    let baseSha: string | null = null;
    try {
      baseSha = parseGithubBranchRef(
        await deps.gh(["api", `repos/${repository.repo}/git/ref/heads/${repository.baseBranch}`], 15_000),
      );
    } catch {
      baseSha = null;
    }
    const current = observationFromPoll({ baseSha, pullRequests });
    const previous = parseSnapshot(getState(`poll_snapshot:${repository.repo}`));
    const events = diffRepoObservation(previous, current, repository);
    let issues: IssuePollSnapshot | null = null;
    let issueError: string | null = null;
    try {
      const outputs = await Promise.all([
        deps.gh(["issue", "list", "-R", repository.repo, "--state", "closed", "--limit", String(POLL_RECENT_LIMIT), "--search", "sort:updated-desc", "--json", ISSUE_POLL_JSON_FIELDS], 60_000),
        deps.gh(["issue", "list", "-R", repository.repo, "--state", "open", "--limit", String(POLL_OPEN_LIMIT), "--search", "sort:updated-desc", "--json", ISSUE_POLL_JSON_FIELDS], 60_000),
      ]);
      issues = issueObservationFromPoll(outputs, observedAt);
      events.push(...diffIssueObservation(parseIssueSnapshot(getState(`issue_poll_snapshot:${repository.repo}`)), issues, repository.repo));
    } catch (error) {
      const message = errorMessage(error);
      if (!/disabled issues|issues (?:are |have been )?disabled|issues are not enabled/i.test(message)) {
        issueError = `Issue polling: ${message}`;
        audit("poll", repository.repo, "warning", issueError);
      }
    }
    const at = now();
    let queued = 0;
    db.transaction(() => {
      for (const event of events) {
        const inserted = db
          .prepare("INSERT OR IGNORE INTO automation_deliveries (delivery_id, event_name, payload_json, received_at) VALUES (?, ?, ?, ?)")
          .run(event.deliveryId, event.kind, JSON.stringify(event.payload), at);
        if (inserted.changes === 0) continue;
        db.prepare(
          "INSERT INTO automation_jobs (delivery_id, repo, event_json, status, created_at, updated_at) VALUES (?, ?, ?, 'queued', ?, ?)",
        ).run(event.deliveryId, event.repo, JSON.stringify(event), at, at);
        queued += 1;
      }
      setState(`poll_snapshot:${repository.repo}`, JSON.stringify(current.snapshot));
      if (issues !== null) setState(`issue_poll_snapshot:${repository.repo}`, JSON.stringify(issues));
    })();
    return { queued, events: events.length, baseline: previous === null, error: issueError };
  }

  function pollAll(signal: AbortSignal): Promise<{ queued: number; error: string | null }> {
    if (pollLock !== null) return pollLock;
    pollLock = (async () => {
      const status = readPollStatus();
      status.inProgress = true;
      status.lastStartedAt = now();
      writePollStatus(status);
      publish();
      let queued = 0;
      let lastError: string | null = null;
      try {
        await deps.ensureGhReady();
        for (const repository of await enabledRepositories()) {
          if (signal.aborted) break;
          try {
            const result = await pollRepository(repository);
            queued += result.queued;
            status.repositories[repository.repo] = { lastPolledAt: now(), lastError: result.error, lastQueued: result.queued };
            if (result.error !== null) lastError = result.error;
            audit(
              "poll",
              repository.repo,
              result.baseline ? "baseline" : "ok",
              result.baseline
                ? "Stored the current GitHub state without enqueueing historical events"
                : `Queued ${result.queued} of ${result.events} detected event(s)`,
            );
          } catch (error) {
            const message = errorMessage(error);
            lastError = message;
            status.repositories[repository.repo] = {
              lastPolledAt: status.repositories[repository.repo]?.lastPolledAt ?? null,
              lastError: message.slice(0, 8_000),
              lastQueued: 0,
            };
            audit("poll", repository.repo, "error", message);
            deps.log.warn(`automation poll failed for ${repository.repo}: ${message}`);
          }
        }
      } catch (error) {
        lastError = errorMessage(error);
        audit("poll", "gh", "error", lastError);
      } finally {
        status.inProgress = false;
        status.lastFinishedAt = now();
        status.lastQueued = queued;
        status.lastError = lastError;
        writePollStatus(status);
        publish();
        pollLock = null;
      }
      if (queued > 0) workerWaiter.interrupt();
      return { queued, error: lastError };
    })();
    return pollLock;
  }

  async function pollNow(): Promise<{ ran: boolean; queued: number; error: string | null; intervalSeconds: number }> {
    const interval = intervalSeconds();
    const threshold = quotaPauseRemaining();
    const quota = await fetchQuota(true);
    if (shouldPauseForQuota(quota.graphql?.remaining, threshold)) {
      return {
        ran: false,
        queued: 0,
        error: `GraphQL remaining is ${quota.graphql?.remaining ?? 0}, at or below the pause threshold of ${threshold}. Polling resumes when the quota resets.`,
        intervalSeconds: interval,
      };
    }
    const result = await pollAll(AbortSignal.timeout(120_000));
    if (pollWaiter.sleeping) {
      skipScheduledPoll = true;
      pollWaiter.interrupt();
    }
    await fetchQuota(true);
    return { ran: true, queued: result.queued, error: result.error, intervalSeconds: interval };
  }

  async function runPoller(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const intervalMs = intervalSeconds() * 1000;
      const threshold = quotaPauseRemaining();
      let sleptForQuota = false;
      let active = false;
      try {
        active = pollingEnabled() && (await enabledRepositories()).length > 0;
      } catch (error) {
        deps.log.warn(`automation poller could not list repositories: ${errorMessage(error)}`);
      }
      if (active && !skipScheduledPoll) {
        let paused = false;
        const quota = await fetchQuota(true);
        if (shouldPauseForQuota(quota.graphql?.remaining, threshold)) {
          paused = true;
          sleptForQuota = true;
          const waitMs = Math.min(
            Math.max((msUntilQuotaResume(quota.graphql?.resetAt) ?? intervalMs) + 2_000, 5_000),
            3_600_000,
          );
          audit(
            "poll",
            "quota",
            "paused",
            `GraphQL remaining ${quota.graphql?.remaining} is at or below ${threshold}; resume at ${quota.graphql?.resetAt ?? "next interval"}`,
          );
          publish();
          if (!signal.aborted) await pollWaiter.sleep(waitMs, signal);
        }
        if (!paused && !signal.aborted) {
          await pollAll(signal);
          await fetchQuota(true);
        }
      }
      skipScheduledPoll = false;
      if (!signal.aborted && !sleptForQuota) await pollWaiter.sleep(intervalMs, signal);
    }
  }

  // ------------------------------------------------------------------
  // Jobs and actions.
  // ------------------------------------------------------------------
  function setJobStatus(id: number, status: JobStatus, error: string | null = null): void {
    db.prepare("UPDATE automation_jobs SET status = ?, error = ?, updated_at = ? WHERE id = ?").run(status, error, now(), id);
  }

  function latestAgentOutput(jobId: number, ruleId: string, index: number, kind: "bb.review" | "bb.agent"): string | null {
    const row = db
      .prepare(
        "SELECT output FROM automation_action_runs WHERE job_id = ? AND rule_id = ? AND action_index < ? AND action_kind = ? AND status = 'succeeded' ORDER BY action_index DESC LIMIT 1",
      )
      .get(jobId, ruleId, index, kind) as { output?: string | null } | undefined;
    return row?.output ?? null;
  }

  async function runAction(
    jobId: number,
    rule: AutomationRule,
    action: ActionKind,
    index: number,
    event: NormalisedEvent,
    repository: AutomationRepository,
    dryRun: boolean,
    signal: AbortSignal,
  ): Promise<void> {
    const existing = db
      .prepare("SELECT status FROM automation_action_runs WHERE job_id = ? AND rule_id = ? AND action_index = ?")
      .get(jobId, rule.id, index) as { status?: string } | undefined;
    if (existing?.status === "succeeded") return;
    db.prepare(
      "INSERT INTO automation_action_runs (job_id, rule_id, action_index, action_kind, status, output, updated_at) VALUES (?, ?, ?, ?, 'running', NULL, ?) ON CONFLICT(job_id, rule_id, action_index) DO UPDATE SET status = 'running', updated_at = excluded.updated_at",
    ).run(jobId, rule.id, index, action, now());
    const subject = `${jobId}/${rule.id}/${index}`;
    try {
      let output: string;
      const parameters = rule.actionParameters ?? {};
      if (action === "bb.review") {
        if (event.prNumber === undefined) throw new Error("bb.review requires a pull request event");
        if (dryRun) {
          output = `dry-run: would start a GitHub+ review thread for ${event.repo}#${event.prNumber}`;
        } else {
          const review = await deps.runReview({
            repo: event.repo,
            number: event.prNumber,
            instructions: parameters.reviewPrompt,
            execution: rule.execution,
            signal,
          });
          audit("action", subject, "thread", `bb.review thread ${review.threadId} for ${event.repo}#${event.prNumber}`);
          output = review.output;
        }
      } else if (action === "bb.agent") {
        const instructions = parameters.agentPrompt?.trim();
        if (!instructions) throw new Error("Describe what the agent should do");
        if (dryRun) {
          output = `dry-run: would start an agent for ${event.kind} on ${event.repo}:\n${instructions}`;
        } else {
          const agent = await deps.runAgent({ event, ruleName: rule.name, instructions, execution: rule.execution, signal });
          audit("action", subject, "thread", `bb.agent thread ${agent.threadId} for ${event.kind} on ${event.repo}`);
          output = agent.output;
        }
      } else if (action === "github.comment" || action === "github.review") {
        const number = event.issueNumber ?? event.prNumber;
        if (number === undefined) throw new Error(`${action} requires an issue or pull request event`);
        if (action === "github.review" && event.prNumber === undefined) throw new Error("github.review requires a pull request event");
        const review = latestAgentOutput(jobId, rule.id, index, "bb.review") ?? `Automated GitHub+ action for ${event.kind}.`;
        const agent = latestAgentOutput(jobId, rule.id, index, "bb.agent") ?? "";
        const body = renderTemplate(parameters.bodyTemplate || "{{review}}", event, review, agent);
        if (body.trim().length === 0) throw new Error(`${action} rendered an empty body`);
        if (dryRun) {
          output = `dry-run: would post ${action === "github.comment" ? "a comment" : "a review comment"} on ${event.repo}#${number}:\n${body.slice(0, 2_000)}`;
        } else {
          await deps.gh(
            action === "github.comment"
              ? [event.issueNumber !== undefined ? "issue" : "pr", "comment", String(number), "-R", event.repo, "--body", body]
              : ["pr", "review", String(number), "-R", event.repo, "--comment", "--body", body],
            30_000,
          );
          output = `${action} posted on ${event.repo}#${number}`;
        }
      } else if (action === "github.label") {
        const number = event.issueNumber ?? event.prNumber;
        if (number === undefined) throw new Error("github.label requires an issue or pull request event");
        const label = parameters.label?.trim() || DEFAULT_AUTOMATION_LABEL;
        if (dryRun) {
          output = `dry-run: would add label "${label}" to ${event.repo}#${number}`;
        } else {
          await deps.gh(
            ["api", "--method", "POST", `repos/${event.repo}/issues/${number}/labels`, "-f", `labels[]=${label}`],
            30_000,
          );
          output = `label "${label}" added to ${event.repo}#${number}`;
        }
      } else if (action === "checkout.update") {
        const branch = parameters.targetBranch || repository.baseBranch;
        if (repository.checkoutPath === null) {
          throw new Error(`${event.repo} has no local BB project checkout to update`);
        }
        const preview = `git -C ${repository.checkoutPath} pull --ff-only origin ${branch}`;
        if (dryRun) {
          output = `dry-run: ${preview}`;
        } else {
          const current = await deps.git(["-C", repository.checkoutPath, "branch", "--show-current"], 15_000);
          if (current !== branch) {
            throw new Error(
              `Refusing to update ${repository.checkoutPath}: current branch is ${current || "detached"}, expected ${branch}`,
            );
          }
          const pulled = await deps.git(["-C", repository.checkoutPath, "pull", "--ff-only", "origin", branch], 120_000);
          output = [preview, pulled].filter(Boolean).join("\n");
        }
      } else {
        const exhaustive: never = action;
        throw new Error(`Unsupported automation action: ${exhaustive}`);
      }
      db.prepare(
        "UPDATE automation_action_runs SET status = 'succeeded', output = ?, updated_at = ? WHERE job_id = ? AND rule_id = ? AND action_index = ?",
      ).run(output.slice(0, 100_000), now(), jobId, rule.id, index);
      audit("action", subject, dryRun ? "dry-run" : "succeeded", `${action}: ${output.slice(0, 2_000)}`);
    } catch (error) {
      const message = errorMessage(error);
      db.prepare(
        "UPDATE automation_action_runs SET status = 'failed', output = ?, updated_at = ? WHERE job_id = ? AND rule_id = ? AND action_index = ?",
      ).run(message.slice(0, 8_000), now(), jobId, rule.id, index);
      throw error;
    }
  }

  async function fetchPullFiles(repo: string, number: number): Promise<string[]> {
    const raw = await deps.gh(
      ["api", "--paginate", "--jq", ".[].filename", `repos/${repo}/pulls/${number}/files?per_page=100`],
      30_000,
    );
    return raw.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  }

  async function processOne(signal: AbortSignal): Promise<boolean> {
    const row = db.prepare("SELECT * FROM automation_jobs WHERE status = 'queued' ORDER BY id LIMIT 1").get() as JobRow | undefined;
    if (row === undefined) return false;
    const claimed = db
      .prepare("UPDATE automation_jobs SET status = 'running', attempts = attempts + 1, updated_at = ? WHERE id = ? AND status = 'queued'")
      .run(now(), row.id);
    if (claimed.changes === 0) return true;
    publish();
    try {
      const dryRun = await deps.getDryRun();
      const event = JSON.parse(row.event_json) as NormalisedEvent;
      const repository = (await repositories()).find((entry) => entry.repo === event.repo);
      if (repository === undefined || !repository.enabled) {
        setJobStatus(row.id, "skipped", repository === undefined ? `Repository ${event.repo} is no longer tracked` : `Automation is disabled for ${event.repo}`);
        audit("job", String(row.id), "skipped", repository === undefined ? "repository untracked" : "automation disabled");
        publish();
        return true;
      }
      const allRules = readRules();
      if (event.prNumber !== undefined && rulesUsePaths(allRules)) {
        try {
          event.files = await fetchPullFiles(event.repo, event.prNumber);
        } catch (error) {
          audit("enrichment", row.delivery_id, "warning", errorMessage(error));
        }
      }
      const rules = matchingRules(allRules, event);
      db.prepare("UPDATE automation_jobs SET rules_json = ? WHERE id = ?")
        .run(JSON.stringify(rules.map((rule) => ({ id: rule.id, name: rule.name }))), row.id);
      if (rules.length === 0) {
        setJobStatus(row.id, "skipped");
        audit("job", String(row.id), "skipped", `${event.kind} on ${event.repo} matched no enabled rule`);
        publish();
        return true;
      }
      if (rules.some((rule) => rule.approvalRequired) && !row.approved) {
        setJobStatus(row.id, "pending_approval");
        audit("job", String(row.id), "pending-approval", `${rules.length} matching rule(s): ${rules.map((rule) => rule.name).join(", ")}`);
        publish();
        return true;
      }
      for (const rule of rules) {
        for (const [index, action] of rule.actions.entries()) {
          if (signal.aborted) throw new Error("aborted");
          await runAction(row.id, rule, action, index, event, repository, dryRun, signal);
        }
      }
      setJobStatus(row.id, "succeeded");
      audit("job", String(row.id), dryRun ? "dry-run" : "succeeded", `${rules.length} rule(s) ran for ${event.kind} on ${event.repo}`);
    } catch (error) {
      const message = errorMessage(error);
      if (signal.aborted) {
        db.prepare("UPDATE automation_jobs SET status = 'queued', error = NULL, updated_at = ? WHERE id = ?").run(now(), row.id);
        return true;
      }
      const status: JobStatus = row.attempts + 1 >= MAX_ATTEMPTS ? "dead_letter" : "queued";
      setJobStatus(row.id, status, message.slice(0, 8_000));
      audit("job", String(row.id), status, message);
      deps.log.warn(`automation job ${row.id} failed (${status}): ${message}`);
    }
    publish();
    return true;
  }

  async function runWorker(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      let worked = false;
      try {
        worked = await processOne(signal);
      } catch (error) {
        deps.log.warn(`automation worker error: ${errorMessage(error)}`);
      }
      if (!worked && !signal.aborted) await workerWaiter.sleep(5_000, signal);
    }
  }

  function replayJob(jobId: number, approve: boolean): { queued: boolean } {
    const result = db
      .prepare(
        "UPDATE automation_jobs SET status = 'queued', approved = ?, error = NULL, updated_at = ? WHERE id = ? AND status IN ('dead_letter', 'pending_approval', 'succeeded', 'skipped')",
      )
      .run(approve ? 1 : 0, now(), jobId);
    if (result.changes > 0) {
      audit("job", String(jobId), "manual-replay", approve ? "approved" : "not approved");
      workerWaiter.interrupt();
      publish();
    }
    return { queued: result.changes > 0 };
  }

  function reconcile(): { queued: number } {
    const result = db.prepare("UPDATE automation_jobs SET status = 'queued', updated_at = ? WHERE status = 'running'").run(now());
    audit("reconcile", "jobs", "completed", `${result.changes} stale running job(s) requeued`);
    if (result.changes > 0) {
      workerWaiter.interrupt();
      publish();
    }
    return { queued: result.changes };
  }

  function listJobs(limit: number, pendingOnly = false): JobRecord[] {
    const rows = (pendingOnly
      ? db.prepare("SELECT * FROM automation_jobs WHERE status = 'pending_approval' ORDER BY id DESC").all()
      : db.prepare("SELECT * FROM automation_jobs ORDER BY id DESC LIMIT ?").all(limit)) as JobRow[];
    return hydrateJobs(rows);
  }

  function hydrateJobs(rows: JobRow[]): JobRecord[] {
    if (rows.length === 0) return [];
    const placeholders = rows.map(() => "?").join(",");
    const runs = db
      .prepare(`SELECT * FROM automation_action_runs WHERE job_id IN (${placeholders}) ORDER BY job_id, rule_id, action_index`)
      .all(...rows.map((row) => row.id)) as ActionRunRow[];
    const runsByJob = new Map<number, ActionRunRow[]>();
    for (const run of runs) {
      const list = runsByJob.get(run.job_id) ?? [];
      list.push(run);
      runsByJob.set(run.job_id, list);
    }
    return rows.map((row) => {
      let event: Partial<NormalisedEvent> = {};
      try {
        event = JSON.parse(row.event_json) as NormalisedEvent;
      } catch {
        event = {};
      }
      let matched: Array<{ id: string; name: string }> = [];
      try {
        const parsed: unknown = JSON.parse(row.rules_json);
        matched = Array.isArray(parsed)
          ? parsed.filter((entry): entry is { id: string; name: string } =>
              typeof entry === "object" && entry !== null && typeof (entry as { id?: unknown }).id === "string" && typeof (entry as { name?: unknown }).name === "string",
            )
          : [];
      } catch {
        matched = [];
      }
      const names = new Map(matched.map((entry) => [entry.id, entry.name]));
      const actions: JobActionRun[] = (runsByJob.get(row.id) ?? []).map((run) => ({
        ruleId: run.rule_id,
        ruleName: names.get(run.rule_id) ?? run.rule_id,
        actionIndex: run.action_index,
        actionKind: run.action_kind as ActionKind,
        status: run.status === "succeeded" || run.status === "failed" ? run.status : "running",
        output: run.output,
        updatedAt: run.updated_at,
      }));
      return {
        id: row.id,
        deliveryId: row.delivery_id,
        repo: row.repo,
        kind: (event.kind ?? "pr.opened") as NormalisedEvent["kind"],
        prNumber: typeof event.prNumber === "number" ? event.prNumber : null,
        issueNumber: typeof event.issueNumber === "number" ? event.issueNumber : null,
        title: typeof event.title === "string" ? event.title : "",
        status: JOB_STATUS_SET.has(row.status) ? (row.status as JobStatus) : "queued",
        attempts: row.attempts,
        approved: Boolean(row.approved),
        error: row.error,
        matchedRules: matched.map((entry) => entry.name),
        actions,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    });
  }

  function listAudit(limit: number, jobIds?: number[]): AuditRecord[] {
    if (jobIds?.length === 0) return [];
    const subjects = jobIds?.map(String);
    const placeholders = subjects?.map(() => "?").join(",");
    const rows = (subjects
      ? db.prepare(`SELECT * FROM automation_audit WHERE subject IN (${placeholders}) OR substr(subject, 1, instr(subject, '/') - 1) IN (${placeholders}) ORDER BY id DESC LIMIT ?`).all(...subjects, ...subjects, limit)
      : db.prepare("SELECT * FROM automation_audit ORDER BY id DESC LIMIT ?").all(limit)) as Array<{
      id: number;
      created_at: string;
      kind: string;
      subject: string;
      outcome: string;
      detail: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      kind: row.kind,
      subject: row.subject,
      outcome: row.outcome,
      detail: row.detail,
    }));
  }

  async function dashboard(): Promise<AutomationDashboard> {
    const repos = await repositories();
    const pending = db
      .prepare("SELECT count(*) AS count FROM automation_jobs WHERE status = 'pending_approval'")
      .get() as { count: number };
    return {
      dryRun: await deps.getDryRun(),
      repositories: repos,
      enabledRepositoryCount: repos.filter((repository) => repository.enabled).length,
      rules: readRules(),
      jobs: [...new Map([...listJobs(DASHBOARD_JOBS), ...listJobs(0, true)].map((job) => [job.id, job])).values()].sort((a, b) => b.id - a.id),
      pendingApprovals: pending.count,
      audit: listAudit(DASHBOARD_AUDIT),
      poll: pollStatus(repos),
      quota: readCachedQuota() ?? emptyQuota(),
    };
  }

  const handlers: PluginRpcHandlers<typeof automationRpcMethods> = {
    automationDashboard: () => dashboard(),
    automationListJobs: ({ repo, offset, limit }) => {
      const where = repo ? "WHERE repo = ?" : "";
      const parameters = repo ? [repo] : [];
      const { count } = db.prepare(`SELECT count(*) AS count FROM automation_jobs ${where}`).get(...parameters) as { count: number };
      const rows = db.prepare(`SELECT * FROM automation_jobs ${where} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...parameters, limit, offset) as JobRow[];
      return { jobs: hydrateJobs(rows), total: count, audit: listAudit(DASHBOARD_AUDIT, rows.map((row) => row.id)) };
    },
    automationSetRepository: (input) => setRepository(input),
    automationSaveRules: ({ rules, expectedRules }) => {
      if (expectedRules && JSON.stringify(readRules()) !== JSON.stringify(expectedRules)) {
        throw new Error("Automations changed elsewhere. Refresh and review the saved version before saving.");
      }
      return { saved: saveRules(rules).length };
    },
    automationSetRuleEnabled: ({ id, enabled }) => {
      const rules = readRules();
      if (!rules.some((rule) => rule.id === id)) throw new Error("Automation no longer exists. Refresh and try again.");
      saveRules(rules.map((rule) => rule.id === id ? { ...rule, enabled } : rule));
      return { ok: true };
    },
    automationPollNow: () => pollNow(),
    automationSetPolling: ({ enabled, intervalSeconds: seconds, quotaPauseRemaining: remaining }) => {
      if (enabled !== undefined) setState("polling_enabled", enabled ? "1" : "0");
      if (seconds !== undefined) setState("poll_interval_seconds", String(clampPollIntervalSeconds(seconds)));
      if (remaining !== undefined) setState("quota_pause_remaining", String(clampQuotaPauseRemaining(remaining)));
      audit(
        "poll",
        "settings",
        "updated",
        `polling ${pollingEnabled() ? "on" : "off"}, every ${intervalSeconds()}s, pause at ${quotaPauseRemaining()} GraphQL points`,
      );
      pollWaiter.interrupt();
      publish();
      return { enabled: pollingEnabled(), intervalSeconds: intervalSeconds(), quotaPauseRemaining: quotaPauseRemaining() };
    },
    automationQuota: ({ force = false }) => fetchQuota(force),
    automationReplayJob: ({ jobId, approve }) => replayJob(jobId, approve),
    automationReconcile: () => reconcile(),
  };

  return {
    handlers,
    runPoller,
    runWorker,
    dashboard,
    repositories,
    readRules,
    createRule,
    listJobs,
    pollNow,
    replayJob,
    pruneRepositories,
  };
}

export type AutomationEngine = ReturnType<typeof createAutomationEngine>;
