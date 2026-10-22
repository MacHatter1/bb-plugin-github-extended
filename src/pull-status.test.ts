import { describe, expect, it } from "vitest";
import { normalisePullChecks, pullCheckSummary } from "./pull-status";

describe("pull request check status", () => {
  it("normalises Actions and classic checks, including stopped and approval-required runs", () => {
    const checks = normalisePullChecks([
      { name: "build", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: "https://example.com/build" },
      { context: "legacy", state: "ERROR", targetUrl: "https://example.com/legacy" },
      { name: "queued", status: "QUEUED", conclusion: "" },
      { name: "cancelled", status: "COMPLETED", conclusion: "CANCELLED" },
      { name: "approval", status: "COMPLETED", conclusion: "ACTION_REQUIRED" },
      { name: "skipped", status: "COMPLETED", conclusion: "SKIPPED" },
      { name: "unknown", status: "COMPLETED", conclusion: "SOMETHING_NEW" },
      null,
    ]);
    expect(checks.map((check) => check.status)).toEqual(["success", "failure", "pending", "failure", "failure", "neutral", "neutral"]);
    expect(checks[1]).toMatchObject({ name: "legacy", url: "https://example.com/legacy" });
    expect(pullCheckSummary(checks)).toMatchObject({ status: "failure", total: 7, passed: 1, failed: 3, pending: 1 });
  });

  it("distinguishes unavailable, absent, skipped, running, and passing checks", () => {
    expect(pullCheckSummary(undefined).label).toBe("CI unknown");
    expect(pullCheckSummary(null).status).toBe("unknown");
    expect(pullCheckSummary([]).label).toBe("No checks");
    expect(pullCheckSummary(normalisePullChecks([{ conclusion: "SKIPPED" }])).status).toBe("neutral");
    expect(pullCheckSummary(normalisePullChecks([{ state: "PENDING" }])).label).toBe("CI running (1/1)");
    expect(pullCheckSummary(normalisePullChecks([{ conclusion: "SUCCESS" }, { conclusion: "NEUTRAL" }])).label).toBe("CI passing (1/2)");
  });
});
