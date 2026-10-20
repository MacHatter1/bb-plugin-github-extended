import { describe, expect, it } from "vitest";
import { buildSuggestions, matchesQuery, parseQuery, type Item } from "./app-logic";

const draft: Item = {
  repo: "acme/widgets",
  number: 12,
  kind: "pr",
  title: "Draft work",
  state: "DRAFT",
  author: "alex",
  labels: [],
  assignees: [],
  url: "https://github.com/acme/widgets/pull/12",
  body: "",
  updatedAt: "2026-09-19T00:00:00.000Z",
};
const open: Item = { ...draft, number: 11, title: "Ready work", state: "OPEN" };
const merged: Item = { ...draft, number: 10, title: "Done", state: "MERGED" };

describe("draft pull requests in filters", () => {
  it("includes drafts in is:open, like GitHub does", () => {
    const query = parseQuery("is:open");
    expect(matchesQuery(draft, query, null)).toBe(true);
    expect(matchesQuery(open, query, null)).toBe(true);
    expect(matchesQuery(merged, query, null)).toBe(false);
  });

  it("narrows to drafts with is:draft", () => {
    const query = parseQuery("is:draft");
    expect(matchesQuery(draft, query, null)).toBe(true);
    expect(matchesQuery(open, query, null)).toBe(false);
  });

  it("does not offer a draft state for issues", () => {
    expect(buildSuggestions("is:", { users: [], labels: [], repos: [] }, "issue", null).map((entry) => entry.label)).toEqual([
      "open",
      "closed",
    ]);
  });
});
