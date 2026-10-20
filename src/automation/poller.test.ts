import { describe, expect, it } from "vitest";
import {
  clampPollIntervalSeconds,
  clampQuotaPauseRemaining,
  diffRepoObservation,
  formatPollInterval,
  mergePullRequests,
  nextPollAt,
  observationFromPoll,
  parseGhPull,
  parseGithubBranchRef,
  parseGithubPullList,
  parseSnapshot,
  pollDeliveryId,
  shouldPauseForQuota,
  summariseCi,
  type PollPrObservation,
  type RepoPollSnapshot,
} from "./poller";

const repository = { repo: "acme/web", baseBranch: "main" };

function pr(overrides: Partial<PollPrObservation> = {}): PollPrObservation {
  return {
    number: 7,
    title: "Feature",
    sha: "abc",
    state: "open",
    draft: false,
    actor: "alex",
    base: "main",
    head: "feature",
    labels: [],
    requestedReviewers: [],
    reviews: [],
    ci: null,
    headRepo: { name: "web", owner: "alex", fork: true },
    ...overrides,
  };
}

function snapshot(prs: PollPrObservation[], baseSha: string | null = "basesha"): RepoPollSnapshot {
  return {
    baseSha,
    prs: Object.fromEntries(prs.map((item) => [String(item.number), {
      number: item.number,
      title: item.title,
      sha: item.sha,
      state: item.state,
      draft: item.draft,
      actor: item.actor,
      base: item.base,
      head: item.head,
      labels: item.labels,
      requestedReviewers: item.requestedReviewers,
      reviews: item.reviews,
      ci: item.ci,
    }])),
  };
}

function kinds(previous: RepoPollSnapshot | null, current: PollPrObservation[], baseSha = "basesha") {
  return diffRepoObservation(previous, { snapshot: snapshot(current, baseSha), prs: current }, repository).map((event) => event.kind);
}

describe("poll interval helpers", () => {
  it("clamps and formats the user-configured timer", () => {
    expect(clampPollIntervalSeconds(1)).toBe(60);
    expect(clampPollIntervalSeconds(99999)).toBe(3600);
    expect(clampPollIntervalSeconds("60")).toBe(60);
    expect(clampPollIntervalSeconds("nope")).toBe(300);
    expect(formatPollInterval(60)).toBe("1m");
    expect(formatPollInterval(300)).toBe("5m");
    expect(formatPollInterval(3600)).toBe("1h");
    expect(clampQuotaPauseRemaining(-1)).toBe(0);
    expect(clampQuotaPauseRemaining(100)).toBe(100);
    expect(clampQuotaPauseRemaining(9_999)).toBe(5_000);
    expect(shouldPauseForQuota(80, 100)).toBe(true);
    expect(shouldPauseForQuota(100, 100)).toBe(true);
    expect(shouldPauseForQuota(101, 100)).toBe(false);
    expect(shouldPauseForQuota(0, 0)).toBe(false);
    expect(shouldPauseForQuota(null, 100)).toBe(false);
  });

  it("computes the next poll instant from the last successful run", () => {
    expect(nextPollAt({ enabled: false, inProgress: false, lastFinishedAt: null, intervalSeconds: 60 })).toBeNull();
    expect(nextPollAt({ enabled: true, inProgress: true, lastFinishedAt: "2026-01-01T00:00:00.000Z", intervalSeconds: 60 })).toBeNull();
    expect(nextPollAt({
      enabled: true,
      inProgress: false,
      lastFinishedAt: "2026-01-01T00:00:00.000Z",
      intervalSeconds: 60,
      nowMs: Date.parse("2026-01-01T00:00:10.000Z"),
    })).toBe("2026-01-01T00:01:00.000Z");
    expect(nextPollAt({
      enabled: true,
      inProgress: false,
      lastFinishedAt: "2026-01-01T00:00:00.000Z",
      intervalSeconds: 60,
      autoPaused: true,
      resumeAt: "2026-01-01T01:00:00.000Z",
    })).toBe("2026-01-01T01:00:00.000Z");
  });
});

describe("gh pull parsing", () => {
  it("reads gh pr list JSON fields used for event diffs", () => {
    const parsed = parseGhPull({
      number: 12,
      title: "Topic",
      state: "OPEN",
      isDraft: true,
      author: { login: "sam" },
      baseRefName: "main",
      headRefName: "topic",
      headRefOid: "def",
      labels: [{ name: "bug" }],
      reviewRequests: [{ login: "pat" }, { slug: "js" }],
      reviews: [{ id: "PRR_1", author: { login: "pat" }, state: "APPROVED" }],
      statusCheckRollup: [{ conclusion: "SUCCESS", status: "COMPLETED" }],
      headRepository: { name: "web" },
      headRepositoryOwner: { login: "sam" },
      isCrossRepository: true,
    });
    expect(parsed).toMatchObject({
      number: 12,
      title: "Topic",
      sha: "def",
      state: "open",
      draft: true,
      actor: "sam",
      requestedReviewers: ["js", "pat"],
      ci: "success",
      headRepo: { name: "web", owner: "sam", fork: true },
    });
  });

  it("treats mergedAt as merged even when state is closed", () => {
    expect(parseGhPull({ number: 1, state: "CLOSED", mergedAt: "2026-01-01T00:00:00Z", headRefOid: "a" })?.state).toBe("merged");
  });

  it("summarises check rollups without inventing CI when none exist", () => {
    expect(summariseCi([])).toBeNull();
    expect(summariseCi([{ status: "IN_PROGRESS" }])).toBe("pending");
    expect(summariseCi([{ conclusion: "FAILURE", status: "COMPLETED" }])).toBe("failure");
    expect(summariseCi([{ conclusion: "SUCCESS", status: "COMPLETED" }])).toBe("success");
  });

  it("builds an observation from a poll payload", () => {
    const observation = observationFromPoll({
      baseSha: "main1",
      pullRequests: [{ number: 3, state: "OPEN", headRefOid: "sha3", author: { login: "a" } }, { number: "skip" }],
    });
    expect(observation.prs).toHaveLength(1);
    expect(observation.snapshot.baseSha).toBe("main1");
    expect(observation.snapshot.prs["3"]?.sha).toBe("sha3");
  });

  it("parses gh list and ref output defensively", () => {
    expect(parseGithubPullList("[]")).toEqual([]);
    expect(() => parseGithubPullList("{}")).toThrow(/JSON array/);
    expect(parseGithubBranchRef(JSON.stringify({ object: { sha: "abc123" } }))).toBe("abc123");
    expect(parseGithubBranchRef("not-json")).toBeNull();
    expect(mergePullRequests([[{ number: 1, sha: "old" }], [{ number: 1, sha: "new" }, { number: 2 }, "junk"]])).toEqual([
      { number: 1, sha: "new" },
      { number: 2 },
    ]);
  });
});

describe("snapshot diffs", () => {
  it("emits nothing on the first (baseline) poll", () => {
    expect(kinds(null, [pr()])).toEqual([]);
  });

  it("emits opened, review requested, and terminal CI for a new open PR", () => {
    expect(kinds(snapshot([]), [pr({ requestedReviewers: ["pat"], ci: "success" })])).toEqual([
      "pr.opened",
      "pr.review_requested",
      "ci.success",
    ]);
  });

  it("emits only the terminal event for a PR first seen already merged", () => {
    expect(kinds(snapshot([]), [pr({ state: "merged" })])).toEqual(["pr.merged"]);
  });

  it("detects synchronise, reviews, CI, and merge transitions", () => {
    const before = pr({ sha: "old", requestedReviewers: [], reviews: [], ci: "pending" });
    const after = pr({
      sha: "new",
      requestedReviewers: ["pat"],
      reviews: [{ id: "r1", author: "pat", state: "APPROVED" }],
      ci: "success",
      state: "merged",
    });
    expect(kinds(snapshot([before]), [after])).toEqual([
      "pr.review_requested",
      "pr.approved",
      "ci.success",
      "pr.merged",
    ]);
  });

  it("does not re-emit an already seen approval", () => {
    const before = pr({ reviews: [{ id: "r1", author: "pat", state: "APPROVED" }] });
    expect(kinds(snapshot([before]), [before])).toEqual([]);
  });

  it("emits push.base with the configured base branch when its SHA changes", () => {
    const events = diffRepoObservation(
      snapshot([], "aaa"),
      { snapshot: snapshot([], "bbb"), prs: [] },
      { repo: "acme/web", baseBranch: "develop" },
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "push.base",
      repo: "acme/web",
      base: "develop",
      sha: "bbb",
      deliveryId: pollDeliveryId("acme/web", "push.base", "bbb"),
    });
    expect(events[0]?.payload).toMatchObject({ ref: "refs/heads/develop", after: "bbb" });
  });

  it("carries the PR title and repository into events", () => {
    const events = diffRepoObservation(snapshot([]), { snapshot: snapshot([pr()]), prs: [pr()] }, repository);
    expect(events[0]).toMatchObject({ kind: "pr.opened", repo: "acme/web", prNumber: 7, title: "Feature" });
  });

  it("round-trips snapshots used as the durable cursor", () => {
    const current = snapshot([pr({ reviews: [{ id: "r1", author: "pat", state: "CHANGES_REQUESTED" }] })]);
    expect(parseSnapshot(JSON.stringify(current))).toEqual(current);
    expect(parseSnapshot("not-json")).toBeNull();
  });
});
