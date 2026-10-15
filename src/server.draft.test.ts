import { describe, expect, it } from "vitest";
import { fetchRepoItems } from "./server";

describe("draft pull requests in the sync", () => {
  it("asks gh for isDraft on pull requests only and caches open drafts as DRAFT", async () => {
    const calls: string[][] = [];
    const pulls = JSON.stringify([
      { number: 12, title: "Draft work", state: "OPEN", isDraft: true, author: { login: "alex" }, labels: [], assignees: [], url: "", body: "", updatedAt: "" },
      { number: 11, title: "Ready work", state: "OPEN", isDraft: false, author: { login: "alex" }, labels: [], assignees: [], url: "", body: "", updatedAt: "" },
      { number: 10, title: "Closed draft", state: "CLOSED", isDraft: true, author: { login: "alex" }, labels: [], assignees: [], url: "", body: "", updatedAt: "" },
    ]);
    const items = await fetchRepoItems(async (args) => {
      calls.push(args);
      return args[0] === "pr" && args.includes("open") ? pulls : "[]";
    }, "acme/widgets");

    for (const args of calls) {
      const fields = args[args.indexOf("--json") + 1] ?? "";
      expect(fields.includes("isDraft")).toBe(args[0] === "pr");
    }
    expect(items.map((item) => [item.number, item.state])).toEqual([
      [12, "DRAFT"],
      [11, "OPEN"],
      [10, "CLOSED"],
    ]);
  });
});
