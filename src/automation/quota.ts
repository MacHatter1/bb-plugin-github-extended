// GitHub API quota read through gh: the GraphQL points bucket that
// `gh pr list --json` spends and the REST bucket used for ref lookups.
import type { GithubQuotaBucket } from "./domain.js";

export type { GithubQuotaBucket };

export interface GithubGraphqlQuota extends GithubQuotaBucket {
  cost: number;
}

export const GITHUB_RATE_LIMIT_QUERY =
  "query { rateLimit { limit remaining used resetAt cost } viewer { login } }";

/** `gh api graphql -f query=…` — no stdin needed. */
export function githubGraphqlRateLimitArgs(): string[] {
  return ["api", "graphql", "-f", `query=${GITHUB_RATE_LIMIT_QUERY}`];
}

export function githubRestRateLimitArgs(): string[] {
  return ["api", "rate_limit"];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asInt(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : null;
}

function unixToIso(value: unknown): string | null {
  const seconds = asInt(value);
  if (seconds === null || seconds <= 0) return null;
  return new Date(seconds * 1000).toISOString();
}

function bucketFrom(limit: unknown, remaining: unknown, used: unknown, resetAt: string | null): GithubQuotaBucket | null {
  const lim = asInt(limit);
  const rem = asInt(remaining);
  const spent = asInt(used);
  if (lim === null || rem === null || spent === null || !resetAt) return null;
  return { limit: lim, remaining: rem, used: spent, resetAt };
}

export function parseGithubGraphqlQuota(output: string): { login: string | null; graphql: GithubGraphqlQuota | null } {
  const parsed: unknown = JSON.parse(output);
  const root = asRecord(parsed);
  const data = asRecord(root?.data);
  const rate = asRecord(data?.rateLimit);
  const viewer = asRecord(data?.viewer);
  const login = typeof viewer?.login === "string" && viewer.login ? viewer.login : null;
  if (!rate) return { login, graphql: null };
  const resetAt = typeof rate.resetAt === "string" && rate.resetAt ? rate.resetAt : unixToIso(rate.reset);
  const bucket = bucketFrom(rate.limit, rate.remaining, rate.used, resetAt);
  const cost = asInt(rate.cost) ?? 0;
  return { login, graphql: bucket ? { ...bucket, cost } : null };
}

export function parseGithubRestQuota(output: string): GithubQuotaBucket | null {
  const parsed: unknown = JSON.parse(output);
  const core = asRecord(asRecord(asRecord(parsed)?.resources)?.core);
  if (!core) return null;
  return bucketFrom(core.limit, core.remaining, core.used, unixToIso(core.reset));
}

export function quotaFraction(bucket: { remaining: number; limit: number } | null): number {
  if (!bucket || bucket.limit <= 0) return 0;
  return Math.min(1, Math.max(0, bucket.remaining / bucket.limit));
}

export function quotaTone(bucket: { remaining: number; limit: number } | null): "success" | "warning" | "danger" | "default" {
  if (!bucket) return "default";
  const fraction = quotaFraction(bucket);
  if (fraction >= 0.4) return "success";
  if (fraction >= 0.15) return "warning";
  return "danger";
}
