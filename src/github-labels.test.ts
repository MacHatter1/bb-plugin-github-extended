import { describe, expect, it } from "vitest";
import { encodeGithubLabels, githubLabelStyle, readGithubLabels, storedGithubLabels } from "./github-labels";

describe("GitHub label colours", () => {
  it("preserves names and valid GitHub colours while rejecting invalid colour input", () => {
    expect(readGithubLabels([
      { name: "bug", color: "D73A49" },
      { name: "help wanted", color: "#008672" },
      { name: "plain", color: "red; background: url(https://example.com)" },
      "legacy", null,
    ])).toEqual({ labels: ["bug", "help wanted", "plain", "legacy"], labelColors: { bug: "d73a49", "help wanted": "008672" } });
  });

  it("round-trips coloured labels through the existing cache and reads legacy rows", () => {
    const value = { labels: ["bug", "plain"], labelColors: { bug: "d73a49" } };
    expect(storedGithubLabels(JSON.stringify(encodeGithubLabels(value)))).toEqual(value);
    expect(storedGithubLabels('["bug","plain"]')).toEqual({ labels: ["bug", "plain"] });
    expect(storedGithubLabels("broken")).toEqual({ labels: [] });
    expect(encodeGithubLabels({ labels: ["plain"], labelColors: { bug: "d73a49" } })).toEqual(["plain"]);
  });

  it("uses the exact background colour with readable light or dark text", () => {
    expect(githubLabelStyle("00008b")).toEqual({ backgroundColor: "#00008b", borderColor: "#00008b", color: "#ffffff" });
    expect(githubLabelStyle("FFFFFF")).toEqual({ backgroundColor: "#ffffff", borderColor: "#ffffff", color: "#000000" });
    expect(githubLabelStyle("fef2c0")?.color).toBe("#000000");
    expect(githubLabelStyle("not-a-colour")).toBeUndefined();
    expect(githubLabelStyle(undefined)).toBeUndefined();
  });

  it("gives difficult mid-tone labels at least 7:1 text contrast and retains their GitHub border", () => {
    const luminance = (hex: string) => {
      const values = hex.replace("#", "").match(/../g)!.map((part) => parseInt(part, 16) / 255)
        .map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
      return values[0]! * 0.2126 + values[1]! * 0.7152 + values[2]! * 0.0722;
    };
    for (const color of ["d93f0b", "0e8a16", "168700", "777777", "d73a49", "0366d6"]) {
      const style = githubLabelStyle(color)!;
      const foreground = luminance(style.color);
      const background = luminance(style.backgroundColor);
      expect((Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05), color).toBeGreaterThanOrEqual(7);
      expect(style.borderColor).toBe(`#${color}`);
    }
  });
});
