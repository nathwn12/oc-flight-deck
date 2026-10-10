import { describe, expect, test } from "bun:test";
import {
  DEFAULT_CONFIG,
  DEFAULT_SIDEBAR_ROWS,
  resolveConfig,
} from "../src/tui/config.js";
import { sidebarLines } from "../src/tui/presentation.js";
import { DEFAULT_PLACEHOLDER, statLine, statRows } from "../src/tui/stats.js";

// Persistence keeps the rail a stable shape: every field named in
// `sidebar.rows` renders exactly one row, in order, drawing a zero skeleton
// (a live-shaped zero, byte-identical to a real one) until the host has data.
// `statLine` itself still returns `undefined` for missing data — the layering
// lives in `statRows`/`sidebarLines`. The placeholder survives only as the
// fallback for the fields with no skeleton (`caution`) and as the configured
// string a user chose for that silence.

/** Every field's zero skeleton, exactly as `statRows` draws it with no data. */
const SKELETONS: Readonly<Record<string, string>> = {
  status: "○ idle",
  agent: "none",
  model: "none",
  branch: "no branch",
  cost: "$0.000",
  total: "$0.000",
  project: "$0.000",
  tokens: "0 in · 0 out",
  cache: "0 read",
  context: "░░░░░░░░░░ ~0%",
  perms: "0 waiting",
  elapsed: "0s",
  tps: "0 tok/s",
  spark: "▁▁▁▁▁▁▁▁▁▁▁▁",
  reasoning: "0",
  turns: "0",
  guard: "unknown",
  go: "○ 0 ○ 0 ○ 0",
  ses: "none",
};

/** The label a skeleton row draws: `ses` reads as `session`, the rest itself. */
function skeletonLabel(field: string): string {
  return field === "ses" ? "session" : field;
}

/** One skeleton row, padded exactly like a live row at the given width. */
function skeletonRow(field: string, labelWidth: number): string {
  const label = skeletonLabel(field);
  const prefix = label.padEnd(labelWidth) + (label.length >= labelWidth ? " " : "");
  return `${prefix}${SKELETONS[field]}`;
}

describe("persistent sidebar rows", () => {
  test("default persist renders a zero skeleton with the same label padding", () => {
    expect(DEFAULT_CONFIG.sidebar.persist).toBe(true);
    expect(DEFAULT_CONFIG.sidebar.placeholder).toBe("—");
    expect(DEFAULT_PLACEHOLDER).toBe("—");

    // `statLine` keeps its contract: no data means `undefined`, not a row —
    // it never draws skeletons, whatever the field.
    for (const field of [...Object.keys(SKELETONS), "caution"]) {
      expect(statLine(field, {})).toBeUndefined();
    }

    // `statRows` with persist layers the skeleton on top, padded exactly
    // like a live row (`cache` + five spaces at the default width of 10).
    expect(statRows(["cache"], { tokens: {} }, { persist: true })).toEqual(["cache     0 read"]);
    // Zero is a drawn state for this row ("no cache"), not a skeleton: only
    // "no data yet" falls through to persist.
    expect(statRows(["cache"], { tokens: { cache: { read: 0 } } }, { persist: true })).toEqual([
      "cache     0 read",
    ]);
    // The full default rail renders through `sidebarLines` the same way.
    expect(sidebarLines(DEFAULT_CONFIG, { tokens: {} })).toContain("cache     0 read");
  });

  test("every skeleton renders at label widths 8 and 10", () => {
    for (const [field, value] of Object.entries(SKELETONS)) {
      for (const labelWidth of [8, 10]) {
        expect(statRows([field], {}, { persist: true, labelWidth })).toEqual([
          skeletonRow(field, labelWidth),
        ]);
      }
    }
    // Spot-check the exact strings, so the table above is pinned to literals
    // rather than only to its own helper.
    expect(statRows(["ses"], {}, { persist: true })).toEqual(["session   none"]);
    expect(statRows(["ses"], {}, { persist: true, labelWidth: 8 })).toEqual(["session none"]);
    expect(statRows(["reasoning"], {}, { persist: true, labelWidth: 8 })).toEqual(["reasoning 0"]);
    expect(statRows(["go"], {}, { persist: true })).toEqual(["go        ○ 0 ○ 0 ○ 0"]);
    expect(statRows(["context"], {}, { persist: true })).toEqual(["context   ░░░░░░░░░░ ~0%"]);
  });

  test("skeletons follow the row's geometry hints", () => {
    // A narrow fuel gauge and sparkline shrink the skeleton with them.
    expect(statRows(["context"], {}, { persist: true, barWidth: 6 })).toEqual([
      "context   ░░░░░░ ~0%",
    ]);
    expect(statRows(["spark"], {}, { persist: true, sparkWidth: 4 })).toEqual(["spark     ▁▁▁▁"]);
    // The elapsed skeleton threads the duration style, like the live row.
    expect(statRows(["elapsed"], {}, { persist: true, durationStyle: "spaced" })).toEqual([
      "elapsed   0s",
    ]);
  });

  test("persist:false omits rows with no data", () => {
    expect(statRows(["cache"], { tokens: {} }, { persist: false })).toEqual([]);
    // Omitting is also the default when calling `statRows` directly.
    expect(statRows(["agent", "cost"], {})).toEqual([]);
    const config = resolveConfig({ sidebar: { persist: false } }).config;
    // The top rail has no fixed lines by default since 0.8.0: with no data and
    // no persistence, nothing renders.
    expect(sidebarLines(config, {})).toEqual([]);
  });

  test("every default row renders exactly once when persist is on", () => {
    const lines = sidebarLines(DEFAULT_CONFIG, {});
    expect(lines.length).toBe(
      DEFAULT_CONFIG.sidebar.lines.length + DEFAULT_SIDEBAR_ROWS.length,
    );
    const live = lines.slice(DEFAULT_CONFIG.sidebar.lines.length);
    expect(live).toHaveLength(DEFAULT_SIDEBAR_ROWS.length);
    for (const [index, field] of DEFAULT_SIDEBAR_ROWS.entries()) {
      expect(live[index]).toBe(skeletonRow(field, 10));
    }
  });

  test("the default rows carry neither the annunciator nor the branch", () => {
    // The loop above is dynamic, so removing a row from the constant would leave
    // it green. Pin the flips: a clock-driven warning and a VCS call are opt-in.
    expect(DEFAULT_SIDEBAR_ROWS).not.toContain("caution");
    expect(DEFAULT_SIDEBAR_ROWS).not.toContain("branch");
    expect(DEFAULT_SIDEBAR_ROWS).not.toContain("go");
  });

  test("a configured placeholder never overrides a zero skeleton", () => {
    const { config, issues } = resolveConfig({ sidebar: { placeholder: "n/a" } });
    expect(issues).toEqual([]);
    expect(config.sidebar.placeholder).toBe("n/a");
    // Every field with a skeleton draws it instead of the configured string.
    expect(statRows(["cache"], { tokens: {} }, { persist: true, placeholder: "n/a" })).toEqual([
      "cache     0 read",
    ]);
    expect(sidebarLines(config, {})).not.toContain("n/a");
    // And the one field without a skeleton stays silent rather than drawing it.
    expect(statRows(["caution"], {}, { persist: true, placeholder: "n/a" })).toEqual([]);
  });

  test("the annunciator stays silent and a typo stays skipped when persistent", () => {
    // `caution` has no skeleton: silence is the design, so there is no row.
    expect(statRows(["caution"], {}, { persist: true })).toEqual([]);
    // An unknown field name is never given a skeleton or a placeholder.
    expect(statRows(["nope"], {}, { persist: true })).toEqual([]);
    expect(statRows(["agent", "nope"], {}, { persist: true })).toEqual(["agent     none"]);
  });

  test("an invalid placeholder falls back to the default and records an issue", () => {
    for (const bad of [123, "", "   ", null]) {
      const resolution = resolveConfig({ sidebar: { placeholder: bad } });
      expect(resolution.config.sidebar.placeholder).toBe(DEFAULT_PLACEHOLDER);
      expect(resolution.issues.join(" ")).toContain("sidebar.placeholder");
    }
    // A non-boolean persist also falls back loudly rather than throwing.
    const persist = resolveConfig({ sidebar: { persist: "yes" } });
    expect(persist.config.sidebar.persist).toBe(true);
    expect(persist.issues.join(" ")).toContain("sidebar.persist");
  });
});
