import { describe, expect, test } from "bun:test";
import {
  PANEL_DEFAULT_BAR_WIDTH,
  PANEL_DEFAULT_BLINK,
  PANEL_DEFAULT_BLINK_MS,
  PANEL_DEFAULT_LABELS,
  formatCompactRemaining,
  goPanelLines,
} from "../src/tui/go-panel.js";
import type { GoUsage } from "../src/tui/go-usage.js";

// Every glyph is an escape so this file stays ASCII: the em dash is the
// shipped placeholder, the diamond is the header mark, the bar cells are the
// panel's own heavy/light rule, and the breathing mark is built from char
// codes so no literal ring ever lands in the source.
const DASH = "\u2014";
const DIAMOND = "\u25C8";
const FULL = "\u2501";
const EMPTY = "\u2500";
const REST = String.fromCharCode(0x25cb);
const MID = String.fromCharCode(0x25ce);
const LIVE = String.fromCharCode(0x25cf);

/** The panel's default meter width: shorter since the signature look. */
const PANEL_BAR = 10;
/**
 * The panel's effective default label width: the configured 6 auto-widens to
 * hold the longest default rename (`rolling`/`monthly`, 7 cells).
 */
const PANEL_LABEL = 7;
/** The sidebar width budget: no line may draw past it. */
const WIDTH_BUDGET = 40;
/** Milliseconds per breath step. */
const BLINK_MS = 700;

/** One label column plus its single-space separator. */
function labelCell(label: string, width: number = PANEL_LABEL): string {
  return `${label.padEnd(width)} `;
}

/** The exact meter `goPanelLines` draws, built here so the expectation is explicit. */
function bar(filled: number, width: number = PANEL_BAR): string {
  return `${FULL.repeat(filled)}${EMPTY.repeat(width - filled)}`;
}

/** The empty track the resting placeholder keeps. */
function track(width: number = PANEL_BAR): string {
  return EMPTY.repeat(width);
}

/** Right-aligned percent column: one-space gap plus the value padded to 4. */
function percentCell(value: string): string {
  return ` ${value.padStart(4)}`;
}

/** Right-aligned reset column: one-space gap plus the compact time padded to 6. */
function countdownCell(time: string): string {
  return ` ${time.padStart(6)}`;
}

const HEADER = ` ${DIAMOND} OPENCODE GO`;

/** The breath ring for one wall-clock instant at the default cadence. */
function breathAt(nowMs: number, blinkMs: number = BLINK_MS): string {
  const frames = [REST, MID, LIVE, MID];
  return frames[Math.floor(nowMs / blinkMs) % frames.length] ?? REST;
}

/** The two-cell mark column on the first meter line at one instant. */
function firstMark(nowMs: number = NOW, blinkMs: number = BLINK_MS): string {
  return `${breathAt(nowMs, blinkMs)} `;
}

/** The two spaces keeping the other rows on the same axis as the mark. */
const OTHER_MARK = "  ";

/**
 * The filled-cell index of the panel's bright sweep cell on the first meter
 * line, or `-1` when there is none. Counts `FULL` cells before the run toned
 * `default`. With no header the first meter line is index 0; with
 * `header: true` it is index 1.
 */
function brightCell(usage: GoUsage, frame?: number, layout?: unknown): number {
  const look = { sweep: true, ...(typeof layout === "object" && layout !== null ? layout : {}) };
  const lines = goPanelLines(usage, NOW, look, frame);
  const first = lines[0]?.text === HEADER ? lines[1] : lines[0];
  const segments = first?.segments ?? [];
  let index = 0;
  for (const segment of segments) {
    if (segment.tone === "default") return index;
    for (const char of segment.text) if (char === FULL) index += 1;
  }
  return -1;
}

/** Bright cell without opting in: the default static meter never has one. */
function staticBrightCell(usage: GoUsage, frame?: number): number {
  const segments = goPanelLines(usage, NOW, undefined, frame)[0]?.segments ?? [];
  let index = 0;
  for (const segment of segments) {
    if (segment.tone === "default") return index;
    for (const char of segment.text) if (char === FULL) index += 1;
  }
  return -1;
}

/** The one instant every test reads its countdowns against. */
const NOW = 1_700_000_000_000;

describe("go panel lines", () => {
  test("ships the signature look: lowercase labels, a 10-cell bar, a breathing mark", () => {
    expect(PANEL_DEFAULT_LABELS).toEqual({ rolling: "rolling", weekly: "weekly", monthly: "monthly" });
    expect(PANEL_DEFAULT_BAR_WIDTH).toBe(10);
    expect(PANEL_DEFAULT_BLINK).toBe(true);
    expect(PANEL_DEFAULT_BLINK_MS).toBe(700);
    // At NOW the breath sits on its rest ring, dim; the other rows hold spaces.
    const lines = goPanelLines(undefined, NOW);
    expect(lines[0]?.text.startsWith(`${REST} `)).toBe(true);
    expect(lines[0]?.segments?.[0]).toEqual({ text: `${REST} `, tone: "subdued" });
    expect(lines[1]?.text.startsWith(OTHER_MARK)).toBe(true);
    expect(lines[2]?.text.startsWith(OTHER_MARK)).toBe(true);
  });

  test("renders exactly three lines by default with no header, in the canonical order, labelled", () => {
    // Deliberately out of order in the payload: the panel's order is its own.
    const usage: GoUsage = {
      windows: [
        { id: "1m", ratio: 0.04 },
        { id: "5h", ratio: 0.2 },
        { id: "1w", ratio: 0.8 },
      ],
    };
    const lines = goPanelLines(usage, NOW);
    expect(lines).toHaveLength(3);
    expect(lines.map((line) => line.text)).toEqual([
      `${firstMark()}${labelCell("rolling")}${bar(2)}${percentCell("20%")}`,
      `${OTHER_MARK}${labelCell("weekly")}${bar(8)}${percentCell("80%")}`,
      `${OTHER_MARK}${labelCell("monthly")}${bar(0)}${percentCell("4%")}`,
    ]);
    // No header by default: none of the three lines is the diamond line.
    for (const line of lines) expect(line.text).not.toBe(HEADER);
    // Every line carries the `go` field name, so the footer resolves the same
    // row style the inline `go` row does.
    expect(lines.map((line) => line.field)).toEqual(["go", "go", "go"]);
    // The plain text is exactly the join of the coloured runs.
    for (const line of lines) {
      expect(line.text).toBe((line.segments ?? []).map((segment) => segment.text).join(""));
    }
  });

  test("draws the header only when header:true opts it in", () => {
    const usage: GoUsage = { windows: [{ id: "5h", ratio: 0.2 }] };
    const plain = goPanelLines(usage, NOW);
    expect(plain).toHaveLength(3);
    expect(plain.map((line) => line.text)).not.toContain(HEADER);

    const headed = goPanelLines(usage, NOW, { header: true });
    expect(headed).toHaveLength(4);
    expect(headed[0]?.text).toBe(HEADER);
    expect(headed[0]?.segments).toEqual([{ text: HEADER, tone: "subdued" }]);
    expect(headed[0]?.field).toBe("go");
    expect(headed.slice(1).map((line) => line.text)).toEqual(plain.map((line) => line.text));

    // A malformed header is dropped, not drawn: the panel stays three lines.
    expect(goPanelLines(usage, NOW, { header: "yes" })).toHaveLength(3);
  });

  test("lays every row on one fixed-width grid with a shared axis", () => {
    // The live triple from the brief: 29% with 2h44m, 11% with 1d4h,
    // 5% with 30d21h. Each column is fixed-width, so the percent and the
    // countdown line up exactly across rows.
    const usage: GoUsage = {
      windows: [
        { id: "5h", ratio: 0.29, resetAtMs: NOW + (2 * 3_600_000 + 44 * 60_000) },
        { id: "1w", ratio: 0.11, resetAtMs: NOW + (28 * 3_600_000) },
        { id: "1m", ratio: 0.05, resetAtMs: NOW + (30 * 86_400_000 + 21 * 3_600_000) },
      ],
    };
    const lines = goPanelLines(usage, NOW);
    expect(lines.map((line) => line.text)).toEqual([
      `${firstMark()}${labelCell("rolling")}${bar(3)}${percentCell("29%")}${countdownCell("2h44m")}`,
      `${OTHER_MARK}${labelCell("weekly")}${bar(1)}${percentCell("11%")}${countdownCell("1d4h")}`,
      `${OTHER_MARK}${labelCell("monthly")}${bar(1)}${percentCell("5%")}${countdownCell("30d21h")}`,
    ]);
    // The percent column is right-aligned to 4 (`  5%`, ` 11%`, ` 29%`)...
    expect(lines[2]?.text).toContain(percentCell("5%"));
    expect(lines[1]?.text).toContain(percentCell("11%"));
    expect(lines[0]?.text).toContain(percentCell("29%"));
    // ...and the reset column to 6 (` 2h44m`, `  1d4h`, `30d21h`).
    expect(lines[0]?.text).toContain(countdownCell("2h44m"));
    expect(lines[1]?.text).toContain(countdownCell("1d4h"));
    expect(lines[2]?.text).toContain(countdownCell("30d21h"));
    // Shared axis: the mark, the label, the meter, the percent and the reset
    // each start at the same column on every row.
    const markWidth = 2;
    const meterStart = markWidth + PANEL_LABEL + 1;
    const percentStart = meterStart + PANEL_BAR + 1;
    for (const line of lines) {
      expect(line.text.slice(markWidth, markWidth + PANEL_LABEL)).toBe(
        line.text.slice(markWidth, markWidth + PANEL_LABEL).padEnd(PANEL_LABEL),
      );
      expect(line.text[markWidth + PANEL_LABEL]).toBe(" ");
      expect(line.text.slice(meterStart, meterStart + PANEL_BAR)).toHaveLength(PANEL_BAR);
      expect(line.text[meterStart + PANEL_BAR]).toBe(" ");
      expect(line.text.slice(percentStart, percentStart + 4)).toHaveLength(4);
    }
    // The whole line never exceeds the sidebar width or wraps.
    for (const line of lines) expect(line.text.length).toBeLessThanOrEqual(WIDTH_BUDGET);
  });

  test("draws a whole-number percent beside the meter, right-aligned", () => {
    // 1/3 rounds to 33, and the meter fills three of ten cells (3.33 -> 3).
    const lines = goPanelLines({ windows: [{ id: "5h", ratio: 1 / 3 }] }, NOW);
    expect(lines[0]?.text).toBe(`${firstMark()}${labelCell("rolling")}${bar(3)}${percentCell("33%")}`);
    // Single digits sit in the same column: the percent is padded to width 4.
    expect(goPanelLines({ windows: [{ id: "5h", ratio: 0.04 }] }, NOW)[0]?.text).toBe(
      `${firstMark()}${labelCell("rolling")}${bar(0)}${percentCell("4%")}`,
    );
    // Three digits fill the column with no padding.
    expect(goPanelLines({ windows: [{ id: "5h", ratio: 1 }] }, NOW)[0]?.text).toBe(
      `${firstMark()}${labelCell("rolling")}${bar(10)}${percentCell("100%")}`,
    );
  });

  test("adds a dim reset countdown whenever the reset is a known future instant", () => {
    const hours = goPanelLines({ windows: [{ id: "5h", ratio: 0.2, resetAtMs: NOW + 2 * 3_600_000 }] }, NOW);
    expect(hours[0]?.text).toBe(`${firstMark()}${labelCell("rolling")}${bar(2)}${percentCell("20%")}${countdownCell("2h")}`);

    const minutes = goPanelLines({ windows: [{ id: "1w", ratio: 0.1, resetAtMs: NOW + 90_000 }] }, NOW);
    expect(minutes[1]?.text).toBe(`${OTHER_MARK}${labelCell("weekly")}${bar(1)}${percentCell("10%")}${countdownCell("2m")}`);

    const seconds = goPanelLines({ windows: [{ id: "1m", ratio: 0.1, resetAtMs: NOW + 5_000 }] }, NOW);
    expect(seconds[2]?.text).toBe(`${OTHER_MARK}${labelCell("monthly")}${bar(1)}${percentCell("10%")}${countdownCell("5s")}`);

    // A CALM window still gets its countdown: unlike the one-line `go` row,
    // the panel has a line per window, so the time to relief is not noise.
    const calm = goPanelLines({ windows: [{ id: "1w", ratio: 0.5, resetAtMs: NOW + 3_600_000 }] }, NOW);
    expect(calm[1]?.text).toBe(`${OTHER_MARK}${labelCell("weekly")}${bar(5)}${percentCell("50%")}${countdownCell("1h")}`);

    // The countdown is always the dim column, even beside a flagged meter.
    const flagged = goPanelLines(
      { windows: [{ id: "5h", ratio: 0.95, resetAtMs: NOW + 3_600_000 }] },
      NOW,
    )[0]?.segments;
    expect(flagged?.[flagged.length - 1]).toEqual({ text: countdownCell("1h"), tone: "subdued" });
  });

  test("omits the countdown when the reset is unknown or already past", () => {
    const past = goPanelLines({ windows: [{ id: "5h", ratio: 0.2, resetAtMs: NOW - 1 }] }, NOW);
    expect(past[0]?.text).toBe(`${firstMark()}${labelCell("rolling")}${bar(2)}${percentCell("20%")}`);

    const unknown = goPanelLines({ windows: [{ id: "5h", ratio: 0.2 }] }, NOW);
    expect(unknown[0]?.text).toBe(`${firstMark()}${labelCell("rolling")}${bar(2)}${percentCell("20%")}`);

    const garbage = goPanelLines({ windows: [{ id: "5h", ratio: 0.2, resetAtMs: Number.NaN }] }, NOW);
    expect(garbage[0]?.text).toBe(`${firstMark()}${labelCell("rolling")}${bar(2)}${percentCell("20%")}`);

    // Exactly at the reset instant is "already past": remaining is not > 0.
    const exactly = goPanelLines({ windows: [{ id: "5h", ratio: 0.2, resetAtMs: NOW }] }, NOW);
    expect(exactly[0]?.text).toBe(`${firstMark()}${labelCell("rolling")}${bar(2)}${percentCell("20%")}`);
  });

  test("tones only a flagged window's meter and percent, keeping the countdown dim", () => {
    const usage: GoUsage = {
      windows: [
        { id: "5h", ratio: 0.95, resetAtMs: NOW + 3_600_000 },
        { id: "1w", ratio: 0.5 },
      ],
    };
    const lines = goPanelLines(usage, NOW);
    const flagged = lines[0]?.segments ?? [];
    // The mark breathes dim, the label keeps the line's own colour, the meter
    // and percent take the error tone, and the countdown stays dim relief.
    expect(flagged.map((segment) => segment.tone)).toEqual(["subdued", undefined, "error", "subdued"]);
    expect(flagged[0]).toEqual({ text: firstMark(), tone: "subdued" });
    expect(flagged[1]).toEqual({ text: labelCell("rolling") });
    expect(flagged[2]).toEqual({ text: `${bar(10)}${percentCell("95%")}`, tone: "error" });
    expect(flagged[3]).toEqual({ text: countdownCell("1h"), tone: "subdued" });

    // The healthy neighbour is untouched past the mark column, so the panel
    // reads as one instrument with a problem.
    expect((lines[1]?.segments ?? []).slice(1).every((segment) => segment.tone === undefined)).toBe(true);
    expect(lines[1]?.text).toBe(`${OTHER_MARK}${labelCell("weekly")}${bar(5)}${percentCell("50%")}`);
  });

  test("flags a window reporting a non-ok status, even at a calm ratio", () => {
    const throttled = goPanelLines({ windows: [{ id: "1m", ratio: 0.1, status: "throttled" }] }, NOW);
    expect(throttled[2]?.segments?.some((segment) => segment.tone === "error")).toBe(true);

    // Past the mark column, the calm window is untouched.
    const ok = goPanelLines({ windows: [{ id: "1m", ratio: 0.1, status: "ok" }] }, NOW);
    expect(ok[2]?.segments?.slice(1).every((segment) => segment.tone === undefined)).toBe(true);
  });

  test("renders three dim resting lines with no usage and no header", () => {
    const lines = goPanelLines(undefined, NOW);
    expect(lines).toHaveLength(3);
    expect(lines.map((line) => line.text)).toEqual([
      `${firstMark()}${labelCell("rolling")}${track()}${percentCell(DASH)}`,
      `${OTHER_MARK}${labelCell("weekly")}${track()}${percentCell(DASH)}`,
      `${OTHER_MARK}${labelCell("monthly")}${track()}${percentCell(DASH)}`,
    ]);
    // The resting value is explicitly subdued: it stays dim even when the row
    // style is set bright, because it is not a reading. The empty track is
    // kept so the panel's shape never jumps between waiting and reading.
    expect(lines[0]?.segments?.[0]).toEqual({ text: firstMark(), tone: "subdued" });
    expect(lines[0]?.segments?.[1]).toEqual({ text: labelCell("rolling") });
    expect(lines[0]?.segments?.[2]).toEqual({ text: `${track()}${percentCell(DASH)}`, tone: "subdued" });

    // An empty window list is the same resting panel, header still absent.
    expect(goPanelLines({ windows: [] }, NOW).map((line) => line.text)).toEqual(
      lines.map((line) => line.text),
    );

    // A window with no readable ratio keeps its line, drawing an empty meter
    // and the placeholder: a count with no known limit is not a percent.
    expect(goPanelLines({ windows: [{ id: "5h" }] }, NOW)[0]?.text).toBe(
      `${firstMark()}${labelCell("rolling")}${bar(0)}${percentCell(DASH)}`,
    );
  });

  test("clamps a ratio above one and drops a ratio that is not a reading", () => {
    const hot = goPanelLines({ windows: [{ id: "5h", ratio: 1.5 }] }, NOW);
    expect(hot[0]?.text).toBe(`${firstMark()}${labelCell("rolling")}${bar(10)}${percentCell("100%")}`);

    const ratios: readonly unknown[] = [-0.2, Number.NaN, Number.POSITIVE_INFINITY, "0.5"];
    for (const ratio of ratios) {
      const lines = goPanelLines({ windows: [{ id: "5h", ratio }] } as GoUsage, NOW);
      expect(lines[0]?.text).toBe(`${firstMark()}${labelCell("rolling")}${bar(0)}${percentCell(DASH)}`);
    }

    // A legitimate zero is a reading: an empty meter and 0%.
    expect(goPanelLines({ windows: [{ id: "5h", ratio: 0 }] }, NOW)[0]?.text).toBe(
      `${firstMark()}${labelCell("rolling")}${bar(0)}${percentCell("0%")}`,
    );
  });

  test("honours the bar and label widths and falls back on a malformed hint, capped to the sidebar", () => {
    const usage: GoUsage = { windows: [{ id: "5h", ratio: 0.5 }] };
    // A narrow meter and a wide label column are both honoured: one space
    // still separates every column, and the mark still leads the line.
    expect(goPanelLines(usage, NOW, { labelWidth: 8, barWidth: 4 })[0]?.text).toBe(
      `${firstMark()}${labelCell("rolling", 8)}${bar(2, 4)}${percentCell("50%")}`,
    );
    expect(goPanelLines(undefined, NOW, { labelWidth: 8 })[2]?.text).toBe(
      `${OTHER_MARK}${labelCell("monthly", 8)}${track()}${percentCell(DASH)}`,
    );

    // Anything unreadable is the panel's own default, never a broken line.
    const defaults = `${firstMark()}${labelCell("rolling")}${bar(2)}${percentCell("20%")}`;
    const wide = goPanelLines({ windows: [{ id: "5h", ratio: 0.2 }] }, NOW);
    expect(wide[0]?.text).toBe(defaults);
    expect(goPanelLines({ windows: [{ id: "5h", ratio: 0.2 }] }, NOW, "nope")[0]?.text).toBe(defaults);
    expect(goPanelLines({ windows: [{ id: "5h", ratio: 0.2 }] }, NOW, { barWidth: "big" })[0]?.text).toBe(
      defaults,
    );
    expect(goPanelLines({ windows: [{ id: "5h", ratio: 0.2 }] }, NOW, { barWidth: -3 })[0]?.text).toBe(
      defaults,
    );
    // A label too narrow to hold the column falls back rather than misaligning.
    expect(goPanelLines({ windows: [{ id: "5h", ratio: 0.2 }] }, NOW, { labelWidth: 2 })[0]?.text).toBe(
      defaults,
    );

    // A wider meter is honoured while it fits the sidebar...
    expect(goPanelLines(usage, NOW, { barWidth: 14 })[0]?.text).toBe(
      `${firstMark()}${labelCell("rolling")}${bar(7, 14)}${percentCell("50%")}`,
    );
    // ...and capped instead of overflowing it: mark 2 + label 7 + separator +
    // bar + percent col + reset col is 22 + bar, so 40 caps the bar at 18.
    const capped = goPanelLines(
      { windows: [{ id: "5h", ratio: 1, resetAtMs: NOW + 30 * 86_400_000 + 23 * 3_600_000 }] },
      NOW,
      { barWidth: 40 },
    );
    expect(capped[0]?.text).toBe(
      `${firstMark()}${labelCell("rolling")}${bar(18, 18)}${percentCell("100%")}${countdownCell("30d23h")}`,
    );
    expect(capped[0]?.text.length).toBeLessThanOrEqual(WIDTH_BUDGET);
  });

  test("renames labels from config and auto-widens the column so nothing overflows", () => {
    // The longest rename is 18 cells: the column grows past the configured 6,
    // and the bar caps to the sidebar budget instead of overflowing it.
    const layout = { blink: false, labels: { rolling: "r", weekly: "midweek!", monthly: "a-much-longer-name" } };
    const lines = goPanelLines(undefined, NOW, layout);
    expect(lines.map((line) => line.text)).toEqual([
      `${labelCell("r", 18)}${track(9)}${percentCell(DASH)}`,
      `${labelCell("midweek!", 18)}${track(9)}${percentCell(DASH)}`,
      `${labelCell("a-much-longer-name", 18)}${track(9)}${percentCell(DASH)}`,
    ]);
    // One shared axis past the rename, and still inside the sidebar budget.
    for (const line of lines) {
      expect(line.text.indexOf(EMPTY)).toBe(18 + 1);
      expect(line.text.length).toBeLessThanOrEqual(WIDTH_BUDGET);
    }

    // The configured width is a minimum: a narrow setting never shrinks the
    // column below the longest rename, while an explicitly wider one wins.
    // Either way the bar caps so the line stays inside the sidebar budget.
    expect(goPanelLines(undefined, NOW, { ...layout, labelWidth: 5 })[2]?.text).toBe(
      `${labelCell("a-much-longer-name", 18)}${track(9)}${percentCell(DASH)}`,
    );
    expect(goPanelLines(undefined, NOW, { ...layout, labelWidth: 20 })[2]?.text).toBe(
      `${labelCell("a-much-longer-name", 20)}${track(7)}${percentCell(DASH)}`,
    );

    // A bad rename falls back per-key, silently at this boundary: the panel
    // never throws, and the config surface reports it instead.
    const bad = goPanelLines(undefined, NOW, {
      blink: false,
      labels: { rolling: 42, weekly: "", monthly: "x".repeat(30) },
    });
    expect(bad.map((line) => line.text)).toEqual([
      `${labelCell("rolling")}${track()}${percentCell(DASH)}`,
      `${labelCell("weekly")}${track()}${percentCell(DASH)}`,
      `${labelCell("monthly")}${track()}${percentCell(DASH)}`,
    ]);
  });

  test("breathes rest, swell, live, swell from the wall clock, never touching the meter", () => {
    const usage: GoUsage = { windows: [{ id: "5h", ratio: 0.5 }] };
    const markOf = (nowMs: number, layout?: unknown) =>
      goPanelLines(usage, nowMs, layout)[0]?.text.slice(0, 2);
    // One step per blinkMs (700): the four-step cadence at fixed instants.
    expect(markOf(0)).toBe(`${REST} `);
    expect(markOf(700)).toBe(`${MID} `);
    expect(markOf(1400)).toBe(`${LIVE} `);
    expect(markOf(2100)).toBe(`${MID} `);
    expect(markOf(2800)).toBe(`${REST} `);
    // The other rows hold two spaces at every step, so the columns line up.
    for (const nowMs of [0, 700, 1400, 2100]) {
      const lines = goPanelLines(usage, nowMs);
      expect(lines[1]?.text.slice(0, 2)).toBe(OTHER_MARK);
      expect(lines[2]?.text.slice(0, 2)).toBe(OTHER_MARK);
    }
    // The monochrome pulse: dim at the rest ring, normal at the live dot.
    expect(goPanelLines(usage, 0)[0]?.segments?.[0]).toEqual({ text: `${REST} `, tone: "subdued" });
    expect(goPanelLines(usage, 1400)[0]?.segments?.[0]).toEqual({ text: `${LIVE} ` });
    // Only the mark breathes: past its two cells the line is identical, and
    // the breath ignores the ticker frame entirely.
    expect(goPanelLines(usage, 0)[0]?.text.slice(2)).toBe(goPanelLines(usage, 1400)[0]?.text.slice(2));
    expect(goPanelLines(usage, 1400, undefined, 0)[0]?.text.slice(0, 2)).toBe(
      goPanelLines(usage, 1400, undefined, 99)[0]?.text.slice(0, 2),
    );
    // A custom cadence steps at its own rate...
    expect(markOf(0, { blinkMs: 200 })).toBe(`${REST} `);
    expect(markOf(200, { blinkMs: 200 })).toBe(`${MID} `);
    expect(markOf(400, { blinkMs: 200 })).toBe(`${LIVE} `);
    // ...while an unreadable one falls back to 700, never a throw.
    expect(markOf(700, { blinkMs: 50 })).toBe(`${MID} `);
  });

  test("drops the mark column entirely when blink is off", () => {
    const usage: GoUsage = { windows: [{ id: "5h", ratio: 0.5 }] };
    const lines = goPanelLines(usage, NOW, { blink: false });
    expect(lines[0]?.text).toBe(`${labelCell("rolling")}${bar(5)}${percentCell("50%")}`);
    // No wasted width: exactly the two mark cells narrower than the default.
    expect(lines[0]?.text.length).toBe((goPanelLines(usage, NOW)[0]?.text.length ?? 0) - 2);
    expect(lines[1]?.text).toBe(`${labelCell("weekly")}${track()}${percentCell(DASH)}`);
    // The resting lines drop it too.
    expect(goPanelLines(undefined, NOW, { blink: false })[0]?.text).toBe(
      `${labelCell("rolling")}${track()}${percentCell(DASH)}`,
    );
  });

  test("omits a column the look disables, never leaving a gap", () => {
    const usage: GoUsage = { windows: [{ id: "5h", ratio: 0.5, resetAtMs: NOW + 3_600_000 }] };
    expect(goPanelLines(usage, NOW, { percent: false })[0]?.text).toBe(
      `${firstMark()}${labelCell("rolling")}${bar(5)}${countdownCell("1h")}`,
    );
    expect(goPanelLines(usage, NOW, { reset: false })[0]?.text).toBe(
      `${firstMark()}${labelCell("rolling")}${bar(5)}${percentCell("50%")}`,
    );
    expect(goPanelLines(usage, NOW, { percent: false, reset: false })[0]?.text).toBe(
      `${firstMark()}${labelCell("rolling")}${bar(5)}`,
    );
    // The resting line drops its placeholder with the column.
    expect(goPanelLines(undefined, NOW, { percent: false })[0]?.text).toBe(
      `${firstMark()}${labelCell("rolling")}${track()}`,
    );
    // A malformed toggle falls back to drawn, never a throw.
    expect(goPanelLines(usage, NOW, { percent: "yes", reset: 0 })[0]?.text).toBe(
      `${firstMark()}${labelCell("rolling")}${bar(5)}${percentCell("50%")}${countdownCell("1h")}`,
    );
  });

  test("never throws on a hostile payload, and still returns three lines with no header", () => {
    const hostile: readonly unknown[] = [
      null,
      0,
      "x",
      [],
      { windows: null },
      { windows: [null, 3, "x"] },
      { windows: [{ id: "9h", ratio: 0.5 }] },
      { windows: [{ id: "5h", ratio: { get value() { throw new Error("x"); } } }] },
    ];
    for (const value of hostile) {
      const lines = goPanelLines(value as GoUsage, NOW);
      expect(lines).toHaveLength(3);
      // Past the two-cell mark column: the three lowercase labels.
      expect(lines.map((line) => line.text.slice(2, 6))).toEqual(["roll", "week", "mont"]);
    }

    const throwing = {
      get windows() {
        throw new Error("hostile");
      },
    };
    expect(() => goPanelLines(throwing as unknown as GoUsage, NOW)).not.toThrow();
    expect(goPanelLines(throwing as unknown as GoUsage, NOW).map((line) => line.text)).toEqual([
      `${firstMark()}${labelCell("rolling")}${track()}${percentCell(DASH)}`,
      `${OTHER_MARK}${labelCell("weekly")}${track()}${percentCell(DASH)}`,
      `${OTHER_MARK}${labelCell("monthly")}${track()}${percentCell(DASH)}`,
    ]);
  });

  test("fills the meter in proportion to the ratio, rounded to whole cells", () => {
    const text = (ratio: number) => goPanelLines({ windows: [{ id: "5h", ratio }] }, NOW)[0]?.text;
    expect(text(0)).toBe(`${firstMark()}${labelCell("rolling")}${bar(0)}${percentCell("0%")}`);
    expect(text(0.05)).toBe(`${firstMark()}${labelCell("rolling")}${bar(1)}${percentCell("5%")}`);
    expect(text(0.5)).toBe(`${firstMark()}${labelCell("rolling")}${bar(5)}${percentCell("50%")}`);
    expect(text(0.99)).toBe(`${firstMark()}${labelCell("rolling")}${bar(10)}${percentCell("99%")}`);
    expect(text(1)).toBe(`${firstMark()}${labelCell("rolling")}${bar(10)}${percentCell("100%")}`);
  });

  test("takes the warning role at 60% and the error role at 90%", () => {
    // Blink off isolates the tone under test from the mark's own dim ring.
    const tones = (ratio: number) =>
      (goPanelLines({ windows: [{ id: "5h", ratio }] }, NOW, { blink: false })[0]?.segments ?? []).map(
        (segment) => segment.tone,
      );

    // 60% is the warning band; below it the row keeps its own colour.
    expect(tones(0.6).some((tone) => tone === "warning")).toBe(true);
    expect(tones(0.6).some((tone) => tone === "error")).toBe(false);
    expect(tones(0.59).every((tone) => tone === undefined)).toBe(true);

    // 90% is the error band (./go-usage.js's GO_ERROR_RATIO), not warning.
    expect(tones(0.9).some((tone) => tone === "error")).toBe(true);
    expect(tones(0.9).some((tone) => tone === "warning")).toBe(false);
  });

  test("formats the countdown as one or two compact units", () => {
    expect(formatCompactRemaining(45_000)).toBe("45s");
    expect(formatCompactRemaining(90_000)).toBe("2m");
    expect(formatCompactRemaining(2 * 3_600_000)).toBe("2h");
    expect(formatCompactRemaining(4 * 3_600_000 + 44 * 60_000)).toBe("4h44m");
    expect(formatCompactRemaining(26 * 3_600_000)).toBe("1d2h");
    expect(formatCompactRemaining(86_400_000)).toBe("1d");
    expect(formatCompactRemaining(30 * 86_400_000 + 23 * 3_600_000)).toBe("30d23h");

    // And it reaches the line in its own dim column, right-aligned to 6.
    const line = goPanelLines(
      { windows: [{ id: "5h", ratio: 0.1, resetAtMs: NOW + 4 * 3_600_000 + 44 * 60_000 }] },
      NOW,
    )[0];
    expect(line?.text).toBe(`${firstMark()}${labelCell("rolling")}${bar(1)}${percentCell("10%")}${countdownCell("4h44m")}`);
  });

  test("keeps the meter static by default and sweeps only when opted in", () => {
    const usage: GoUsage = { windows: [{ id: "5h", ratio: 0.5 }] }; // filled 5 of 10

    // Static by default: even a live frame moves nothing.
    expect(staticBrightCell(usage, 0)).toBe(-1);
    expect(staticBrightCell(usage, 3)).toBe(-1);
    expect(goPanelLines(usage, NOW, undefined, 3)[0]?.text).toBe(
      `${firstMark()}${labelCell("rolling")}${bar(5)}${percentCell("50%")}`,
    );
    expect(goPanelLines(usage, NOW, { sweep: false }, 3)[0]?.segments?.some((s) => s.tone === "default")).toBe(
      false,
    );

    // Opted in: one bright cell travels the fill and wraps inside it.
    expect(brightCell(usage, 0)).toBe(0);
    expect(brightCell(usage, 1)).toBe(1);
    expect(brightCell(usage, 4)).toBe(4);
    expect(brightCell(usage, 5)).toBe(0); // wraps inside the fill

    // No frame (no ticker) and a 0% fill are both static, never a bright cell.
    expect(brightCell(usage)).toBe(-1);
    expect(brightCell({ windows: [{ id: "5h", ratio: 0 }] }, 3)).toBe(-1);

    // A malformed frame is treated as no animation, not a throw.
    expect(brightCell(usage, Number.NaN)).toBe(-1);
    expect(brightCell(usage, -1)).toBe(-1);

    // The text is unchanged by the sweep: only the colour of one cell moves.
    expect(goPanelLines(usage, NOW, { sweep: true }, 3)[0]?.text).toBe(
      `${firstMark()}${labelCell("rolling")}${bar(5)}${percentCell("50%")}`,
    );
  });

  test("keeps the empty track at the panel width in the placeholder", () => {
    const data = goPanelLines({ windows: [{ id: "5h", ratio: 0.5 }] }, NOW, { barWidth: 14 })[0];
    const rest = goPanelLines(undefined, NOW, { barWidth: 14 })[0];
    // The meter column is the same width whether or not there is a reading,
    // so the panel's shape never jumps. Past the mark, the label and its
    // separator first.
    expect(rest?.text.slice(0, 2 + 7 + 1 + 14)).toBe(`${firstMark()}${labelCell("rolling")}${track(14)}`);
    // 0.5 fills half the (wider) meter: 7 of 14 cells.
    expect(data?.text.slice(0, 2 + 7 + 1 + 14)).toBe(`${firstMark()}${labelCell("rolling")}${bar(7, 14)}`);
    expect(rest?.text).toBe(`${firstMark()}${labelCell("rolling")}${track(14)}${percentCell(DASH)}`);
  });

  test("renders a short, dim reason tag right after the label, on the first meter line only", () => {
    const lines = goPanelLines(undefined, NOW, undefined, undefined, "no-client");
    // The tag sits immediately after the label, before the track, so a narrow
    // sidebar can never clip it off the edge. The 10-cell track has no room
    // left for a 9-character tag, so it collapses away entirely.
    expect(lines[0]?.text).toBe(`${firstMark()}${labelCell("rolling")}no-client ${track(0)}${percentCell(DASH)}`);
    expect(lines[0]?.segments?.[0]).toEqual({ text: firstMark(), tone: "subdued" });
    expect(lines[0]?.segments?.[1]).toEqual({ text: labelCell("rolling") });
    expect(lines[0]?.segments?.[2]).toEqual({ text: "no-client ", tone: "subdued" });
    expect(lines[0]?.segments?.[3]).toEqual({ text: `${track(0)}${percentCell(DASH)}`, tone: "subdued" });
    // Tagged once, with no header: the other two lines stay plain.
    expect(lines).toHaveLength(3);
    expect(lines[1]?.text).toBe(`${OTHER_MARK}${labelCell("weekly")}${track()}${percentCell(DASH)}`);
    expect(lines[2]?.text).toBe(`${OTHER_MARK}${labelCell("monthly")}${track()}${percentCell(DASH)}`);

    // A reason is meaningless once a window rendered...
    expect(
      goPanelLines({ windows: [{ id: "5h", ratio: 0.2 }] }, NOW, undefined, undefined, "http")[0]?.text,
    ).toBe(`${firstMark()}${labelCell("rolling")}${bar(2)}${percentCell("20%")}`);
    // ...and a hostile tag is dropped rather than drawn.
    expect(goPanelLines(undefined, NOW, undefined, undefined, "not a reason!")[0]?.text).toBe(
      `${firstMark()}${labelCell("rolling")}${track()}${percentCell(DASH)}`,
    );
  });

  test("shortens the resting track by the tag so the line never grows past the meter column", () => {
    const plain = goPanelLines(undefined, NOW)[0]?.text ?? "";
    // A shorter tag leaves some track; a longer one leaves none.
    expect(goPanelLines(undefined, NOW, undefined, undefined, "http")[0]?.text).toBe(
      `${firstMark()}${labelCell("rolling")}http ${track(5)}${percentCell(DASH)}`,
    );
    expect(goPanelLines(undefined, NOW, undefined, undefined, "pending")[0]?.text).toBe(
      `${firstMark()}${labelCell("rolling")}pending ${track(2)}${percentCell(DASH)}`,
    );
    // A tag nearly as wide as the column collapses the track to a stub.
    expect(goPanelLines(undefined, NOW, undefined, undefined, "no-client")[0]?.text).toBe(
      `${firstMark()}${labelCell("rolling")}no-client ${track(0)}${percentCell(DASH)}`,
    );

    for (const reason of ["http", "pending", "no-client", "timeout", "no-bridge"]) {
      const line = goPanelLines(undefined, NOW, undefined, undefined, reason)[0]?.text ?? "";
      expect(line.length).toBeLessThanOrEqual(plain.length);
      expect(line).toContain(reason);
    }
  });

  test("keeps every line within the sidebar width budget", () => {
    const usages: readonly (GoUsage | undefined)[] = [
      undefined,
      { windows: [] },
      { windows: [{ id: "5h", ratio: 0.03, resetAtMs: NOW + 4 * 3_600_000 + 44 * 60_000 }] },
      { windows: [{ id: "1w", ratio: 0.01, resetAtMs: NOW + 30 * 60_000 }] },
      {
        windows: [
          { id: "5h", ratio: 1, resetAtMs: NOW + 4 * 3_600_000 + 44 * 60_000 },
          { id: "1w", ratio: 0.65, resetAtMs: NOW + 26 * 3_600_000 },
          { id: "1m", ratio: 0.95, resetAtMs: NOW + 30 * 86_400_000 + 23 * 3_600_000 },
        ],
      },
    ];
    for (const usage of usages) {
      for (const line of goPanelLines(usage, NOW, undefined, 3, "no-client")) {
        expect(line.text.length).toBeLessThanOrEqual(WIDTH_BUDGET);
      }
      for (const line of goPanelLines(usage, NOW, { header: true, sweep: true }, 3, "no-client")) {
        expect(line.text.length).toBeLessThanOrEqual(WIDTH_BUDGET);
      }
      // A long rename still fits: the column widens and the bar caps instead.
      for (const line of goPanelLines(usage, NOW, { labels: { monthly: "a-much-longer-name" } })) {
        expect(line.text.length).toBeLessThanOrEqual(WIDTH_BUDGET);
      }
    }
    // Even a hostile bar width never overflows: it is capped to the sidebar.
    for (const line of goPanelLines({ windows: [{ id: "5h", ratio: 1 }] }, NOW, { barWidth: 40 })) {
      expect(line.text.length).toBeLessThanOrEqual(WIDTH_BUDGET);
    }
    for (const line of goPanelLines({ windows: [{ id: "5h", ratio: 1 }] }, NOW, { barWidth: 40, labelWidth: 24 })) {
      expect(line.text.length).toBeLessThanOrEqual(WIDTH_BUDGET);
    }
  });
});
