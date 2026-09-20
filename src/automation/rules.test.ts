import { describe, expect, it } from "vitest";
import type { AutomationRule, NormalisedEvent } from "./domain";
import { matchingRules, rulesUsePaths, wildcard } from "./rules";

const event: NormalisedEvent = {
  deliveryId: "d",
  kind: "pr.opened",
  repo: "acme/web",
  actor: "alex",
  base: "main",
  head: "feature/a",
  draft: false,
  labels: ["ready", "frontend"],
  files: ["src/app.ts"],
  prNumber: 4,
  title: "Add app",
  payload: {},
};

const rule = (
  id: string,
  order: number,
  filters: AutomationRule["filters"] = {},
  extra: Partial<AutomationRule> = {},
): AutomationRule => ({
  id,
  name: id,
  enabled: true,
  order,
  events: ["pr.opened"],
  repos: [],
  filters,
  conditionGroups: [],
  actions: ["bb.review"],
  actionParameters: {},
  approvalRequired: true,
  ...extra,
});

describe("ordered rule matching", () => {
  it("matches branch, actor, label, draft and path filters in order", () => {
    const result = matchingRules(
      [
        rule("late", 20),
        rule("first", 10, { base: "ma*", actor: "alex", labels: ["ready"], draft: false, paths: ["src/*"] }),
        rule("miss", 1, { base: "develop" }),
        rule("disabled", 0, {}, { enabled: false }),
        rule("other-event", 2, {}, { events: ["pr.merged"] }),
      ],
      event,
    );
    expect(result.map((item) => item.id)).toEqual(["first", "late"]);
  });

  it("scopes rules to repositories case-insensitively", () => {
    expect(matchingRules([rule("scoped", 10, {}, { repos: ["ACME/web", "acme/api"] })], event)).toHaveLength(1);
    expect(matchingRules([rule("scoped", 10, {}, { repos: ["acme/api"] })], event)).toHaveLength(0);
  });

  it("supports AND/OR condition groups", () => {
    const selected: AutomationRule = {
      ...rule("selected", 10),
      conditionGroups: [
        {
          id: "branches",
          combinator: "and",
          conditions: [
            { id: "base", field: "base", operator: "equals", value: "main" },
            { id: "head", field: "head", operator: "matches", value: "feature/*" },
          ],
        },
        {
          id: "signals",
          combinator: "or",
          conditions: [
            { id: "label", field: "label", operator: "equals", value: "frontend" },
            { id: "actor", field: "actor", operator: "equals", value: "maintainer" },
          ],
        },
        {
          id: "draft-path",
          combinator: "and",
          conditions: [
            { id: "draft", field: "draft", operator: "equals", value: "false" },
            { id: "path", field: "path", operator: "matches", value: "src/*" },
            { id: "repo", field: "repository", operator: "contains", value: "acme" },
            { id: "event", field: "event", operator: "not_equals", value: "pr.closed" },
          ],
        },
      ],
    };
    expect(matchingRules([selected], event)).toHaveLength(1);
    expect(
      matchingRules(
        [{
          ...selected,
          conditionGroups: [{
            id: "miss",
            combinator: "and",
            conditions: [{ id: "label", field: "label", operator: "equals", value: "backend" }],
          }],
        }],
        event,
      ),
    ).toHaveLength(0);
  });

  it("reports when the changed-file list is needed", () => {
    expect(rulesUsePaths([rule("plain", 1)])).toBe(false);
    expect(rulesUsePaths([rule("paths", 1, { paths: ["docs/*"] })])).toBe(true);
    expect(rulesUsePaths([rule("paths-off", 1, { paths: ["docs/*"] }, { enabled: false })])).toBe(false);
    expect(
      rulesUsePaths([
        rule("cond", 1, {}, {
          conditionGroups: [{
            id: "g",
            combinator: "or",
            conditions: [{ id: "p", field: "path", operator: "matches", value: "*.md" }],
          }],
        }),
      ]),
    ).toBe(true);
  });

  it("treats wildcard patterns literally apart from the star", () => {
    expect(wildcard("release/*", "release/1.2")).toBe(true);
    expect(wildcard("release/*", "hotfix/1.2")).toBe(false);
    expect(wildcard("a.b", "aXb")).toBe(false);
    expect(wildcard("MAIN", "main")).toBe(true);
  });
});
