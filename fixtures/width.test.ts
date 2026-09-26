import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../src/tui/config.js";
import { normalizeGoUsage } from "../src/tui/go-usage.js";
import { sidebarLines } from "../src/tui/presentation.js";
import { sparkline, statLine, STAT_FIELDS, type StatSource } from "../src/tui/stats.js";

// A rail that wraps is not a rail. The sidebar is roughly 30-40 columns, and the
// host does the layout — the plugin cannot ask how wide it is, so every row has
// to stay inside the budget on its own.
//
// This exists because one row blew it: `cost` carried a subagent delta
// (`$0.245 · +$0.020 · 2 subagents`) which is 40 columns with the label, and it
// wrapped. The delta was real information that did not earn its width.

/** Everything the default rail reads, all present at once. */
const FULL: StatSource = {
  agent: "orchestrator",
  model: { id: "deepseek-v4.1-flash", providerID: "opencode-go", variant: "high" },
  cost: 0.2246,
  tokens: { input: 517512, output: 75683, reasoning: 152995, cache: { read: 29174144, write: 0 } },
  branch: "main",
  tree: { cost: 0.2447, count: 2 },
  context: { used: 218000, limit: 1000000 },
  project: { cost: 12.5, count: 40 },
  status: "running",
  busy: true,
  perms: { count: 1, action: "shell", resource: "npm publish" },
  tps: 87,
  elapsedMs: 840000,
  turns: 48,
  spark: [1, 2, 3, 4, 5, 6, 7, 8],
  caution: "⚠ shell running 8m41s",
  frame: 0,
};

/**
 * The widest a row may be.
 *
 * The plugin cannot ask the host how wide the sidebar is, so this is not the
 * real limit — it is the envelope the rows already shipped inside. `model` with
 * a variant (`model     deepseek-v4.1-flash · high`) is 37 columns and has never
 * wrapped, so 38 is the line the rail has always lived within.
 *
 * The point of the guard is to stop a *new* row escaping that envelope, which is
 * exactly what `cost` did when it grew a subagent delta to 40 and wrapped.
 */
const BUDGET = 38;

function overBudget(source: StatSource, rows?: readonly string[]): string[] {
  const config = rows === undefined ? DEFAULT_CONFIG : { ...DEFAULT_CONFIG, sidebar: { ...DEFAULT_CONFIG.sidebar, rows } };
  return sidebarLines(config, source)
    .slice(config.sidebar.lines.length)
    .filter((line) => line.length > BUDGET);
}

describe("the rail fits", () => {
  test("every row separates its label from its value, at any label width", () => {
    // `reasoning` is nine characters. Before this was fixed, a label wider than
    // the column was glued to its value - at labelWidth 8 the row rendered as
    // "reasoning153k". Any label outgrowing any valid width has to stay legible.
    for (const labelWidth of [6, 8, 9, 10, 12, 16, 24]) {
      const config = {
        ...DEFAULT_CONFIG,
        sidebar: { ...DEFAULT_CONFIG.sidebar, rows: DEFAULT_CONFIG.sidebar.rows },
        layout: { ...DEFAULT_CONFIG.layout, labelWidth },
      };
      const rows = sidebarLines(config, FULL).slice(config.sidebar.lines.length);
      expect(rows.length).toBeGreaterThan(0);
      for (const line of rows) {
        // label, at least one space, then something.
        expect(line).toMatch(/^\S+\s+\S/);
      }
    }
  });

  test("the shipped default rail fits", () => {
    expect(overBudget(FULL)).toEqual([]);
  });

  test("every field fits, including the rows that are off by default", () => {
    // The default rows are 13 of the 17 fields, so `reasoning` (the widest
    // label), `spark` (a width of its own) and `total` (the widest value) were
    // never actually put on the rail by this guard. Two of those shipped bugs.
    for (const field of STAT_FIELDS) {
      expect(overBudget(FULL, [field])).toEqual([]);
    }
  });

  test("a label wider than its column still gets a separator", () => {
    // The literal shape of the shipped bug: `reasoning` is nine characters, so
    // at labelWidth 8 it overflows its column. Padding alone leaves it glued to
    // the value ("reasoning153k"); the row has to guarantee the space itself.
    for (const labelWidth of [8, 9, 10]) {
      expect(statLine("reasoning", { tokens: { reasoning: 152_995 } }, { labelWidth })).toBe("reasoning 153k");
    }
  });

  test("the spark row is as wide as sparkWidth asks for, and still fits", () => {
    const source = { ...FULL, spark: Array.from({ length: 32 }, (_, index) => index + 1) };
    for (const sparkWidth of [2, 12, 16, 24]) {
      const config = {
        ...DEFAULT_CONFIG,
        sidebar: { ...DEFAULT_CONFIG.sidebar, rows: ["spark"] },
        layout: { ...DEFAULT_CONFIG.layout, sparkWidth },
      };
      const [row] = sidebarLines(config, source).slice(config.sidebar.lines.length);
      // The newest `sparkWidth` samples of 1..32, drawn as a shape.
      const expected = sparkline(Array.from({ length: sparkWidth }, (_, index) => index + 32 - sparkWidth + 1));
      expect(row).toBe(`spark     ${expected}`);
      expect(row!.length).toBeLessThanOrEqual(BUDGET);
    }
  });

  test("a populated go row fits, reset hint and all", () => {
    // The per-field loop above only ever sees the placeholder, so the row's real
    // width was never measured. The live sample is the real width: three dials.
    const live = normalizeGoUsage({
      usage: {
        rolling: { status: "ok", percent: 0 },
        weekly: { status: "ok", percent: 79 },
        monthly: { status: "ok", percent: 39 },
      },
    });
    expect(overBudget({ ...FULL, go: live }, ["go"])).toEqual([]);
    // The widest shape the live cutoffs produce: one window flagged, so its dial,
    // number and reset hint are all drawn.
    const flagged = { windows: [{ id: "1w", ratio: 0.95, resetAtMs: Date.now() + 2 * 3_600_000 }] };
    expect(overBudget({ ...FULL, go: flagged }, ["go"])).toEqual([]);
  });

  test("no row wraps when the caution row is at its longest", () => {
    for (const text of [
      "⚠ shell running 8m41s",
      "⚠ read ×3 identical",
      "⚠ shell failing ×3",
      "▲ no progress 11m",
      "⚠ delegate_task failing ×12",
    ]) {
      expect(overBudget({ ...FULL, caution: text })).toEqual([]);
    }
  });

  test("the merged cost row fits too, which is the one that broke", () => {
    // No `total` row, so `cost` carries the family figure itself.
    expect(overBudget({ ...FULL, tree: { cost: 0.2447, count: 2 } })).toEqual([]);
    // The shapes that made it widest: many subagents, and a large figure.
    for (const tree of [
      { cost: 0.2447, count: 2 },
      { cost: 1.2345, count: 12 },
      { cost: 128.42, count: 137 },
    ]) {
      expect(overBudget({ ...FULL, tree })).toEqual([]);
    }
  });

  test("every single field fits on its own", () => {
    // Omission is opt-in now: the default rail is persistent, so pin the
    // silent start through an explicit `persist: false`.
    const silent = { ...DEFAULT_CONFIG, sidebar: { ...DEFAULT_CONFIG.sidebar, persist: false } };
    const rows = sidebarLines(silent).slice(silent.sidebar.lines.length);
    expect(rows).toEqual([]); // no data, no rows - the rail starts silent when not persistent
    for (const field of DEFAULT_CONFIG.sidebar.rows) {
      expect(overBudget(FULL, [field])).toEqual([]);
    }
  });

  test("a row that legitimately cannot be shortened is the only one allowed to be long", () => {
    // `perms` carries a path when the host gives one. It is clipped, and this
    // pins that the clipping is what keeps it inside the budget.
    const long = overBudget({
      ...FULL,
      perms: {
        count: 1,
        action: "read",
        resource: "/very/long/path/to/a/config/file/that/needs/clipping/opencode.jsonc",
      },
    });
    expect(long).toEqual([]);
  });
});
