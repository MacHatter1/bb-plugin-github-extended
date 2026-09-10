import { describe, expect, expectTypeOf, it } from "vitest";
import { defineRpcContract } from "@get-bb/plugin-sdk";
import type { PluginRpcClient, PluginRpcHandlers } from "@get-bb/plugin-sdk";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import {
  dependabotAlertDetailFromRow,
  dependabotAlertFromRow,
  fetchRepoItems,
  githubRpcContract,
  isRepositoryAccessDenied,
  parseDependabotAlerts,
  parseExtraRepos,
  parseGithubPullUrl,
  parseGithubRemote,
  parsePaginatedGhApi,
  validateGithubCliArgs,
} from "./server";

type GithubRpcHandlers = PluginRpcHandlers<typeof githubRpcContract>;

function assertGithubFrontendInference(
  client: PluginRpcClient<typeof githubRpcContract>,
) {
  expectTypeOf(
    client.call("getPull", { repo: "get-bb/bb", number: 694 }),
  ).toEqualTypeOf<
    Promise<{
      pull: {
        repo: string;
        number: number;
        title: string;
        state: string;
        author: string;
        body: string;
        url: string;
        createdAt: string;
        updatedAt: string;
        baseRefName: string;
        headRefName: string;
        additions: number;
        deletions: number;
        changedFiles: number;
        labels: string[];
        assignees: string[];
        reviewDecision: string;
        mergeStateStatus: string;
        reviewRequests: string[];
        checks: Array<{
          name: string;
          status: "success" | "failure" | "pending" | "neutral";
          url: string;
        }>;
        comments: Array<{ author: string; body: string; createdAt: string }>;
        reviews: Array<{
          author: string;
          state: string;
          body: string;
          createdAt: string;
        }>;
        reviewThreads: Array<{
          path: string;
          line: number | null;
          diffHunk: string;
          comments: Array<{
            author: string;
            body: string;
            createdAt: string;
          }>;
        }>;
        files: Array<{
          path: string;
          status: string;
          additions: number;
          deletions: number;
          patch: string | null;
        }>;
      };
    }>
  >();

  // @ts-expect-error issue numbers must be numeric.
  void client.call("getIssue", { repo: "get-bb/bb", number: "694" });
  // @ts-expect-error unknown filter values are rejected by the contract.
  void client.call("listItems", { kind: "discussion" });
}

describe("GitHub RPC contract", () => {
  it("keeps pull requests when a repository has GitHub Issues disabled", async () => {
    const calls: string[][] = [];
    const openPulls = JSON.stringify([
      {
        number: 17,
        title: "Keep syncing pull requests",
        state: "OPEN",
        author: { login: "octocat" },
        labels: [{ name: "bug" }],
        assignees: [],
        url: "https://github.com/acme/widgets/pull/17",
        body: "",
        updatedAt: "2026-08-10T00:00:00Z",
      },
    ]);

    const items = await fetchRepoItems(async (args) => {
      calls.push(args);
      if (args[0] === "issue") {
        throw new Error(
          "gh issue list failed: the 'acme/widgets' repository has disabled Issues",
        );
      }
      return args.includes("open") ? openPulls : "[]";
    }, "acme/widgets");

    expect(calls).toHaveLength(4);
    expect(calls.filter(([kind]) => kind === "pr")).toHaveLength(2);
    expect(items).toEqual([
      expect.objectContaining({
        repo: "acme/widgets",
        number: 17,
        kind: "pr",
        title: "Keep syncing pull requests",
      }),
    ]);
  });


  it("normalizes cached Dependabot alerts and advisory details", () => {
    const row = {
      number: 3,
      state: "open",
      html_url: "https://github.com/acme/widgets/security/dependabot/3",
      created_at: "2026-08-10T00:00:00Z",
      updated_at: "2026-08-11T00:00:00Z",
      dependency: {
        package: { ecosystem: "npm", name: "react" },
        manifest_path: "/package.json",
        scope: "runtime",
        relationship: "direct",
      },
      security_vulnerability: {
        package: { ecosystem: "npm", name: "react" },
        severity: "high",
        vulnerable_version_range: "<18.3.0",
        first_patched_version: { identifier: "18.3.1" },
      },
      security_advisory: {
        ghsa_id: "GHSA-test",
        cve_id: "CVE-2026-0001",
        summary: "Test advisory",
        description: "A test advisory.",
        severity: "high",
        published_at: "2026-08-09T00:00:00Z",
        updated_at: "2026-08-10T00:00:00Z",
        withdrawn_at: null,
        identifiers: [{ value: "CVE-2026-0001", type: "CVE" }],
        references: [{ url: "https://github.com/advisories/GHSA-test" }],
        vulnerabilities: [{
          package: { ecosystem: "npm", name: "react" },
          severity: "high",
          vulnerable_version_range: "<18.3.0",
          first_patched_version: { identifier: "18.3.1" },
        }],
        cvss: { score: 8.2, vector_string: "CVSS:3.1/test" },
        cvss_severities: {
          cvss_v3: { score: 8.2, vector_string: "CVSS:3.1/test" },
          cvss_v4: { score: null, vector_string: null },
        },
        epss: { percentage: 0.4, percentile: 0.7 },
        cwes: [{ cwe_id: "CWE-79", name: "Cross-site scripting" }],
        classification: "unreviewed",
      },
      assignees: [{ login: "octocat" }],
      dismissed_reason: null,
      dismissed_at: null,
      fixed_at: null,
    };
    expect(parseDependabotAlerts(JSON.stringify([row]), "acme/widgets")).toEqual([
      {
        alert: expect.objectContaining({
          repo: "acme/widgets",
          number: 3,
          severity: "high",
          packageName: "react",
          firstPatchedVersion: "18.3.1",
          summary: "Test advisory",
        }),
        raw: JSON.stringify(row),
      },
    ]);
    expect(dependabotAlertFromRow(row, "acme/widgets")).toEqual(
      expect.objectContaining({ packageName: "react", ecosystem: "npm" }),
    );
    expect(dependabotAlertDetailFromRow(row, "acme/widgets")).toEqual(
      expect.objectContaining({
        ghsaId: "GHSA-test",
        cveId: "CVE-2026-0001",
        dependencyManifestPath: "/package.json",
        references: ["https://github.com/advisories/GHSA-test"],
        vulnerabilities: [
          expect.objectContaining({ packageName: "react", firstPatchedVersion: "18.3.1" }),
        ],
        cwes: [{ id: "CWE-79", name: "Cross-site scripting" }],
        assignees: ["octocat"],
      }),
    );
  });

  it("flattens every paginated GitHub API page", () => {
    expect(
      parsePaginatedGhApi(
        JSON.stringify([[{ id: 1 }, { id: 2 }], [{ id: 3 }]]),
      ),
    ).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);

    expect(() => parsePaginatedGhApi(JSON.stringify([{ id: 1 }]))).toThrow(
      "malformed page",
    );
  });

  it("separates usable extraRepos entries from ones it cannot honor", () => {
    expect(parseExtraRepos("get-bb/bb, nonsense")).toEqual({
      repos: ["get-bb/bb"],
      ignored: ["nonsense"],
    });
    expect(parseExtraRepos("SOME-ORG/Repo")).toEqual({
      repos: ["some-org/repo"],
      ignored: [],
    });
    expect(parseExtraRepos("SOME-ORG/*")).toEqual({
      repos: [],
      ignored: ["SOME-ORG/*"],
    });
    expect(parseExtraRepos("../foo foo/.. -R/foo foo/-R")).toEqual({
      repos: [],
      ignored: ["../foo", "foo/..", "-R/foo", "foo/-R"],
    });
    expect(parseExtraRepos("")).toEqual({ repos: [], ignored: [] });
    expect(parseExtraRepos("  ,, \n ")).toEqual({ repos: [], ignored: [] });
    expect(parseExtraRepos(" acme/one\nacme/two , acme/one ")).toEqual({
      repos: ["acme/one", "acme/two"],
      ignored: [],
    });
    expect(parseExtraRepos("bad/repo/shape acme").ignored).toEqual([
      "bad/repo/shape",
      "acme",
    ]);
  });

  it("treats lost repository access as durable, not a retryable blip", () => {
    expect(isRepositoryAccessDenied(new Error("repository access denied"))).toBe(true);
    expect(isRepositoryAccessDenied(new Error("gh: Not Found (HTTP 404)"))).toBe(true);
    expect(
      isRepositoryAccessDenied(
        new Error("GraphQL: Could not resolve to a Repository with the name 'acme/widgets'."),
      ),
    ).toBe(true);
    expect(isRepositoryAccessDenied(new Error("API rate limit exceeded"))).toBe(false);
    expect(
      isRepositoryAccessDenied(
        new Error("gh: Dependabot alerts are disabled for this repository. (HTTP 403)"),
      ),
    ).toBe(false);
    expect(
      isRepositoryAccessDenied(
        new Error("Resource protected by organization SAML enforcement"),
      ),
    ).toBe(false);
    expect(isRepositoryAccessDenied(new Error("error connecting to api.github.com"))).toBe(false);
    expect(isRepositoryAccessDenied(new Error("could not resolve host api.github.com"))).toBe(false);
  });

  it("accepts supported GitHub URLs only for the exact host", () => {
    expect(parseGithubRemote("https://github.com/ACME/Widgets.git/")).toBe("acme/widgets");
    expect(parseGithubRemote("https://github.com/acme/widgets.git/")).toBe("acme/widgets");
    expect(parseGithubRemote("ssh://git@github.com:22/acme/widgets.git/")).toBe("acme/widgets");
    expect(parseGithubRemote("git@github.com:acme/widgets.git/")).toBe("acme/widgets");
    expect(parseGithubRemote("https://github.com.evil/acme/widgets.git")).toBeNull();
    expect(parseGithubRemote("git@github.com.evil:acme/widgets.git")).toBeNull();
    expect(parseGithubRemote("https://github.com/acme/widgets/extra")).toBeNull();
    expect(parseGithubRemote("https://github.com/acme/bad%20repo.git")).toBeNull();

    expect(parseGithubPullUrl("https://github.com/acme/widgets.git/pull/42/")).toEqual({
      repo: "acme/widgets",
      number: 42,
    });
    expect(parseGithubPullUrl("https://github.com.evil/acme/widgets/pull/42")).toBeNull();
    expect(parseGithubPullUrl("https://github.com/acme/widgets/pull/0")).toBeNull();
  });

  it("rejects CLI arguments that would otherwise broaden a repository query", () => {
    expect(validateGithubCliArgs(["issues", "get-bb/bb"])).toBeNull();
    expect(validateGithubCliArgs(["issues", "../foo"])).toContain(
      "expected owner/repo",
    );
    expect(validateGithubCliArgs(["issues", "-R/foo"])).toContain(
      "expected owner/repo",
    );
    expect(validateGithubCliArgs(["issues", "bad/repo/shape"])).toContain(
      "expected owner/repo",
    );
    expect(validateGithubCliArgs(["prs", "get-bb/bb", "extra"])).toContain(
      "Unexpected argument",
    );
    expect(validateGithubCliArgs(["repos", "--json"])).toContain(
      "does not accept arguments",
    );
  });

  it("infers parsed handler inputs and frontend results", () => {
    expectTypeOf<
      Parameters<GithubRpcHandlers["createIssue"]>[0]
    >().toEqualTypeOf<{
      repo: string;
      title: string;
      body?: string;
    }>();
    expectTypeOf(assertGithubFrontendInference).toBeFunction();
  });

  it("rejects invalid method inputs and outputs at runtime", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "github-contract",
    });
    const contract = defineRpcContract({
      startWork: githubRpcContract.startWork,
    });
    bb.rpc.register(contract, {
      startWork() {
        return { threadId: "" };
      },
    });

    await expect(
      harness.callRpc("startWork", {
        repo: "not-a-repository",
        number: 0,
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      harness.callRpc("startWork", { repo: "get-bb/bb", number: 694 }),
    ).rejects.toMatchObject({ code: "invalid_output" });
  });
});

