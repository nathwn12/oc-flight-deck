import { describe, expect, test } from "bun:test";
import {
  DEFAULT_CONFIG,
  DEFAULT_SIDEBAR_ROWS,
  resolveConfig,
} from "../src/tui/config.js";
import { sidebarLines } from "../src/tui/presentation.js";
import { DEFAULT_PLACEHOLDER, statLine, statRows } from "../src/tui/stats.js";

// Persistence keeps the rail a stable shape: every field named in
// `sidebar.rows` renders exactly one row, in order, using the placeholder
// until the host has data. `statLine` itself still returns `undefined` for
// missing data — the layering lives in `statRows`/`sidebarLines`.

describe("persistent sidebar rows", () => {
  test("default persist renders a placeholder row with the same label padding", () => {
    expect(DEFAULT_CONFIG.sidebar.persist).toBe(true);
    expect(DEFAULT_CONFIG.sidebar.placeholder).toBe("—");
    expect(DEFAULT_PLACEHOLDER).toBe("—");

    // `statLine` keeps its contract: no data means `undefined`, not a row.
    expect(statLine("cache", { tokens: {} })).toBeUndefined();

    // `statRows` with persist layers the placeholder on top, padded exactly
    // like a live row (`cache` + five spaces at the default width of 10).
    expect(statRows(["cache"], { tokens: {} }, { persist: true })).toEqual(["cache     —"]);
    // Zero is also "no data" for this row, not a value to draw.
    expect(statRows(["cache"], { tokens: { cache: { read: 0 } } }, { persist: true })).toEqual([
      "cache     —",
    ]);
    // The full default rail renders through `sidebarLines` the same way.
    expect(sidebarLines(DEFAULT_CONFIG, { tokens: {} })).toContain("cache     —");
  });

  test("persist:false omits rows with no data", () => {
    expect(statRows(["cache"], { tokens: {} }, { persist: false })).toEqual([]);
    // Omitting is also the default when calling `statRows` directly.
    expect(statRows(["agent", "cost"], {})).toEqual([]);
    const config = resolveConfig({ sidebar: { persist: false } }).config;
    expect(sidebarLines(config, {})).toEqual(["✈ FLIGHT DECK", "─────────────────"]);
  });

  test("every default row renders exactly once when persist is on", () => {
    const lines = sidebarLines(DEFAULT_CONFIG, {});
    expect(lines.length).toBe(
      DEFAULT_CONFIG.sidebar.lines.length + DEFAULT_SIDEBAR_ROWS.length,
    );
    const live = lines.slice(DEFAULT_CONFIG.sidebar.lines.length);
    expect(live).toHaveLength(DEFAULT_SIDEBAR_ROWS.length);
    for (const [index, field] of DEFAULT_SIDEBAR_ROWS.entries()) {
      expect(live[index]).toBe(`${field.padEnd(10)}—`);
    }
  });

  test("a configured placeholder string is used", () => {
    const { config, issues } = resolveConfig({ sidebar: { placeholder: "n/a" } });
    expect(issues).toEqual([]);
    expect(config.sidebar.placeholder).toBe("n/a");
    expect(statRows(["cache"], { tokens: {} }, { persist: true, placeholder: "n/a" })).toEqual([
      "cache     n/a",
    ]);
    expect(sidebarLines(config, {})).toContain("cache     n/a");
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
