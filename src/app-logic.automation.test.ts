import { describe, expect, it } from "vitest";
import { parseSubPath, routeToSubPath } from "./app-logic";

describe("automation routes", () => {
  it("parses automation sub-paths and falls back to the saved automations", () => {
    expect(parseSubPath("automation")).toEqual({ view: "automation", page: "rules" });
    expect(parseSubPath("automation/rules")).toEqual({ view: "automation", page: "rules" });
    expect(parseSubPath("automation/events/")).toEqual({ view: "automation", page: "events" });
    expect(parseSubPath("automation/nonsense")).toEqual({ view: "automation", page: "rules" });
  });

  it("round-trips automation routes", () => {
    for (const page of ["setup", "rules", "create", "events", "audit", "polling"] as const) {
      const route = { view: "automation" as const, page };
      expect(parseSubPath(routeToSubPath(route))).toEqual(route);
    }
    expect(routeToSubPath({ view: "automation", page: "rules" })).toBe("automation");
    expect(routeToSubPath({ view: "automation", page: "audit" })).toBe("automation/audit");
  });
});
