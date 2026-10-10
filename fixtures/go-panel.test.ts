import { describe, expect, test } from "bun:test";
import { formatCompactRemaining, goPanelLines } from "../src/tui/go-panel.js";
import type { GoUsage } from "../src/tui/go-usage.js";
import { DEFAULT_BAR_WIDTH } from "../src/tui/format.js";
import { DEFAULT_LABEL_WIDTH, DEFAULT_PLACEHOLDER } from "../src/tui/stat-fields.js";

// The panel's glyphs are written as escapes so this file stays ASCII: the em
// dash is the shipped placeholder, and the bar cells are the panel's own
// heavy/light rule.
const DASH = "\u2014";
const DOT = "\u00B7";
const FULL = "\u2501";
const EMPTY = "\u2500";

/** The exact bar `fuelBar` draws, built here so the expectation is explicit. */
function bar(filled: number, width: number = DEFAULT_BAR_WIDTH): string {
  return `${FULL.repeat(filled)}${EMPTY.repeat(width - filled)}`;
}

/** The empty track the resting placeholder keeps. */
function track(width: number = DEFAULT_BAR_WIDTH): string {
  return EMPTY.repeat(width);
}

/**
 * The filled-cell index of the panel's bright sweep cell on the first line, or
 * `-1` when there is none. Counts `FULL` cells before the run toned `default`.
 */
function brightCell(usage: GoUsage, frame?: number): number {
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
  test("renders exactly three lines in the canonical order, labelled", () => {
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
      `Rolling   ${bar(2)} 20%`,
      `Weekly    ${bar(8)} 80%`,
      `Monthly   ${bar(0)} 4%`,
    ]);
    // Every line carries the `go` field name, so the footer resolves the same
    // row style the inline `go` row does.
    expect(lines.map((line) => line.field)).toEqual(["go", "go", "go"]);
    // The plain text is exactly the join of the coloured runs.
    for (const line of lines) {
      expect(line.text).toBe((line.segments ?? []).map((segment) => segment.text).join(""));
    }
  });

  test("draws a whole-number percent beside the bar", () => {
    // 1/3 rounds to 33, and the bar fills three of ten cells (3.33 -> 3).
    const lines = goPanelLines({ windows: [{ id: "5h", ratio: 1 / 3 }] }, NOW);
    expect(lines[0]?.text).toBe(`Rolling   ${bar(3)} 33%`);
  });

  test("adds a reset countdown whenever the reset is a known future instant", () => {
    const hours = goPanelLines({ windows: [{ id: "5h", ratio: 0.95, resetAtMs: NOW + 2 * 3_600_000 }] }, NOW);
    expect(hours[0]?.text).toBe(`Rolling   ${bar(10)} 95% ${DOT} 2h`);

    const minutes = goPanelLines({ windows: [{ id: "1w", ratio: 0.1, resetAtMs: NOW + 90_000 }] }, NOW);
    expect(minutes[1]?.text).toBe(`Weekly    ${bar(1)} 10% ${DOT} 2m`);

    const seconds = goPanelLines({ windows: [{ id: "1m", ratio: 0.1, resetAtMs: NOW + 5_000 }] }, NOW);
    expect(seconds[2]?.text).toBe(`Monthly   ${bar(1)} 10% ${DOT} 5s`);

    // A CALM window still gets its countdown: unlike the one-line `go` row,
    // the panel has a line per window, so the time to relief is not noise.
    const calm = goPanelLines({ windows: [{ id: "1w", ratio: 0.5, resetAtMs: NOW + 3_600_000 }] }, NOW);
    expect(calm[1]?.text).toBe(`Weekly    ${bar(5)} 50% ${DOT} 1h`);
  });

  test("omits the countdown when the reset is unknown or already past", () => {
    const past = goPanelLines({ windows: [{ id: "5h", ratio: 0.95, resetAtMs: NOW - 1 }] }, NOW);
    expect(past[0]?.text).toBe(`Rolling   ${bar(10)} 95%`);

    const unknown = goPanelLines({ windows: [{ id: "5h", ratio: 0.95 }] }, NOW);
    expect(unknown[0]?.text).toBe(`Rolling   ${bar(10)} 95%`);

    const garbage = goPanelLines({ windows: [{ id: "5h", ratio: 0.95, resetAtMs: Number.NaN }] }, NOW);
    expect(garbage[0]?.text).toBe(`Rolling   ${bar(10)} 95%`);

    // Exactly at the reset instant is "already past": remaining is not > 0.
    const exactly = goPanelLines({ windows: [{ id: "5h", ratio: 0.95, resetAtMs: NOW }] }, NOW);
    expect(exactly[0]?.text).toBe(`Rolling   ${bar(10)} 95%`);
  });

  test("tones only a flagged window's bar, percent and countdown", () => {
    const usage: GoUsage = {
      windows: [
        { id: "5h", ratio: 0.95, resetAtMs: NOW + 3_600_000 },
        { id: "1w", ratio: 0.5 },
      ],
    };
    const lines = goPanelLines(usage, NOW);
    const flagged = lines[0]?.segments ?? [];
    // The label keeps the line's own colour; the value runs take the error tone.
    expect(flagged.map((segment) => segment.tone)).toEqual([undefined, "error", "error"]);
    expect(flagged[0]).toEqual({ text: "Rolling   " });
    expect(flagged[1]).toEqual({ text: `${bar(10)} 95%`, tone: "error" });
    expect(flagged[2]).toEqual({ text: ` ${DOT} 1h`, tone: "error" });

    // The healthy neighbour is untouched, so the panel reads as one instrument
    // with a problem rather than as a different kind of line.
    expect((lines[1]?.segments ?? []).every((segment) => segment.tone === undefined)).toBe(true);
    expect(lines[1]?.text).toBe(`Weekly    ${bar(5)} 50%`);
  });

  test("flags a window reporting a non-ok status, even at a calm ratio", () => {
    const throttled = goPanelLines({ windows: [{ id: "1m", ratio: 0.1, status: "throttled" }] }, NOW);
    expect(throttled[2]?.segments?.some((segment) => segment.tone === "error")).toBe(true);

    const ok = goPanelLines({ windows: [{ id: "1m", ratio: 0.1, status: "ok" }] }, NOW);
    expect(ok[2]?.segments?.every((segment) => segment.tone === undefined)).toBe(true);
  });

  test("renders the same three lines as a dim resting placeholder with no usage", () => {
    const lines = goPanelLines(undefined, NOW);
    expect(lines).toHaveLength(3);
    expect(lines.map((line) => line.text)).toEqual([
      `Rolling   ${track()} ${DASH}`,
      `Weekly    ${track()} ${DASH}`,
      `Monthly   ${track()} ${DASH}`,
    ]);
    // The resting value is explicitly subdued: it stays dim even when the row
    // style is set bright, because it is not a reading. The empty track is kept
    // so the panel's shape never jumps between waiting and reading.
    expect(lines[0]?.segments?.[1]).toEqual({ text: `${track()} ${DASH}`, tone: "subdued" });
    expect(lines[0]?.segments?.[0]).toEqual({ text: "Rolling   " });

    // An empty window list is the same resting panel.
    expect(goPanelLines({ windows: [] }, NOW).map((line) => line.text)).toEqual(
      lines.map((line) => line.text),
    );

    // A window with no readable ratio keeps its line, drawing an empty bar and
    // the placeholder: a count with no known limit is not a percent.
    expect(goPanelLines({ windows: [{ id: "5h" }] }, NOW)[0]?.text).toBe(`Rolling   ${bar(0)} ${DASH}`);
  });

  test("clamps a ratio above one and drops a ratio that is not a reading", () => {
    const hot = goPanelLines({ windows: [{ id: "5h", ratio: 1.5 }] }, NOW);
    expect(hot[0]?.text).toBe(`Rolling   ${bar(10)} 100%`);

    const ratios: readonly unknown[] = [-0.2, Number.NaN, Number.POSITIVE_INFINITY, "0.5"];
    for (const ratio of ratios) {
      const lines = goPanelLines({ windows: [{ id: "5h", ratio }] } as GoUsage, NOW);
      expect(lines[0]?.text).toBe(`Rolling   ${bar(0)} ${DASH}`);
    }

    // A legitimate zero is a reading: an empty bar and 0%.
    expect(goPanelLines({ windows: [{ id: "5h", ratio: 0 }] }, NOW)[0]?.text).toBe(`Rolling   ${bar(0)} 0%`);
  });

  test("honours the rail's geometry and falls back on a malformed hint", () => {
    const usage: GoUsage = { windows: [{ id: "5h", ratio: 0.5 }] };
    // A label column narrower than "Rolling" still gets its separator, so the
    // value can never be glued onto the label.
    expect(goPanelLines(usage, NOW, { labelWidth: 6, barWidth: 4 })[0]?.text).toBe(
      `Rolling ${bar(2, 4)} 50%`,
    );
    expect(goPanelLines(undefined, NOW, { labelWidth: 6 })[2]?.text).toBe(`Monthly ${track()} ${DASH}`);

    // Anything unreadable is the rail's own default, never a broken line.
    const defaults = `Rolling   ${bar(2)} 20%`;
    const wide = goPanelLines({ windows: [{ id: "5h", ratio: 0.2 }] }, NOW);
    expect(wide[0]?.text).toBe(defaults);
    expect(goPanelLines({ windows: [{ id: "5h", ratio: 0.2 }] }, NOW, "nope")[0]?.text).toBe(defaults);
    expect(goPanelLines({ windows: [{ id: "5h", ratio: 0.2 }] }, NOW, { barWidth: "big" })[0]?.text).toBe(
      defaults,
    );
    expect(goPanelLines({ windows: [{ id: "5h", ratio: 0.2 }] }, NOW, { labelWidth: -3 })[0]?.text).toBe(
      defaults,
    );
    expect(DEFAULT_LABEL_WIDTH).toBe(10);
    expect(DEFAULT_BAR_WIDTH).toBe(10);
    expect(DEFAULT_PLACEHOLDER).toBe(DASH);
  });

  test("never throws on a hostile payload, and still returns three lines", () => {
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
      expect(lines.map((line) => line.text.slice(0, 7))).toEqual(["Rolling", "Weekly ", "Monthly"]);
    }

    const throwing = {
      get windows() {
        throw new Error("hostile");
      },
    };
    expect(() => goPanelLines(throwing as unknown as GoUsage, NOW)).not.toThrow();
    expect(goPanelLines(throwing as unknown as GoUsage, NOW).map((line) => line.text)).toEqual([
      `Rolling   ${track()} ${DASH}`,
      `Weekly    ${track()} ${DASH}`,
      `Monthly   ${track()} ${DASH}`,
    ]);
  });

  test("fills the bar in proportion to the ratio, rounded to whole cells", () => {
    const text = (ratio: number) => goPanelLines({ windows: [{ id: "5h", ratio }] }, NOW)[0]?.text;
    expect(text(0)).toBe(`Rolling   ${bar(0)} 0%`);
    expect(text(0.04)).toBe(`Rolling   ${bar(0)} 4%`);
    expect(text(0.05)).toBe(`Rolling   ${bar(1)} 5%`);
    expect(text(0.5)).toBe(`Rolling   ${bar(5)} 50%`);
    expect(text(0.99)).toBe(`Rolling   ${bar(10)} 99%`);
    expect(text(1)).toBe(`Rolling   ${bar(10)} 100%`);
  });

  test("takes the warning role at 60% and the error role at 90%", () => {
    const tones = (ratio: number) =>
      (goPanelLines({ windows: [{ id: "5h", ratio }] }, NOW)[0]?.segments ?? []).map((segment) => segment.tone);

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

    // And it reaches the line with the row's own separator.
    const line = goPanelLines(
      { windows: [{ id: "5h", ratio: 0.1, resetAtMs: NOW + 4 * 3_600_000 + 44 * 60_000 }] },
      NOW,
    )[0];
    expect(line?.text).toBe(`Rolling   ${bar(1)} 10% ${DOT} 4h44m`);
  });

  test("sweeps one bright cell across the filled region, and only with a fill", () => {
    const usage: GoUsage = { windows: [{ id: "5h", ratio: 0.5 }] }; // filled 5 of 10

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
    expect(goPanelLines(usage, NOW, undefined, 3)[0]?.text).toBe(`Rolling   ${bar(5)} 50%`);
  });

  test("keeps the empty track at the rail's width in the placeholder", () => {
    const data = goPanelLines({ windows: [{ id: "5h", ratio: 0.5 }] }, NOW, { barWidth: 14 })[0];
    const rest = goPanelLines(undefined, NOW, { barWidth: 14 })[0];
    // The bar column is the same width whether or not there is a reading, so
    // the panel's shape never jumps.
    expect(rest?.text.slice(0, 10 + 14)).toBe(`Rolling   ${track(14)}`);
    // 0.5 fills half the (wider) bar: 7 of 14 cells.
    expect(data?.text.slice(0, 10 + 14)).toBe(`Rolling   ${bar(7, 14)}`);
    expect(rest?.text).toBe(`Rolling   ${track(14)} ${DASH}`);
  });

  test("renders a short, dim reason tag right after the label, on the first line only", () => {
    const lines = goPanelLines(undefined, NOW, undefined, undefined, "no-client");
    // The tag sits immediately after the label, before the track, so a narrow
    // sidebar can never clip it off the edge.
    expect(lines[0]?.text).toBe(`Rolling   no-client ${DASH}`);
    expect(lines[0]?.segments?.[0]).toEqual({ text: "Rolling   " });
    expect(lines[0]?.segments?.[1]).toEqual({ text: "no-client ", tone: "subdued" });
    expect(lines[0]?.segments?.[2]).toEqual({ text: `${DASH}`, tone: "subdued" });
    // Tagged once: the other two lines stay plain.
    expect(lines[1]?.text).toBe(`Weekly    ${track()} ${DASH}`);
    expect(lines[2]?.text).toBe(`Monthly   ${track()} ${DASH}`);

    // A reason is meaningless once a window rendered...
    expect(
      goPanelLines({ windows: [{ id: "5h", ratio: 0.2 }] }, NOW, undefined, undefined, "http")[0]?.text,
    ).toBe(`Rolling   ${bar(2)} 20%`);
    // ...and a hostile tag is dropped rather than drawn.
    expect(goPanelLines(undefined, NOW, undefined, undefined, "not a reason!")[0]?.text).toBe(
      `Rolling   ${track()} ${DASH}`,
    );
  });

  test("shortens the resting track by the tag so the line never grows past the bar column", () => {
    const plain = goPanelLines(undefined, NOW)[0]?.text ?? "";
    // A shorter tag leaves some track; a longer one leaves none.
    expect(goPanelLines(undefined, NOW, undefined, undefined, "http")[0]?.text).toBe(
      `Rolling   http ${track(5)} ${DASH}`,
    );
    expect(goPanelLines(undefined, NOW, undefined, undefined, "pending")[0]?.text).toBe(
      `Rolling   pending ${track(2)} ${DASH}`,
    );
    // A tag as wide as the column collapses the track to the placeholder alone.
    expect(goPanelLines(undefined, NOW, undefined, undefined, "no-client")[0]?.text).toBe(
      `Rolling   no-client ${DASH}`,
    );

    for (const reason of ["http", "pending", "no-client", "timeout", "no-bridge"]) {
      const line = goPanelLines(undefined, NOW, undefined, undefined, reason)[0]?.text ?? "";
      expect(line.length).toBeLessThanOrEqual(plain.length);
      expect(line).toContain(reason);
    }
  });
});
