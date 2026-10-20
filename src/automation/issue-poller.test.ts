import { describe, expect, it } from "vitest";
import { diffIssueObservation, issueObservationFromPoll, parseIssueSnapshot } from "./issue-poller";

const issue = {
  number: 8, title: "Fix a bug", body: "Steps to reproduce", state: "OPEN",
  author: { login: "alex" }, labels: [{ name: "bug" }], assignees: [],
  createdAt: "2026-10-20T12:00:01Z", updatedAt: "2026-10-20T12:00:01Z", closedAt: null,
};
const observe = (issues: unknown[], at = "2026-10-20T12:01:00Z") => issueObservationFromPoll([JSON.stringify(issues)], at);

describe("issue polling", () => {
  it("baselines existing issues and round-trips its independent cursor without storing descriptions", () => {
    const current = observe([issue]);
    expect(diffIssueObservation(null, current, "acme/web")).toEqual([]);
    expect(parseIssueSnapshot(JSON.stringify(current))).toEqual(current);
    expect(JSON.stringify(current)).not.toContain(issue.body);
    expect(parseIssueSnapshot('{"prs":{}}')).toBeNull();
  });

  it("detects a new issue and gives it issue identity and labels, keeping PR identity absent", () => {
    const previous = observe([], "2026-10-20T12:00:00.500Z");
    const current = observe([issue]);
    const events = diffIssueObservation(previous, current, "acme/web");
    expect(events).toEqual([expect.objectContaining({ kind: "issue.opened", repo: "acme/web", issueNumber: 8, actor: "alex", labels: ["bug"] })]);
    expect(events[0]?.prNumber).toBeUndefined();
    expect(diffIssueObservation(previous, current, "acme/web")).toEqual(events);
    expect(diffIssueObservation(current, current, "acme/web")).toEqual([]);
  });

  it.each([
    [{ title: "New title" }, "issue.edited"],
    [{ body: "Changed description" }, "issue.edited"],
    [{ state: "CLOSED", closedAt: "2026-10-20T12:02:00Z" }, "issue.closed"],
    [{ labels: [{ name: "bug" }, { name: "ready" }] }, "issue.labeled"],
    [{ labels: [] }, "issue.unlabeled"],
    [{ assignees: [{ login: "pat" }] }, "issue.assigned"],
  ])("detects %s as %s", (patch, kind) => {
    expect(diffIssueObservation(observe([issue]), observe([{ ...issue, ...patch, updatedAt: "2026-10-20T12:02:00Z" }]), "acme/web").map((event) => event.kind)).toEqual([kind]);
  });

  it("detects reopening and unassignment and distinguishes repeated close/reopen cycles", () => {
    const closed = observe([{ ...issue, state: "CLOSED", closedAt: "2026-10-20T12:02:00Z", updatedAt: "2026-10-20T12:02:00Z", assignees: [{ login: "pat" }] }]);
    const reopened = observe([{ ...issue, updatedAt: "2026-10-20T12:03:00Z" }]);
    expect(diffIssueObservation(closed, reopened, "acme/web").map((event) => event.kind)).toEqual(["issue.reopened", "issue.unassigned"]);
    const closedAgain = observe([{ ...issue, state: "CLOSED", closedAt: "2026-10-20T12:04:00Z", updatedAt: "2026-10-20T12:04:00Z" }]);
    expect(diffIssueObservation(reopened, closedAgain, "acme/web")[0]?.deliveryId)
      .not.toBe(diffIssueObservation(observe([issue]), closed, "acme/web")[0]?.deliveryId);
  });

  it("ignores reordered labels and timestamp-only changes such as new comments", () => {
    const before = observe([{ ...issue, labels: [{ name: "bug" }, { name: "ready" }] }]);
    const after = observe([{ ...issue, labels: [{ name: "ready" }, { name: "bug" }], updatedAt: "2026-10-20T12:02:00Z" }]);
    expect(diffIssueObservation(before, after, "acme/web")).toEqual([]);
  });

  it("does not treat older issues entering the bounded poll window as newly opened", () => {
    expect(diffIssueObservation(observe([]), observe([issue]), "acme/web")).toEqual([]);
    expect(diffIssueObservation(observe([]), observe([{ ...issue, state: "CLOSED", closedAt: "2026-10-20T12:02:00Z" }]), "acme/web").map((event) => event.kind)).toEqual(["issue.closed"]);
  });

  it("keeps the newest observation across open and closed pages and rejects malformed responses", () => {
    const current = issueObservationFromPoll([
      JSON.stringify([{ ...issue, state: "CLOSED", updatedAt: "2026-10-20T12:02:00Z" }]), JSON.stringify([issue]),
    ], "2026-10-20T12:03:00Z");
    expect(current.issues["8"]?.state).toBe("CLOSED");
    expect(() => issueObservationFromPoll(['{}'], "2026-10-20T12:03:00Z")).toThrow();
  });
});
