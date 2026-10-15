// gh pull-request snapshots and the diff between two polls. The first poll
// of a repository stores a baseline; later polls turn state transitions
// into events with stable delivery ids so nothing is enqueued twice.
import type { EventKind, NormalisedEvent } from "./domain.js";

export const POLL_INTERVAL_MIN_SECONDS = 60;
export const POLL_INTERVAL_MAX_SECONDS = 3600;
/** Five minutes. `gh pr list --json` is GraphQL and shares the user's 5,000 points/hour quota. */
export const POLL_INTERVAL_DEFAULT_SECONDS = 300;
export const POLL_INTERVAL_PRESETS = [60, 120, 300, 900, 3600] as const;
export const QUOTA_PAUSE_MIN = 0;
export const QUOTA_PAUSE_MAX = 5_000;
export const QUOTA_PAUSE_DEFAULT = 100;
export const QUOTA_PAUSE_PRESETS = [0, 50, 100, 250, 500] as const;
export const POLL_OPEN_LIMIT = 100;
export const POLL_RECENT_LIMIT = 50;

export type CiState = "success" | "failure" | "pending" | null;
export type PrLifecycle = "open" | "closed" | "merged";

export interface PollReview {
  id: string;
  author: string;
  state: string;
}

export interface PollPrSnapshot {
  number: number;
  title: string;
  sha: string;
  state: PrLifecycle;
  draft: boolean;
  actor: string;
  base: string;
  head: string;
  labels: string[];
  requestedReviewers: string[];
  reviews: PollReview[];
  ci: CiState;
}

export interface RepoPollSnapshot {
  baseSha: string | null;
  prs: Record<string, PollPrSnapshot>;
}

export interface HeadRepo {
  name: string;
  owner: string;
  fork: boolean;
}

export interface PollPrObservation extends PollPrSnapshot {
  headRepo: HeadRepo | null;
}

export interface RepoPollObservation {
  snapshot: RepoPollSnapshot;
  prs: PollPrObservation[];
}

export interface PollRepository {
  repo: string;
  baseBranch: string;
}

export function clampPollIntervalSeconds(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return POLL_INTERVAL_DEFAULT_SECONDS;
  return Math.min(POLL_INTERVAL_MAX_SECONDS, Math.max(POLL_INTERVAL_MIN_SECONDS, Math.round(n)));
}

export function formatPollInterval(seconds: number): string {
  const clamped = clampPollIntervalSeconds(seconds);
  if (clamped % 3600 === 0) return `${clamped / 3600}h`;
  if (clamped % 60 === 0) return `${clamped / 60}m`;
  return `${clamped}s`;
}

export function clampQuotaPauseRemaining(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return QUOTA_PAUSE_DEFAULT;
  return Math.min(QUOTA_PAUSE_MAX, Math.max(QUOTA_PAUSE_MIN, Math.round(n)));
}

export function shouldPauseForQuota(remaining: number | null | undefined, threshold: number): boolean {
  if (threshold <= 0 || remaining == null) return false;
  return remaining <= threshold;
}

export function msUntilQuotaResume(resetAt: string | null | undefined, nowMs = Date.now()): number | null {
  if (!resetAt) return null;
  const reset = Date.parse(resetAt);
  if (Number.isNaN(reset)) return null;
  return Math.max(0, reset - nowMs);
}

export function nextPollAt(input: {
  enabled: boolean;
  inProgress: boolean;
  lastFinishedAt: string | null;
  intervalSeconds: number;
  autoPaused?: boolean;
  resumeAt?: string | null;
  nowMs?: number;
}): string | null {
  if (!input.enabled || input.inProgress) return null;
  if (input.autoPaused) return input.resumeAt ?? null;
  const intervalMs = clampPollIntervalSeconds(input.intervalSeconds) * 1000;
  const now = input.nowMs ?? Date.now();
  if (!input.lastFinishedAt) return new Date(now).toISOString();
  const finished = Date.parse(input.lastFinishedAt);
  if (Number.isNaN(finished)) return new Date(now).toISOString();
  return new Date(Math.max(now, finished + intervalMs)).toISOString();
}

export function pollDeliveryId(repo: string, kind: EventKind, key: string): string {
  return `poll:${repo}:${kind}:${key}`.slice(0, 240);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function loginOf(value: unknown): string {
  if (typeof value === "string") return value;
  const record = asRecord(value);
  if (!record) return "";
  return asString(record.login) || asString(record.slug) || asString(record.name);
}

const FAILURE_CI = new Set([
  "FAILURE",
  "ERROR",
  "TIMED_OUT",
  "CANCELLED",
  "CANCELED",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
  "TIMEDOUT",
]);
const PENDING_CI = new Set(["PENDING", "QUEUED", "IN_PROGRESS", "EXPECTED", "WAITING", "REQUESTED"]);

export function summariseCi(rollup: unknown): CiState {
  const items = Array.isArray(rollup) ? rollup : rollup == null ? [] : [rollup];
  if (items.length === 0) return null;
  let pending = false;
  let sawCompleted = false;
  for (const item of items) {
    const record = asRecord(item);
    if (!record) continue;
    const conclusion = asString(record.conclusion).toUpperCase();
    const status = asString(record.status).toUpperCase();
    const state = asString(record.state).toUpperCase();
    if (FAILURE_CI.has(conclusion) || FAILURE_CI.has(state)) return "failure";
    if (PENDING_CI.has(status) || PENDING_CI.has(state) || PENDING_CI.has(conclusion)) {
      pending = true;
      continue;
    }
    if (status && status !== "COMPLETED" && status !== "SUCCESS") {
      pending = true;
      continue;
    }
    sawCompleted = true;
  }
  if (pending) return "pending";
  if (sawCompleted) return "success";
  return null;
}

export function parsePrLifecycle(state: unknown, mergedAt: unknown): PrLifecycle {
  const normalised = asString(state).toUpperCase();
  if (normalised === "MERGED" || (typeof mergedAt === "string" && mergedAt.length > 0 && normalised !== "OPEN")) {
    return "merged";
  }
  if (normalised === "CLOSED") return "closed";
  return "open";
}

function reviewId(raw: Record<string, unknown>, fallback: string): string {
  if (typeof raw.id === "string" && raw.id) return raw.id;
  if (typeof raw.id === "number") return String(raw.id);
  if (typeof raw.databaseId === "number") return String(raw.databaseId);
  return fallback;
}

function parseReviews(raw: unknown): PollReview[] {
  return asArray(raw).flatMap((item, index) => {
    const record = asRecord(item);
    if (!record) return [];
    const state = asString(record.state).toUpperCase().replace("CHANGED_REQUESTED", "CHANGES_REQUESTED");
    if (!state) return [];
    const author = loginOf(record.author) || loginOf(record.user);
    return [{
      id: reviewId(record, `${author || "review"}:${state}:${asString(record.submittedAt) || index}`),
      author,
      state,
    }];
  });
}

function parseRequestedReviewers(raw: unknown): string[] {
  const names = asArray(raw).map(loginOf).filter(Boolean);
  return [...new Set(names)].sort((a, b) => a.localeCompare(b));
}

function parseLabels(raw: unknown): string[] {
  return asArray(raw)
    .map((item) => (typeof item === "string" ? item : asString(asRecord(item)?.name)))
    .filter(Boolean);
}

export function parseGhPull(raw: unknown): PollPrObservation | null {
  const record = asRecord(raw);
  if (!record || typeof record.number !== "number" || !Number.isInteger(record.number) || record.number < 1) {
    return null;
  }
  const reviews = parseReviews(
    Array.isArray(record.reviews) && record.reviews.length > 0 ? record.reviews : record.latestReviews,
  );
  const head = asRecord(record.head);
  const headRepository = asRecord(record.headRepository) ?? asRecord(head?.repo);
  const headOwner = asRecord(record.headRepositoryOwner) ?? asRecord(headRepository?.owner);
  const headName = asString(headRepository?.name);
  const headOwnerLogin = loginOf(headOwner);
  const checkRuns = asArray(record.check_runs);
  const combined = asRecord(record.status);
  const statuses = asArray(combined?.statuses ?? record.statuses);
  const rollup = [
    ...asArray(record.statusCheckRollup),
    ...checkRuns,
    ...statuses,
    ...(typeof combined?.state === "string" ? [{ state: combined.state }] : []),
  ];
  return {
    number: record.number,
    title: asString(record.title),
    sha: asString(record.headRefOid) || asString(record.sha) || asString(head?.sha),
    state: parsePrLifecycle(record.state, record.mergedAt ?? record.merged_at),
    draft: Boolean(record.isDraft ?? record.draft),
    actor: loginOf(record.author) || loginOf(record.user),
    base: asString(record.baseRefName) || asString(asRecord(record.base)?.ref),
    head: asString(record.headRefName) || asString(head?.ref),
    labels: parseLabels(record.labels),
    requestedReviewers: parseRequestedReviewers(record.reviewRequests ?? record.requested_reviewers),
    reviews,
    ci: summariseCi(rollup.length > 0 ? rollup : record.statusCheckRollup),
    headRepo: headName && headOwnerLogin
      ? { name: headName, owner: headOwnerLogin, fork: Boolean(record.isCrossRepository ?? headRepository?.fork) }
      : null,
  };
}

export function observationFromPoll(input: {
  baseSha: string | null;
  pullRequests: unknown[];
}): RepoPollObservation {
  const prs = input.pullRequests.map(parseGhPull).filter((pr): pr is PollPrObservation => pr !== null);
  const snapshot: RepoPollSnapshot = {
    baseSha: input.baseSha,
    prs: Object.fromEntries(prs.map((pr) => [String(pr.number), toSnapshot(pr)])),
  };
  return { snapshot, prs };
}

function toSnapshot(pr: PollPrObservation): PollPrSnapshot {
  const { headRepo: _headRepo, ...snapshot } = pr;
  return snapshot;
}

export function parseSnapshot(raw: string | null): RepoPollSnapshot | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    const record = asRecord(parsed);
    const prs = asRecord(record?.prs);
    if (!record || !prs) return null;
    return {
      baseSha: typeof record.baseSha === "string" ? record.baseSha : null,
      prs: Object.fromEntries(Object.entries(prs).flatMap(([key, value]) => {
        const pr = asRecord(value);
        if (!pr || typeof pr.number !== "number") return [];
        return [[key, {
          number: pr.number,
          title: asString(pr.title),
          sha: asString(pr.sha),
          state: parsePrLifecycle(pr.state, null),
          draft: Boolean(pr.draft),
          actor: asString(pr.actor),
          base: asString(pr.base),
          head: asString(pr.head),
          labels: asArray(pr.labels).filter((item): item is string => typeof item === "string"),
          requestedReviewers: asArray(pr.requestedReviewers).filter((item): item is string => typeof item === "string"),
          reviews: parseReviews(pr.reviews),
          ci: pr.ci === "success" || pr.ci === "failure" || pr.ci === "pending" ? pr.ci : null,
        } satisfies PollPrSnapshot]];
      })),
    };
  } catch {
    return null;
  }
}

function eventPayload(
  pr: PollPrObservation | undefined,
  repository: PollRepository,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const [owner = "", name = ""] = repository.repo.split("/");
  const headRepo = pr?.headRepo;
  return {
    repository: { name, owner: { login: owner }, full_name: repository.repo },
    sender: { login: pr?.actor ?? "" },
    ...(pr
      ? {
        number: pr.number,
        pull_request: {
          number: pr.number,
          title: pr.title,
          draft: pr.draft,
          merged: pr.state === "merged",
          user: { login: pr.actor },
          base: { ref: pr.base },
          head: {
            ref: pr.head,
            sha: pr.sha,
            repo: headRepo
              ? { name: headRepo.name, owner: { login: headRepo.owner }, fork: headRepo.fork }
              : { name, owner: { login: owner }, fork: false },
          },
          labels: pr.labels.map((label) => ({ name: label })),
        },
      }
      : {}),
    ...extra,
  };
}

function buildEvent(
  repository: PollRepository,
  kind: EventKind,
  key: string,
  fields: {
    pr?: PollPrObservation;
    actor?: string;
    sha?: string;
    base?: string;
    title?: string;
    extraPayload?: Record<string, unknown>;
  } = {},
): NormalisedEvent {
  const pr = fields.pr;
  return {
    deliveryId: pollDeliveryId(repository.repo, kind, key),
    kind,
    repo: repository.repo,
    actor: fields.actor ?? pr?.actor ?? "",
    base: fields.base ?? pr?.base ?? "",
    head: pr?.head ?? "",
    draft: pr?.draft ?? false,
    labels: pr?.labels ?? [],
    files: [],
    prNumber: pr?.number,
    sha: fields.sha ?? pr?.sha,
    title: fields.title ?? pr?.title ?? "",
    payload: eventPayload(pr, repository, fields.extraPayload ?? {}),
  };
}

function reviewState(state: string): "APPROVED" | "CHANGES_REQUESTED" | null {
  const normalised = state.toUpperCase().replace("CHANGED_REQUESTED", "CHANGES_REQUESTED");
  if (normalised === "APPROVED") return "APPROVED";
  if (normalised === "CHANGES_REQUESTED") return "CHANGES_REQUESTED";
  return null;
}

export function diffRepoObservation(
  previous: RepoPollSnapshot | null,
  current: RepoPollObservation,
  repository: PollRepository,
): NormalisedEvent[] {
  if (previous === null) return [];
  const events: NormalisedEvent[] = [];
  const previousPrs = previous.prs;

  if (previous.baseSha && current.snapshot.baseSha && previous.baseSha !== current.snapshot.baseSha) {
    events.push(buildEvent(repository, "push.base", current.snapshot.baseSha, {
      sha: current.snapshot.baseSha,
      base: repository.baseBranch,
      title: `Push to ${repository.baseBranch}`,
      extraPayload: { ref: `refs/heads/${repository.baseBranch}`, after: current.snapshot.baseSha },
    }));
  }

  for (const pr of current.prs) {
    const before = previousPrs[String(pr.number)];
    if (!before) {
      if (pr.state === "open") {
        events.push(buildEvent(repository, "pr.opened", String(pr.number), { pr }));
        if (pr.requestedReviewers.length > 0) {
          events.push(buildEvent(repository, "pr.review_requested", `${pr.number}:${pr.requestedReviewers.join(",")}`, { pr }));
        }
        if (pr.ci === "success" || pr.ci === "failure") {
          events.push(buildEvent(repository, pr.ci === "success" ? "ci.success" : "ci.failure", `${pr.number}:${pr.sha}:${pr.ci}`, { pr }));
        }
      } else if (pr.state === "merged") {
        events.push(buildEvent(repository, "pr.merged", String(pr.number), { pr }));
      } else {
        events.push(buildEvent(repository, "pr.closed", String(pr.number), { pr }));
      }
      continue;
    }

    if (before.sha !== pr.sha && pr.state === "open") {
      events.push(buildEvent(repository, "pr.synchronised", `${pr.number}:${pr.sha}`, { pr }));
    }

    const newReviewers = pr.requestedReviewers.filter((name) => !before.requestedReviewers.includes(name));
    if (newReviewers.length > 0) {
      events.push(buildEvent(repository, "pr.review_requested", `${pr.number}:${newReviewers.join(",")}`, { pr }));
    }

    const seenReviewIds = new Set(before.reviews.map((review) => review.id));
    for (const review of pr.reviews) {
      if (seenReviewIds.has(review.id)) continue;
      const kind = reviewState(review.state);
      if (kind === "APPROVED") {
        events.push(buildEvent(repository, "pr.approved", `${pr.number}:review:${review.id}`, { pr, actor: review.author || pr.actor }));
      } else if (kind === "CHANGES_REQUESTED") {
        events.push(buildEvent(repository, "pr.changes_requested", `${pr.number}:review:${review.id}`, { pr, actor: review.author || pr.actor }));
      }
    }

    if (pr.ci && pr.ci !== before.ci && (pr.ci === "success" || pr.ci === "failure")) {
      events.push(buildEvent(repository, pr.ci === "success" ? "ci.success" : "ci.failure", `${pr.number}:${pr.sha}:${pr.ci}`, { pr }));
    }

    if (before.state === "open" && pr.state === "merged") {
      events.push(buildEvent(repository, "pr.merged", String(pr.number), { pr }));
    } else if (before.state === "open" && pr.state === "closed") {
      events.push(buildEvent(repository, "pr.closed", String(pr.number), { pr }));
    }
  }

  return events;
}

/** `gh pr list --json` fields the poller reads. */
export const POLL_JSON_FIELDS = [
  "number",
  "title",
  "state",
  "isDraft",
  "author",
  "baseRefName",
  "headRefName",
  "headRefOid",
  "labels",
  "reviewRequests",
  "latestReviews",
  "reviews",
  "statusCheckRollup",
  "updatedAt",
  "mergedAt",
  "headRepository",
  "headRepositoryOwner",
  "isCrossRepository",
] as const;

export function parseGithubPullList(output: string): unknown[] {
  const parsed: unknown = JSON.parse(output);
  if (!Array.isArray(parsed)) throw new Error("gh pr list did not return a JSON array");
  return parsed;
}

export function parseGithubBranchRef(output: string): string | null {
  try {
    const parsed: unknown = JSON.parse(output);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const sha = (parsed as { object?: { sha?: unknown } }).object?.sha;
    return typeof sha === "string" && sha.length > 0 ? sha : null;
  } catch {
    return null;
  }
}

/** Newest observation wins when the same PR appears in both the open and closed pages. */
export function mergePullRequests(groups: unknown[][]): unknown[] {
  const byNumber = new Map<number, unknown>();
  for (const group of groups) {
    for (const pull of group) {
      if (!pull || typeof pull !== "object" || Array.isArray(pull)) continue;
      const number = (pull as { number?: unknown }).number;
      if (typeof number === "number") byNumber.set(number, pull);
    }
  }
  return [...byNumber.values()];
}
