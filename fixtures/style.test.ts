import { TextAttributes } from "@opentui/core";
import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG, MAX_LINES, resolveConfig } from "../src/tui/config.js";
import { railLineStyle, railLines, sidebarTextLines } from "../src/tui/presentation.js";
import { attributeMask, DEFAULT_STYLE, themeColor } from "../src/tui/style.js";

const populatedSource = {
  agent: "orchestrator",
  model: { id: "gpt-5", variant: "high" },
  branch: "main",
  cost: 0.25,
  tokens: { input: 1_200, output: 340, cache: { read: 9_000 } },
};

const baselineRail = [
  "✈ FLIGHT DECK",
  "─────────────────",
  "status    —",
  "agent     orchestrator",
  "model     gpt-5 · high",
  "cost      $0.250",
  "project   —",
  "tokens    1k in · 340 out",
  "cache     88% hit · 9k read",
  "context   —",
  "perms     —",
  "elapsed   —",
  "tps       —",
];

describe("configurable rail styling", () => {
  test("keeps the default style and exact pre-style rail text", () => {
    const { config, issues } = resolveConfig(undefined);
    expect(issues).toEqual([]);
    expect(config.style).toEqual(DEFAULT_STYLE);
    expect(config.style).toEqual(DEFAULT_CONFIG.style);
    expect(sidebarTextLines(config, populatedSource)).toEqual(baselineRail);

    const lines = railLines(config, populatedSource);
    expect(lines.slice(0, 2).map((line) => line.field)).toEqual([undefined, undefined]);
    expect(lines.slice(2).map((line) => line.field)).toEqual([...config.sidebar.rows]);
    expect(lines.map((line) => railLineStyle(config.style, line))).toEqual([
      config.style.lines,
      config.style.lines,
      ...config.sidebar.rows.map(() => config.style.rows.wildcard),
    ]);
  });

  test("applies the wildcard to live rows and leaves fixed lines alone", () => {
    const { config, issues } = resolveConfig({
      style: { rows: { "*": { color: "warning", attributes: ["bold", "underline"] } } },
    });
    expect(issues).toEqual([]);

    const lines = railLines(config, populatedSource);
    expect(railLineStyle(config.style, lines[0]!)).toEqual(DEFAULT_STYLE.lines);
    for (const line of lines.slice(2)) {
      expect(railLineStyle(config.style, line)).toEqual({ color: "warning", attributes: ["bold", "underline"] });
    }
  });

  test("applies per-row overrides while inheriting unspecified wildcard fields", () => {
    const { config, issues } = resolveConfig({
      style: {
        rows: {
          "*": { color: "subdued", attributes: ["dim", "bold"] },
          Cost: { color: "success" },
          status: { attributes: [] },
        },
      },
    });
    expect(issues).toEqual([]);

    const lines = railLines(config, populatedSource);
    const cost = lines.find((line) => line.field === "cost")!;
    const status = lines.find((line) => line.field === "status")!;
    expect(railLineStyle(config.style, cost)).toEqual({ color: "success", attributes: ["dim", "bold"] });
    expect(railLineStyle(config.style, status)).toEqual({ color: "subdued", attributes: [] });
    expect(Object.keys(config.style.rows.overrides)).toContain("cost");
  });

  test("warns and safely ignores invalid colors, attributes, and row names", () => {
    expect(() => {
      const { config, issues } = resolveConfig({
        style: {
          lines: { color: "chartreuse", attributes: ["not-an-attribute", "bold"] },
          rows: {
            "*": { color: "warning", attributes: ["dim", "not-an-attribute"] },
            cost: { color: "ultraviolet", attributes: ["blink", 3] },
            costly: { color: "info" },
          },
        },
      });

      expect(config.style.lines).toEqual({ color: "default", attributes: ["bold"] });
      expect(config.style.rows.wildcard).toEqual({ color: "warning", attributes: ["dim"] });
      expect(config.style.rows.overrides.cost).toEqual({ color: "warning", attributes: ["blink"] });
      expect(config.style.rows.overrides.costly).toBeUndefined();
      expect(issues.join(" ")).toContain("style.lines.color");
      expect(issues.join(" ")).toContain("style.lines.attributes[0]");
      expect(issues.join(" ")).toContain("style.rows.*.attributes[1]");
      expect(issues.join(" ")).toContain("style.rows.cost.color");
      expect(issues.join(" ")).toContain("style.rows.cost.attributes[1]");
      expect(issues.join(" ")).toContain("style.rows.costly");
    }).not.toThrow();
  });

  test("keeps maxLines within its supported bounds and caps the whole rail", () => {
    expect(DEFAULT_CONFIG.sidebar.maxLines).toBe(MAX_LINES);
    expect(MAX_LINES).toBe(24);

    for (const maxLines of [0, -1, MAX_LINES + 1]) {
      const { config, issues } = resolveConfig({ sidebar: { maxLines } });
      expect(config.sidebar.maxLines).toBe(MAX_LINES);
      expect(issues.join(" ")).toContain("sidebar.maxLines");
    }

    const { config, issues } = resolveConfig({
      sidebar: { maxLines: 3, lines: ["one", "two"], rows: ["cost", "branch"] },
    });
    expect(config.sidebar.maxLines).toBe(3);
    expect(issues.join(" ")).toContain("total 4 lines");
    expect(sidebarTextLines(config, populatedSource)).toEqual(["one", "two", "cost      $0.250"]);
  });
});

describe("style role descriptors", () => {
  test("maps roles onto legacy and renamed host theme tokens", () => {
    const legacy = {
      text: {
        default: "legacy-default",
        subdued: "legacy-subdued",
        feedback: {
          warning: { default: "legacy-warning" },
          error: { default: "legacy-error" },
          success: { default: "legacy-success" },
          info: { default: "legacy-info" },
        },
      },
    };
    const renamed = {
      text: {
        base: "new-base",
        muted: "new-muted",
        feedback: {
          warning: { base: "new-warning" },
          error: { base: "new-error" },
          success: { base: "new-success" },
          info: { base: "new-info" },
        },
      },
    };

    expect(themeColor("default", legacy)).toBe("legacy-default");
    expect(themeColor("subdued", legacy)).toBe("legacy-subdued");
    expect(themeColor("warning", legacy)).toBe("legacy-warning");
    expect(themeColor("error", legacy)).toBe("legacy-error");
    expect(themeColor("success", legacy)).toBe("legacy-success");
    expect(themeColor("info", legacy)).toBe("legacy-info");
    expect(themeColor("default", renamed)).toBe("new-base");
    expect(themeColor("subdued", renamed)).toBe("new-muted");
    expect(themeColor("warning", renamed)).toBe("new-warning");
    expect(themeColor("error", renamed)).toBe("new-error");
    expect(themeColor("success", renamed)).toBe("new-success");
    expect(themeColor("info", renamed)).toBe("new-info");
    expect(themeColor("default", {})).toBeUndefined();
  });

  test("maps configured attributes to the renderer's descriptor bits", () => {
    expect(attributeMask([])).toBeUndefined();
    expect(attributeMask(["bold", "italic", "strikethrough"])).toBe(
      TextAttributes.BOLD | TextAttributes.ITALIC | TextAttributes.STRIKETHROUGH,
    );
  });
});
