import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG, resolveConfig } from "../src/tui/config.js";
import { formatDuration } from "../src/tui/format.js";
import { sidebarLines } from "../src/tui/presentation.js";
import { statLine } from "../src/tui/stats.js";

// The `elapsed` row's join style is a display option, so both styles have to
// render the same measured duration — only the separators differ. `spaced` is
// the shipped default from `format.duration`; `compact` is the opt-in hug.

const CASES: ReadonlyArray<{ ms: number; compact: string; spaced: string }> = [
  { ms: 0, compact: "0s", spaced: "0s" },
  { ms: 45_000, compact: "45s", spaced: "45s" },
  { ms: 59_000, compact: "59s", spaced: "59s" },
  { ms: 60_000, compact: "1m00s", spaced: "1m 00s" },
  { ms: 59 * 60_000 + 59_000, compact: "59m59s", spaced: "59m 59s" },
  { ms: 3_600_000, compact: "1h00m00s", spaced: "1h 00m 00s" },
  { ms: 2 * 3_600_000 + 14 * 60_000 + 37_000, compact: "2h14m37s", spaced: "2h 14m 37s" },
  { ms: 12 * 3_600_000 + 34 * 60_000 + 56_000, compact: "12h34m56s", spaced: "12h 34m 56s" },
];

describe("duration styles", () => {
  test("compact hugs the same padded segments with no separators", () => {
    for (const { ms, compact } of CASES) {
      expect(formatDuration(ms, "compact")).toBe(compact);
    }
  });

  test("spaced separates the same padded segments with a single space", () => {
    for (const { ms, spaced } of CASES) {
      expect(formatDuration(ms, "spaced")).toBe(spaced);
    }
  });

  test("the formatter's own default stays compact, so direct callers are unchanged", () => {
    // The rail's shipped default is `spaced` and comes from `format.duration`;
    // the pure formatter keeps its historical one-argument contract.
    expect(formatDuration(2 * 3_600_000 + 14 * 60_000 + 37_000)).toBe("2h14m37s");
  });

  test("the elapsed row renders the style it is handed", () => {
    const ms = 2 * 3_600_000 + 14 * 60_000 + 37_000;
    expect(statLine("elapsed", { elapsedMs: ms }, { durationStyle: "spaced" })).toBe("elapsed   2h 14m 37s");
    expect(statLine("elapsed", { elapsedMs: ms }, { durationStyle: "compact" })).toBe("elapsed   2h14m37s");
  });
});

describe("format.duration config", () => {
  test("defaults to spaced when the section is absent", () => {
    const { config, issues } = resolveConfig({});
    expect(issues).toEqual([]);
    expect(config.format.duration).toBe("spaced");
    expect(DEFAULT_CONFIG.format).toEqual({ duration: "spaced" });
  });

  test("accepts both styles explicitly", () => {
    const compact = resolveConfig({ format: { duration: "compact" } });
    expect(compact.issues).toEqual([]);
    expect(compact.config.format.duration).toBe("compact");

    const spaced = resolveConfig({ format: { duration: "spaced" } });
    expect(spaced.issues).toEqual([]);
    expect(spaced.config.format.duration).toBe("spaced");
  });

  test("falls back to the default and reports an unknown, non-string, or malformed value", () => {
    const unknown = resolveConfig({ format: { duration: "wide" } });
    expect(unknown.config.format.duration).toBe("spaced");
    expect(unknown.issues.join(" ")).toContain("format.duration");

    const wrongType = resolveConfig({ format: { duration: 42 } });
    expect(wrongType.config.format.duration).toBe("spaced");
    expect(wrongType.issues.join(" ")).toContain("format.duration");

    const malformed = resolveConfig({ format: "spaced" });
    expect(malformed.config.format.duration).toBe("spaced");
    expect(malformed.issues.join(" ")).toContain("format must be an object");
  });

  test("the configured style reaches the rendered rail", () => {
    const ms = 2 * 3_600_000 + 14 * 60_000 + 37_000;
    // Default rail: spaced.
    expect(sidebarLines(resolveConfig({}).config, { elapsedMs: ms })).toContain("elapsed   2h 14m 37s");

    // Opt-in hug: compact.
    const { config } = resolveConfig({ format: { duration: "compact" } });
    expect(sidebarLines(config, { elapsedMs: ms })).toContain("elapsed   2h14m37s");
  });

  test("the schema declares the same enum and default as the code", () => {
    const root = join(import.meta.dir, "..");
    const schema = JSON.parse(readFileSync(join(root, "flight-deck.schema.json"), "utf8")) as {
      properties: Record<string, any>;
    };
    const duration = schema.properties["format"]!.properties.duration;
    expect(duration.enum).toEqual(["spaced", "compact"]);
    expect(duration.default).toBe(DEFAULT_CONFIG.format.duration);
    expect(typeof duration.description).toBe("string");
  });
});
