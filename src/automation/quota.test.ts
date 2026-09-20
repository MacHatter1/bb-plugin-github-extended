import { describe, expect, it } from "vitest";
import {
  githubGraphqlRateLimitArgs,
  githubRestRateLimitArgs,
  parseGithubGraphqlQuota,
  parseGithubRestQuota,
  quotaFraction,
  quotaTone,
} from "./quota";

describe("gh quota", () => {
  it("builds gh api argument vectors without a shell", () => {
    const graphql = githubGraphqlRateLimitArgs();
    expect(graphql.slice(0, 2)).toEqual(["api", "graphql"]);
    expect(graphql).toContain("-f");
    expect(graphql.some((arg) => arg.startsWith("query=") && arg.includes("rateLimit"))).toBe(true);
    expect(githubRestRateLimitArgs()).toEqual(["api", "rate_limit"]);
  });

  it("parses gh GraphQL and REST rate-limit payloads", () => {
    const graphql = parseGithubGraphqlQuota(JSON.stringify({
      data: {
        rateLimit: { limit: 5000, remaining: 4307, used: 693, resetAt: "2026-09-09T12:18:36Z", cost: 1 },
        viewer: { login: "octocat" },
      },
    }));
    expect(graphql).toEqual({
      login: "octocat",
      graphql: { limit: 5000, remaining: 4307, used: 693, resetAt: "2026-09-09T12:18:36Z", cost: 1 },
    });
    expect(quotaTone(graphql.graphql)).toBe("success");
    expect(quotaTone({ limit: 5000, remaining: 1000 })).toBe("warning");
    expect(quotaTone({ limit: 5000, remaining: 200 })).toBe("danger");
    expect(quotaTone(null)).toBe("default");
    expect(quotaFraction({ limit: 0, remaining: 5 })).toBe(0);
    const rest = parseGithubRestQuota(JSON.stringify({
      resources: { core: { limit: 5000, remaining: 4992, used: 8, reset: 1788957722 } },
    }));
    expect(rest).toMatchObject({ limit: 5000, remaining: 4992, used: 8 });
    expect(rest?.resetAt).toBe(new Date(1788957722 * 1000).toISOString());
    expect(parseGithubRestQuota("{}")).toBeNull();
    expect(parseGithubGraphqlQuota(JSON.stringify({ data: { viewer: { login: "x" } } }))).toEqual({ login: "x", graphql: null });
  });
});
