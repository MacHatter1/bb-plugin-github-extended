import { z } from "zod";

export const pullCheckSchema = z.object({
  name: z.string(),
  status: z.enum(["success", "failure", "pending", "neutral"]),
  url: z.string(),
}).strict();

export const pullRequestSummarySchema = z.object({
  /** Null means the checks have not been fetched; [] means no checks exist. */
  checks: z.array(pullCheckSchema).nullable(),
  reviewDecision: z.string(),
  mergeStateStatus: z.string(),
  headRefName: z.string(),
  baseRefName: z.string(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
}).strict();

export type PullCheck = z.infer<typeof pullCheckSchema>;
export type PullRequestSummary = z.infer<typeof pullRequestSummarySchema>;

const FAILED = new Set(["FAILURE", "ERROR", "TIMED_OUT", "TIMEDOUT", "CANCELLED", "CANCELED", "ACTION_REQUIRED", "STARTUP_FAILURE"]);
const PENDING = new Set(["PENDING", "QUEUED", "IN_PROGRESS", "EXPECTED", "WAITING", "REQUESTED"]);

/** GitHub Actions CheckRun and classic StatusContext share one display shape. */
export function normalisePullChecks(rollup: unknown): PullCheck[] {
  if (!Array.isArray(rollup)) return [];
  return rollup.flatMap((entry: unknown) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const row = entry as Record<string, unknown>;
    const conclusion = String(row.conclusion ?? row.state ?? "").toUpperCase();
    const state = String(row.status ?? row.state ?? "").toUpperCase();
    const status: PullCheck["status"] = FAILED.has(conclusion) ? "failure"
      : conclusion === "SUCCESS" ? "success"
        : PENDING.has(state) || PENDING.has(conclusion) ? "pending" : "neutral";
    return [{ name: String(row.name ?? row.context ?? "check"), status, url: String(row.detailsUrl ?? row.targetUrl ?? "") }];
  });
}

export function pullCheckSummary(checks: PullCheck[] | null | undefined) {
  const total = checks?.length ?? 0;
  const passed = checks?.filter((check) => check.status === "success").length ?? 0;
  const failed = checks?.filter((check) => check.status === "failure").length ?? 0;
  const pending = checks?.filter((check) => check.status === "pending").length ?? 0;
  const status = checks == null ? "unknown" : total === 0 ? "none"
    : failed > 0 ? "failure" : pending > 0 ? "pending" : passed > 0 ? "success" : "neutral";
  const label = status === "unknown" ? "CI unknown" : status === "none" ? "No checks"
    : status === "failure" ? `CI failing (${failed}/${total})`
      : status === "pending" ? `CI running (${pending}/${total})`
        : status === "success" ? `CI passing (${passed}/${total})` : "Checks skipped";
  return { status, label, total, passed, failed, pending };
}
