import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import type { AutomationDashboard, AutomationRule } from "./automation/domain";
import plugin from "./server";

let binDir: string;
let callLog: string;
let openPrsFile: string;
let closedPrsFile: string;
let baseShaFile: string;
let lowQuotaFlag: string;
const originalPath = process.env.PATH;

function ghCalls(): string[] {
  if (!existsSync(callLog)) return [];
  return readFileSync(callLog, "utf8").trim().split("\n").filter(Boolean);
}

const openPr = {
  number: 5,
  title: "Add widgets",
  state: "OPEN",
  isDraft: false,
  author: { login: "alex" },
  baseRefName: "main",
  headRefName: "feature/widgets",
  headRefOid: "sha-1",
  labels: [],
  reviewRequests: [],
  reviews: [],
  statusCheckRollup: [],
  headRepository: { name: "widgets" },
  headRepositoryOwner: { login: "acme" },
  isCrossRepository: false,
};

beforeEach(() => {
  binDir = mkdtempSync(join(tmpdir(), "bb-github-automation-"));
  callLog = join(binDir, "gh-calls.log");
  openPrsFile = join(binDir, "open-prs.json");
  closedPrsFile = join(binDir, "closed-prs.json");
  baseShaFile = join(binDir, "base-sha");
  lowQuotaFlag = join(binDir, "gh-low-quota");
  writeFileSync(openPrsFile, "[]");
  writeFileSync(closedPrsFile, "[]");
  writeFileSync(baseShaFile, "base-1");
  writeFileSync(
    join(binDir, "gh"),
    `#!/usr/bin/env bash
echo "$*" >> "${callLog}"
case "$*" in
  "--version") echo "gh version 2.96.0 (fake)";;
  "auth status --hostname github.com --active") echo "authenticated";;
  "auth token --hostname github.com") echo "gho_fake";;
  "api graphql -f query="*)
    if [ -e "${lowQuotaFlag}" ]; then
      printf '%s\\n' '{"data":{"rateLimit":{"limit":5000,"remaining":80,"used":4920,"resetAt":"2026-09-09T13:00:00.000Z","cost":1},"viewer":{"login":"octocat"}}}'
    else
      printf '%s\\n' '{"data":{"rateLimit":{"limit":5000,"remaining":4307,"used":693,"resetAt":"2026-09-09T12:18:36Z","cost":1},"viewer":{"login":"octocat"}}}'
    fi;;
  "api rate_limit") printf '%s\\n' '{"resources":{"core":{"limit":5000,"remaining":4992,"used":8,"reset":1788957722}}}';;
  "pr list -R acme/widgets --state open --limit 100 --json"*) cat "${openPrsFile}";;
  "pr list -R acme/widgets --state closed --limit 50 --search sort:updated-desc --json"*) cat "${closedPrsFile}";;
  "api repos/acme/widgets/git/ref/heads/main") printf '{"object":{"sha":"%s"}}\\n' "$(cat "${baseShaFile}")";;
  "api repos/acme/widgets") printf '%s\\n' '{}';;
  "pr comment "*|"pr review "*) echo "ok";;
  "api --method POST repos/acme/widgets/issues/"*) printf '%s\\n' '[]';;
  *) printf '%s\\n' '[]';;
esac
`,
  );
  chmodSync(join(binDir, "gh"), 0o755);
  process.env.PATH = `${binDir}:${originalPath ?? ""}`;
});

afterEach(() => {
  process.env.PATH = originalPath;
  rmSync(binDir, { recursive: true, force: true });
});

async function loadPlugin(
  settings: Record<string, unknown> = {},
  sdk: Record<string, unknown> = {},
) {
  const host = createFakePluginHost({
    pluginId: "github",
    settings: { extraRepos: "acme/widgets", automationDryRun: true, ...settings },
    agentSkillIds: ["github-automation"],
    sdk,
  });
  await plugin(host.bb);
  const dashboard = async () => (await host.harness.callRpc("automationDashboard")) as AutomationDashboard;
  const enableRepo = () => host.harness.callRpc("automationSetRepository", { repo: "acme/widgets", enabled: true });
  const pollNow = async () =>
    (await host.harness.callRpc("automationPollNow")) as { ran: boolean; queued: number; error: string | null };
  const saveRules = (rules: AutomationRule[]) => host.harness.callRpc("automationSaveRules", { rules });
  return { ...host, dashboard, enableRepo, pollNow, saveRules };
}

async function waitForJob(
  dashboard: () => Promise<AutomationDashboard>,
  jobId: number,
  status: string,
) {
  let job: AutomationDashboard["jobs"][number] | undefined;
  await vi.waitFor(
    async () => {
      job = (await dashboard()).jobs.find((entry) => entry.id === jobId);
      expect(job?.status).toBe(status);
    },
    { timeout: 4_000, interval: 25 },
  );
  return job!;
}

describe("GitHub+ automation", () => {
  it("seeds disabled starter rules and lists tracked repositories with automation off", async () => {
    const { harness, dashboard } = await loadPlugin();
    const data = await dashboard();
    expect(data.dryRun).toBe(true);
    expect(data.repositories).toEqual([
      { repo: "acme/widgets", enabled: false, baseBranch: "main", projectId: null, checkoutPath: null },
    ]);
    expect(data.rules.map((rule) => rule.id)).toEqual(["review-opened", "merged-update", "base-push-update"]);
    expect(data.rules.every((rule) => !rule.enabled && rule.approvalRequired)).toBe(true);
    expect(data.poll).toMatchObject({ enabled: true, intervalSeconds: 300, quotaPauseRemaining: 100, repositories: [] });
    expect(data.jobs).toEqual([]);
    expect(harness.registrations.rpcMethods).toEqual(
      expect.arrayContaining(["automationDashboard", "automationSaveRules", "automationPollNow", "automationReplayJob"]),
    );
  });

  it("polls only enabled repositories, baselines the first poll, then queues and dedupes events", async () => {
    const { harness, dashboard, enableRepo, pollNow } = await loadPlugin();
    expect(await pollNow()).toMatchObject({ ran: true, queued: 0, error: null });
    expect(ghCalls().filter((call) => call.startsWith("pr list"))).toEqual([]);

    await enableRepo();
    expect(await pollNow()).toMatchObject({ ran: true, queued: 0, error: null });
    let data = await dashboard();
    expect(data.poll.repositories).toEqual([
      expect.objectContaining({ repo: "acme/widgets", lastError: null, lastQueued: 0 }),
    ]);
    expect(data.poll.repositories[0]?.lastPolledAt).not.toBeNull();
    expect(data.audit.some((record) => record.kind === "poll" && record.outcome === "baseline")).toBe(true);
    expect(ghCalls().filter((call) => call.startsWith("pr list -R acme/widgets --state open"))).toHaveLength(1);

    writeFileSync(openPrsFile, JSON.stringify([openPr]));
    expect((await pollNow()).queued).toBe(1);
    expect((await pollNow()).queued).toBe(0);
    data = await dashboard();
    expect(data.jobs).toHaveLength(1);
    expect(data.jobs[0]).toMatchObject({
      repo: "acme/widgets",
      kind: "pr.opened",
      prNumber: 5,
      title: "Add widgets",
      status: "queued",
      approved: false,
    });
    expect(data.quota.graphql?.remaining).toBe(4307);
    expect(data.quota.login).toBe("octocat");

    writeFileSync(baseShaFile, "base-2");
    expect((await pollNow()).queued).toBe(1);
    const push = (await dashboard()).jobs.find((job) => job.kind === "push.base");
    expect(push).toMatchObject({ repo: "acme/widgets", prNumber: null, title: "Push to main" });
    expect(harness.realtimeSignals.some((signal) => signal.channel === "automation-changed")).toBe(true);
  });

  it("holds approval-gated matches, then runs their actions in dry-run once approved", async () => {
    const { harness, dashboard, enableRepo, pollNow, saveRules } = await loadPlugin();
    await enableRepo();
    await pollNow();
    const rules = (await dashboard()).rules.map((rule) =>
      rule.id === "review-opened" ? { ...rule, enabled: true } : rule,
    );
    await saveRules(rules);
    writeFileSync(openPrsFile, JSON.stringify([openPr]));
    expect((await pollNow()).queued).toBe(1);
    const jobId = (await dashboard()).jobs[0]!.id;

    const worker = harness.runService("automation-worker");
    try {
      const pending = await waitForJob(dashboard, jobId, "pending_approval");
      expect(pending.matchedRules).toEqual(["Review opened and updated pull requests"]);
      expect((await dashboard()).pendingApprovals).toBe(1);

      await expect(harness.callRpc("automationReplayJob", { jobId, approve: true })).resolves.toEqual({ queued: true });
      const done = await waitForJob(dashboard, jobId, "succeeded");
      expect(done.approved).toBe(true);
      expect(done.actions.map((run) => [run.actionKind, run.status])).toEqual([
        ["bb.review", "succeeded"],
        ["github.review", "succeeded"],
      ]);
      expect(done.actions[0]?.output).toContain("dry-run");
      expect(done.actions[1]?.output).toContain("dry-run");
      expect(done.actions[1]?.output).toContain("acme/widgets#5");
    } finally {
      worker.controller.abort();
      await worker.done;
    }
    expect(ghCalls().some((call) => call.startsWith("pr review") || call.startsWith("pr comment"))).toBe(false);
    expect(harness.sdk.callsTo("threads.spawn")).toEqual([]);
    const audit = (await dashboard()).audit;
    expect(audit.some((record) => record.kind === "job" && record.outcome === "pending-approval")).toBe(true);
    expect(audit.some((record) => record.kind === "action" && record.outcome === "dry-run")).toBe(true);
  });

  it("marks events that match no enabled rule as skipped without retrying", async () => {
    const { harness, dashboard, enableRepo, pollNow } = await loadPlugin();
    await enableRepo();
    await pollNow();
    writeFileSync(openPrsFile, JSON.stringify([openPr]));
    await pollNow();
    const jobId = (await dashboard()).jobs[0]!.id;
    const worker = harness.runService("automation-worker");
    try {
      const job = await waitForJob(dashboard, jobId, "skipped");
      expect(job.attempts).toBe(1);
      expect(job.matchedRules).toEqual([]);
    } finally {
      worker.controller.abort();
      await worker.done;
    }
  });

  it("runs live GitHub actions through gh when dry run is off", async () => {
    const { harness, dashboard, enableRepo, pollNow, saveRules } = await loadPlugin({ automationDryRun: false });
    await enableRepo();
    await pollNow();
    await saveRules([
      {
        id: "label-new",
        name: "Label new pull requests",
        enabled: true,
        order: 1,
        events: ["pr.opened"],
        repos: ["acme/widgets"],
        filters: { draft: false },
        conditionGroups: [
          {
            id: "g1",
            combinator: "or",
            conditions: [{ id: "c1", field: "head", operator: "matches", value: "feature/*" }],
          },
        ],
        actions: ["github.label", "github.comment"],
        actionParameters: { label: "needs-review", bodyTemplate: "Thanks {{actor}} for {{repo}}#{{prNumber}} ({{title}})" },
        approvalRequired: false,
      },
    ]);
    writeFileSync(openPrsFile, JSON.stringify([openPr]));
    await pollNow();
    const jobId = (await dashboard()).jobs[0]!.id;
    const worker = harness.runService("automation-worker");
    try {
      const job = await waitForJob(dashboard, jobId, "succeeded");
      expect(job.actions.map((run) => run.status)).toEqual(["succeeded", "succeeded"]);
    } finally {
      worker.controller.abort();
      await worker.done;
    }
    expect(ghCalls()).toContain("api --method POST repos/acme/widgets/issues/5/labels -f labels[]=needs-review");
    expect(ghCalls()).toContain("pr comment 5 -R acme/widgets --body Thanks alex for acme/widgets#5 (Add widgets)");
  });

  it("runs a live agent review in a spawned thread and posts its output as the review body", async () => {
    const { harness, dashboard, enableRepo, pollNow, saveRules } = await loadPlugin(
      { automationDryRun: false, defaultProject: "project-1" },
      {
        threads: {
          spawn: () => ({ id: "review-thread" }),
          wait: () => ({}),
          output: () => ({ output: "Looks good; one nit in src/index.ts." }),
          stop: () => ({ ok: true }),
        },
      },
    );
    await enableRepo();
    await pollNow();
    const rules = (await dashboard()).rules.map((rule) =>
      rule.id === "review-opened"
        ? { ...rule, enabled: true, approvalRequired: false, actionParameters: { ...rule.actionParameters, reviewPrompt: "Focus on tests." } }
        : rule,
    );
    await saveRules(rules);
    writeFileSync(openPrsFile, JSON.stringify([openPr]));
    await pollNow();
    const jobId = (await dashboard()).jobs[0]!.id;
    const worker = harness.runService("automation-worker");
    try {
      const job = await waitForJob(dashboard, jobId, "succeeded");
      expect(job.actions[0]).toMatchObject({ actionKind: "bb.review", status: "succeeded", output: "Looks good; one nit in src/index.ts." });
    } finally {
      worker.controller.abort();
      await worker.done;
    }
    const spawn = harness.sdk.callsTo("threads.spawn")[0]?.[0] as { prompt?: string; title?: string; projectId?: string };
    expect(spawn.projectId).toBe("project-1");
    expect(spawn.title).toBe("acme/widgets#5: Pull request review");
    expect(spawn.prompt).toContain("Additional trusted review instructions");
    expect(spawn.prompt).toContain("Focus on tests.");
    expect(harness.sdk.callsTo("threads.wait")[0]?.[0]).toMatchObject({ threadId: "review-thread", status: "idle" });
    expect(ghCalls()).toContain("pr review 5 -R acme/widgets --comment --body Looks good; one nit in src/index.ts.");
    await expect(harness.callRpc("listLinks")).resolves.toMatchObject({
      links: { "pr:acme/widgets#5": [expect.objectContaining({ threadId: "review-thread" })] },
    });
  });

  it("blocks poll now and reports auto-pause when GraphQL remaining is at the floor", async () => {
    const { dashboard, enableRepo, pollNow } = await loadPlugin();
    await enableRepo();
    writeFileSync(lowQuotaFlag, "");
    const paused = await pollNow();
    expect(paused.ran).toBe(false);
    expect(paused.error).toMatch(/at or below the pause threshold of 100/);
    const data = await dashboard();
    expect(data.poll.autoPaused).toBe(true);
    expect(data.poll.resumeAt).toBe("2026-09-09T13:00:00.000Z");
    expect(ghCalls().filter((call) => call.startsWith("pr list"))).toEqual([]);
  });

  it("updates polling settings and validates repository and rule input", async () => {
    const { harness, dashboard } = await loadPlugin();
    await expect(
      harness.callRpc("automationSetPolling", { enabled: false, intervalSeconds: 900, quotaPauseRemaining: 250 }),
    ).resolves.toEqual({ enabled: false, intervalSeconds: 900, quotaPauseRemaining: 250 });
    expect((await dashboard()).poll).toMatchObject({ enabled: false, intervalSeconds: 900, quotaPauseRemaining: 250, nextAt: null });
    await expect(harness.callRpc("automationSetPolling", { intervalSeconds: 5 })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(harness.callRpc("automationSetRepository", { repo: "other/repo", enabled: true })).rejects.toThrow(/not tracked/);
    await expect(harness.callRpc("automationSetRepository", { repo: "acme/widgets", baseBranch: "../evil" })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      harness.callRpc("automationSaveRules", {
        rules: [{ id: "x", name: "x", enabled: true, order: 1, events: ["pr.opened"], actions: ["github.fork.delete"] }],
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      harness.callRpc("automationSaveRules", {
        rules: [
          { id: "dup", name: "a", enabled: true, order: 1, events: ["pr.opened"], actions: ["bb.review"] },
          { id: "dup", name: "b", enabled: true, order: 2, events: ["pr.opened"], actions: ["bb.review"] },
        ],
      }),
    ).rejects.toThrow(/Duplicate rule id/);
  });

  it("creates approval-gated rules through the agent tool and advertises the skill", async () => {
    const { harness, dashboard } = await loadPlugin();
    const configuration = await harness.behavior.resolveAgentConfiguration({
      thread: { id: "thread-1", title: null, parentThreadId: null, sourceThreadId: null },
      project: { id: "project-1", kind: "standard", name: "Widgets", gitRemoteUrl: null },
      environment: { id: "environment-1", name: null, path: "/tmp/widgets", workspaceProvisionType: "unmanaged", branchName: "main" },
      host: { id: "host-1", name: "local" },
      provider: { id: "codex", model: "test", capabilities: { supportsNativeUserQuestion: false } },
      origin: { kind: null, pluginId: null },
    });
    expect(configuration.skills).toEqual(["github-automation"]);
    expect(configuration.tools.map((tool) => tool.name)).toEqual(["github_extended_create_rule"]);

    const result = await harness.behavior.callAgentTool(
      "github_extended_create_rule",
      {
        name: "Comment on CI failures",
        events: ["ci.failure"],
        actions: ["github.comment"],
        actionParameters: { bodyTemplate: "CI failed on {{repo}}#{{prNumber}}" },
        repo: "acme/widgets",
      },
      { projectId: "project-1" },
    );
    expect(result).toContain('Created disabled rule "Comment on CI failures" for acme/widgets; approval required.');
    expect(result).toContain("Automation is currently off for acme/widgets");
    expect((await dashboard()).rules).toContainEqual(
      expect.objectContaining({
        name: "Comment on CI failures",
        enabled: false,
        approvalRequired: true,
        repos: ["acme/widgets"],
        events: ["ci.failure"],
      }),
    );

    await expect(
      harness.behavior.callAgentTool(
        "github_extended_create_rule",
        { name: "No repo", events: ["pr.opened"], actions: ["bb.review"] },
        { projectId: "project-1" },
      ),
    ).rejects.toThrow(/No tracked GitHub repository/);
  });

  it("exposes rules, jobs, poll, and approve through the CLI", async () => {
    const { harness, enableRepo } = await loadPlugin();
    const rules = await harness.runCli(["rules"]);
    expect(rules.exitCode).toBe(0);
    expect(rules.stdout).toContain("review-opened\t[off, approval]\tReview opened and updated pull requests");
    await expect(harness.runCli(["jobs"])).resolves.toMatchObject({ exitCode: 0, stdout: "No automation events yet." });
    await expect(harness.runCli(["approve", "abc"])).resolves.toMatchObject({ exitCode: 1 });
    await expect(harness.runCli(["approve"])).resolves.toMatchObject({ exitCode: 1 });
    await expect(harness.runCli(["approve", "999"])).resolves.toMatchObject({
      exitCode: 1,
      stderr: "Job 999 is not waiting for approval or replay.",
    });
    await enableRepo();
    await expect(harness.runCli(["poll"])).resolves.toMatchObject({ exitCode: 0, stdout: "Queued 0 automation event(s)." });
    writeFileSync(openPrsFile, JSON.stringify([openPr]));
    await expect(harness.runCli(["poll"])).resolves.toMatchObject({ exitCode: 0, stdout: "Queued 1 automation event(s)." });
    const jobs = await harness.runCli(["jobs"]);
    expect(jobs.stdout).toContain("[queued]\tpr.opened\tacme/widgets#5\tAdd widgets");
  });
});
