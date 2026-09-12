import { describe, expect, test } from "bun:test";
import {
  DEFAULT_CONFIG,
  DEFAULT_FOOTER_TEXT,
  DEFAULT_REFRESH_MS,
  DEFAULT_SIDEBAR_LINES,
  MIN_REFRESH_MS,
  mergeOptions,
  resolveConfig,
} from "../src/tui/config.js";
import { footerLine, sidebarLines } from "../src/tui/presentation.js";

describe("flight deck config", () => {
  test("uses the sane defaults when no options are supplied", () => {
    const resolution = resolveConfig(undefined);
    expect(resolution.issues).toEqual([]);
    expect(resolution.config).toEqual(DEFAULT_CONFIG);
    // Literal defaults, so a silent edit to the constants is still caught.
    // With no session data, every selected row renders its placeholder.
    expect(resolution.config.sidebar.persist).toBe(true);
    expect(resolution.config.sidebar.placeholder).toBe("—");
    expect(sidebarLines(resolution.config)).toHaveLength(
      DEFAULT_SIDEBAR_LINES.length + resolution.config.sidebar.rows.length,
    );
    expect(sidebarLines(resolution.config)).toContain("cache     —");
    // And omission is still one flag away.
    const omitted = {
      ...resolution.config,
      sidebar: { ...resolution.config.sidebar, persist: false },
    };
    expect(sidebarLines(omitted)).toEqual(["✈ FLIGHT DECK", "─────────────────"]);
    expect(resolution.config.sidebar.rows).toEqual([
      "caution",
      "status",
      "agent",
      "model",
      "branch",
      "cost",
      "project",
      "tokens",
      "cache",
      "context",
      "perms",
      "elapsed",
      "tps",
    ]);
    // The ticker is on by default: clock-derived rows have nothing else to
    // react to. It runs at the spinner's frame rate so the glyph reads as
    // motion, not as a stuck character. `refresh: 0` opts out.
    expect(resolution.config.refresh).toBe(DEFAULT_REFRESH_MS);
    expect(DEFAULT_REFRESH_MS).toBe(100);
    expect(DEFAULT_SIDEBAR_LINES[0]).toBe("✈ FLIGHT DECK");
    // The prompt footer is off unless configured: the sidebar already has it.
    expect(footerLine(resolution.config)).toBeUndefined();
    expect(DEFAULT_CONFIG.footer.enabled).toBe(false);
    expect(DEFAULT_FOOTER_TEXT).toBe("Flight Deck");
  });

  test("turns the footer on as soon as any footer setting is written", () => {
    const resolution = resolveConfig({ footer: { text: "hello" } });
    expect(resolution.issues).toEqual([]);
    expect(resolution.config.footer.enabled).toBe(true);
    expect(footerLine(resolution.config)).toBe("hello");

    // An explicit false still wins over the implied opt-in.
    expect(resolveConfig({ footer: { enabled: false, text: "hello" } }).config.footer.enabled).toBe(false);
  });

  test("applies user overrides and trims whitespace", () => {
    const resolution = resolveConfig({
      sidebar: { enabled: true, lines: ["  MY RAIL  ", "second"], persist: false },
      footer: { text: " custom footer " },
    });
    expect(resolution.issues).toEqual([]);
    expect(sidebarLines(resolution.config)).toEqual(["MY RAIL", "second"]);
    expect(footerLine(resolution.config)).toBe("custom footer");
  });

  test("hides rails that are disabled", () => {
    const resolution = resolveConfig({ sidebar: { enabled: false }, footer: { enabled: false } });
    expect(resolution.issues).toEqual([]);
    expect(sidebarLines(resolution.config)).toEqual([]);
    expect(footerLine(resolution.config)).toBeUndefined();
  });

  test("falls back and reports every malformed value", () => {
    const resolution = resolveConfig({
      sidebar: { enabled: "yes", lines: [123, "  ", "ok"], persist: false },
      footer: { enabled: "yes", text: "" },
    });
    expect(sidebarLines(resolution.config)).toEqual(["ok"]);
    expect(footerLine(resolution.config)).toBe(DEFAULT_FOOTER_TEXT);
    expect(resolution.issues).toHaveLength(5);
    expect(resolution.issues.join(" ")).toContain("sidebar.enabled");
    expect(resolution.issues.join(" ")).toContain("footer.enabled");
    expect(resolution.issues.join(" ")).toContain("sidebar.lines[0]");
    expect(resolution.issues.join(" ")).toContain("sidebar.lines[1]");
  });

  test("falls back to the default lines when every entry is unusable", () => {
    const resolution = resolveConfig({ sidebar: { lines: [42, "   ", null], persist: false } });
    expect(sidebarLines(resolution.config)).toEqual(["✈ FLIGHT DECK", "─────────────────"]);
    expect(resolution.issues.join(" ")).toContain("no usable entries");
  });

  test("accepts a custom row selection and reports unknown field names", () => {
    const custom = resolveConfig({ sidebar: { rows: ["cost", "branch"] } });
    expect(custom.issues).toEqual([]);
    expect(custom.config.sidebar.rows).toEqual(["cost", "branch"]);

    const bad = resolveConfig({ sidebar: { rows: ["cost", "nope"] } });
    expect(bad.config.sidebar.rows).toEqual(["cost"]);
    expect(bad.issues.join(" ")).toContain("sidebar.rows[1]");
    expect(bad.issues.join(" ")).toContain("not a known field");
  });

  test("falls back to the default rows when none are usable", () => {
    const resolution = resolveConfig({ sidebar: { rows: [1, "  ", "nope"] } });
    expect(resolution.config.sidebar.rows).toEqual(DEFAULT_CONFIG.sidebar.rows);
    expect(resolution.issues.join(" ")).toContain("no usable entries");
  });

  test("normalizes control characters in row names before matching", () => {
    // A trailing newline is the `cache` row, not an unknown field — and the
    // normalization is reported, like every other config string.
    const trailing = resolveConfig({ sidebar: { rows: ["cache\n", "cost"] } });
    expect(trailing.config.sidebar.rows).toEqual(["cache", "cost"]);
    expect(trailing.issues.join(" ")).toContain("sidebar.rows[0]");
    expect(trailing.issues.join(" ")).toContain("control characters");

    // An entry that is still unknown after normalization stays dropped.
    const ansi = resolveConfig({ sidebar: { rows: ["ca\u001bche"] } });
    expect(ansi.config.sidebar.rows).toEqual(DEFAULT_CONFIG.sidebar.rows);
    expect(ansi.issues.join(" ")).toContain("control characters");
    expect(ansi.issues.join(" ")).toContain("not a known field");

    // Valid entries still resolve cleanly.
    const clean = resolveConfig({ sidebar: { rows: ["  COST ", "Branch"] } });
    expect(clean.issues).toEqual([]);
    expect(clean.config.sidebar.rows).toEqual(["cost", "branch"]);
  });

  test("flattens control characters so a rail can never become two lines", () => {
    const resolution = resolveConfig({
      sidebar: { lines: ["A\nB", "C\td"], persist: false },
      footer: { text: "x\u001b[31my" },
    });
    expect(sidebarLines(resolution.config)).toEqual(["A B", "C d"]);
    expect(footerLine(resolution.config)).toBe("x [31my");
    expect(resolution.issues.join(" ")).toContain("control characters");
    for (const line of sidebarLines(resolution.config)) {
      expect(line).not.toMatch(/[\u0000-\u001F\u007F-\u009F]/);
    }
  });

  test("reports truncation instead of silently shortening", () => {
    const resolution = resolveConfig({ sidebar: { lines: ["y".repeat(400)] }, footer: { text: "z".repeat(400) } });
    expect(sidebarLines(resolution.config)[0]).toHaveLength(120);
    expect(footerLine(resolution.config)).toHaveLength(120);
    expect(resolution.issues.join(" ")).toContain("longer than 120 characters");
  });

  test("survives a non-object options payload and ignores unknown keys", () => {
    expect(resolveConfig("nope").issues).toHaveLength(1);
    expect(resolveConfig(42).config).toEqual(DEFAULT_CONFIG);
    const unknown = resolveConfig({ future: true, sidebar: { colour: "red" } });
    expect(unknown.issues).toEqual([]);
    expect(unknown.config).toEqual(DEFAULT_CONFIG);
  });

  test("caps runaway line counts and very long lines after trimming", () => {
    const many = resolveConfig({ sidebar: { lines: Array.from({ length: 40 }, (_, index) => `line ${index}`) } });
    expect(sidebarLines(many.config)).toHaveLength(24);
    expect(many.issues.join(" ")).toContain("keeping the first 24");

    const long = resolveConfig({ sidebar: { lines: ["x".repeat(400)] } });
    expect(sidebarLines(long.config)[0]).toHaveLength(120);

    // Trimming happens before capping, so padding must not eat visible width.
    const padded = resolveConfig({ sidebar: { lines: [" ".repeat(50) + "y".repeat(400)] } });
    expect(sidebarLines(padded.config)[0]).toBe("y".repeat(120));

    const paddedFooter = resolveConfig({ footer: { text: " ".repeat(50) + "z".repeat(400) } });
    expect(footerLine(paddedFooter.config)).toBe("z".repeat(120));
  });
});

describe("flight deck option precedence", () => {
  test("uses file options when the host sends none", () => {
    const merged = mergeOptions({ footer: { text: "from file" } }, undefined);
    expect(footerLine(resolveConfig(merged).config)).toBe("from file");
  });

  test("lets host options win key by key without dropping file siblings", () => {
    const merged = mergeOptions(
      { sidebar: { lines: ["file line"], enabled: true }, footer: { text: "file footer" } },
      { sidebar: { enabled: false } },
    );
    const { config, issues } = resolveConfig(merged);
    expect(issues).toEqual([]);
    expect(config.sidebar.enabled).toBe(false);
    expect(config.sidebar.lines).toEqual(["file line"]);
    expect(footerLine(config)).toBe("file footer");
  });

  test("reports a malformed section from either source", () => {
    expect(resolveConfig(mergeOptions({ sidebar: "nope" }, undefined)).issues.join(" ")).toContain("sidebar");
    expect(resolveConfig(mergeOptions(undefined, { footer: 12 })).issues.join(" ")).toContain("footer");
  });

  // Pins the intended direction: a malformed section replaces the other source
  // and resolveConfig reports it, so the problem is loud rather than masked.
  test("lets a malformed host section win loudly over a valid file section", () => {
    const { config, issues } = resolveConfig(mergeOptions({ footer: { text: "file footer" } }, { footer: 12 }));
    expect(issues.join(" ")).toContain("footer must be an object");
    // The malformed section is discarded entirely, so the rail falls back to
    // its off-by-default state rather than guessing at the file's intent.
    expect(footerLine(config)).toBeUndefined();
  });

  // The mirror case: when the host supplies a valid section, it takes over and
  // the malformed file section is dropped. (With no host section present, the
  // malformed file value is surfaced instead — see the test above.)
  test("lets a valid host section take over a malformed file section", () => {
    const { config, issues } = resolveConfig(
      mergeOptions({ sidebar: "nope" }, { sidebar: { lines: ["host"], persist: false } }),
    );
    expect(issues).toEqual([]);
    expect(sidebarLines(config)).toEqual(["host"]);
  });

  // A tick now wakes the host's renderer, so a sub-frame interval is a way to
  // wedge the TUI from a config file rather than a way to make it smoother.
  test("clamps a sub-frame refresh rate instead of accepting it", () => {
    const { config, issues } = resolveConfig({ refresh: 1 });
    expect(config.refresh).toBe(MIN_REFRESH_MS);
    expect(issues.join(" ")).toContain("faster than");
  });

  // The clamp must not swallow the deliberate "off" value: 0 means no ticker,
  // not "as fast as possible".
  test("still lets refresh be switched off entirely", () => {
    const { config, issues } = resolveConfig({ refresh: 0 });
    expect(config.refresh).toBe(0);
    expect(issues).toEqual([]);
  });

  test("merging two empty sources yields the defaults", () => {
    expect(resolveConfig(mergeOptions(undefined, undefined)).config).toEqual(DEFAULT_CONFIG);
    expect(resolveConfig(mergeOptions({}, {})).config).toEqual(DEFAULT_CONFIG);
  });
});

// Validation branches that nothing exercised. Each one silently corrected a bad
// value, so a regression in any of them would have been invisible — the config
// would simply do something other than what it says.
describe("option validation", () => {
  test("raises a caution threshold that could never be reached", () => {
    const tool = resolveConfig({ caution: { toolWatchSeconds: 300, toolCautionSeconds: 60 } });
    expect(tool.config.caution.toolCautionSeconds).toBe(300);
    expect(tool.issues.join(" ")).toContain("raised to match");

    const turn = resolveConfig({ caution: { turnWatchSeconds: 900, turnCautionSeconds: 60 } });
    expect(turn.config.caution.turnCautionSeconds).toBe(900);
    expect(turn.issues.join(" ")).toContain("raised to match");
  });

  test("rejects a glyph that is empty, too wide, or a control character", () => {
    const { config, issues } = resolveConfig({ glyphs: { watch: "abc", caution: "\u0007", clear: "" } });
    expect(config.glyphs).toEqual(DEFAULT_CONFIG.glyphs);
    expect(issues.join(" ")).toContain("glyphs.watch");
    expect(issues.join(" ")).toContain("glyphs.caution");
    expect(issues.join(" ")).toContain("glyphs.clear");
  });

  test("falls back whole when the exempt list is malformed, but accepts empty", () => {
    const fallback = DEFAULT_CONFIG.caution.exemptTools;
    expect(resolveConfig({ caution: { exemptTools: "read" } }).config.caution.exemptTools).toEqual(fallback);
    expect(resolveConfig({ caution: { exemptTools: ["read", "  "] } }).config.caution.exemptTools).toEqual(fallback);
    // An empty list is a real choice: exempt nothing at all.
    expect(resolveConfig({ caution: { exemptTools: [] } }).config.caution.exemptTools).toEqual([]);
  });

  test("sends an out-of-range layout value back to its default, and says so", () => {
    const small = resolveConfig({ layout: { labelWidth: 5, barWidth: 0, sparkWidth: 1 } });
    expect(small.config.layout).toEqual(DEFAULT_CONFIG.layout);
    expect(small.issues.join(" ")).toContain("layout.labelWidth");
    expect(small.issues.join(" ")).toContain("layout.barWidth");
    expect(small.issues.join(" ")).toContain("layout.sparkWidth");

    const large = resolveConfig({ layout: { labelWidth: 30, barWidth: 100, sparkWidth: 500 } });
    expect(large.config.layout).toEqual(DEFAULT_CONFIG.layout);
    expect(large.issues).toHaveLength(3);

    // Both ends of every range are accepted exactly as written.
    expect(resolveConfig({ layout: { labelWidth: 6, barWidth: 1, sparkWidth: 2 } }).issues).toEqual([]);
    expect(resolveConfig({ layout: { labelWidth: 24, barWidth: 40, sparkWidth: 64 } }).issues).toEqual([]);
  });

  test("reports the fixed lines and the live rows overrunning the rail together", () => {
    const { config, issues } = resolveConfig({
      sidebar: { lines: Array.from({ length: 20 }, (_, index) => `line ${index}`), rows: DEFAULT_CONFIG.sidebar.rows },
    });
    // 20 fixed lines plus 13 live rows, against a 24-line rail.
    expect(issues.join(" ")).toContain("total 33 lines");
    // With every default row carrying data, the rail stops at the cap.
    const source = {
      caution: "▲ x",
      status: "idle",
      agent: "x",
      model: { id: "m" },
      branch: "b",
      cost: 1,
      project: { cost: 1 },
      tokens: { input: 1, output: 1, cache: { read: 1 } },
      context: { used: 1 },
      perms: { count: 1 },
      elapsedMs: 1_000,
      tps: 10,
    };
    expect(sidebarLines(config, source)).toHaveLength(24);
  });

  test("says nothing when the rail is comfortably inside its cap", () => {
    expect(resolveConfig({ sidebar: { lines: ["a", "b"], rows: ["cost"] } }).issues).toEqual([]);
  });
});
