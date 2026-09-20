import { describe, expect, it } from "vitest";
import { parseSubPath, routeToSubPath } from "./app-logic";

describe("automation routes", () => {
  it("parses automation sub-paths and falls back to setup", () => {
    expect(parseSubPath("automation")).toEqual({ view: "automation", page: "setup" });
    expect(parseSubPath("automation/rules")).toEqual({ view: "automation", page: "rules" });
    expect(parseSubPath("automation/events/")).toEqual({ view: "automation", page: "events" });
    expect(parseSubPath("automation/nonsense")).toEqual({ view: "automation", page: "setup" });
  });

  it("round-trips automation routes", () => {
    for (const page of ["setup", "rules", "events", "audit", "polling"] as const) {
      const route = { view: "automation" as const, page };
      expect(parseSubPath(routeToSubPath(route))).toEqual(route);
    }
    expect(routeToSubPath({ view: "automation", page: "setup" })).toBe("automation");
    expect(routeToSubPath({ view: "automation", page: "audit" })).toBe("automation/audit");
  });
});
