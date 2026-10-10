import { describe, expect, test } from "bun:test";
import { formatCompactRemaining, goPanelLines } from "../src/tui/go-panel.js";
import type { GoUsage } from "../src/tui/go-usage.js";

// Every glyph is an escape so this file stays ASCII: the em dash is the
// shipped placeholder, the diamond is the header mark, and the bar cells are
// the panel's own heavy/light rule.
const DASH = "\u2014";
const DIAMOND = "\u25C8";
const FULL = "\u2501";
const EMPTY = "\u2500";

/** The panel's default meter width. */
const PANEL_BAR = 14;
/** The sidebar width budget: no line may draw past it. */
const WIDTH_BUDGET = 40;

/** One label cell: leading space, the label padded to 5, two-space gap. */
function labelCell(label: string): string {
  return ` ${label.padEnd(5)}  `;
}

/** The exact meter `goPanelLines` draws, built here so the expectation is explicit. */
function bar(filled: number, width: number = PANEL_BAR): string {
  return `${FULL.repeat(filled)}${EMPTY.repeat(width - filled)}`;
}

/** The empty track the resting placeholder keeps. */
function track(width: number = PANEL_BAR): string {
  return EMPTY.repeat(width);
}

/** Right-aligned percent column: two-space gap plus the value padded to 4. */
function percentCell(value: string): string {
  return `  ${value.padStart(4)}`;
}

/** Dim countdown column: two-space gap plus the compact time. */
function countdownCell(time: string): string {
  return `  ${time}`;
}

const HEADER = ` ${DIAMOND} OPENCODE GO`;

/**
 * The filled-cell index of the panel's bright sweep cell on the first meter
 * line, or `-1` when there is none. Counts `FULL` cells before the run toned
 * `default`. Index 0 is the header, so the first meter line is index 1.
 */
function brightCell(usage: GoUsage, frame?: number): number {
  const segments = goPanelLines(usage, NOW, undefined, frame)[1]?.segments ?? [];
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
  test("renders a dim header plus exactly three lines in the canonical order, labelled", () => {
    // Deliberately out of order in the payload: the panel's order is its own.
    const usage: GoUsage = {
      windows: [
        { id: "1m", ratio: 0.04 },
        { id: "5h", ratio: 0.2 },
        { id: "1w", ratio: 0.8 },
      ],
    };
    const lines = goPanelLines(usage, NOW);
    expect(lines).toHaveLength(4);
    expect(lines[0]?.text).toBe(HEADER);
    expect(lines[0]?.segments).toEqual([{ text: HEADER, tone: "subdued" }]);
    expect(lines[0]?.field).toBe("go");
    expect(lines.map((line) => line.text)).toEqual([
      HEADER,
      `${labelCell("ROLL")}${bar(3)}${percentCell("20%")}`,
      `${labelCell("WEEK")}${bar(11)}${percentCell("80%")}`,
      `${labelCell("MONTH")}${bar(1)}${percentCell("4%")}`,
    ]);
    // Every line carries the `go` field name, so the footer resolves the same
    // row style the inline `go` row does.
    expect(lines.map((line) => line.field)).toEqual(["go", "go", "go", "go"]);
    // The plain text is exactly the join of the coloured runs.
    for (const line of lines) {
      expect(line.text).toBe((line.segments ?? []).map((segment) => segment.text).join(""));
    }
  });

  test("draws a whole-number percent beside the meter, right-aligned", () => {
    // 1/3 rounds to 33, and the meter fills five of fourteen cells (4.67 -> 5).
    const lines = goPanelLines({ windows: [{ id: "5h", ratio: 1 / 3 }] }, NOW);
    expect(lines[1]?.text).toBe(`${labelCell("ROLL")}${bar(5)}${percentCell("33%")}`);
    // Single digits sit in the same column: the percent is padded to width 4.
    expect(goPanelLines({ windows: [{ id: "5h", ratio: 0.04 }] }, NOW)[1]?.text).toBe(
      `${labelCell("ROLL")}${bar(1)}${percentCell("4%")}`,
    );
    // Three digits fill the column with no padding.
    expect(goPanelLines({ windows: [{ id: "5h", ratio: 1 }] }, NOW)[1]?.text).toBe(
      `${labelCell("ROLL")}${bar(14)}${percentCell("100%")}`,
    );
  });

  test("adds a dim reset countdown whenever the reset is a known future instant", () => {
    const hours = goPanelLines({ windows: [{ id: "5h", ratio: 0.2, resetAtMs: NOW + 2 * 3_600_000 }] }, NOW);
    expect(hours[1]?.text).toBe(`${labelCell("ROLL")}${bar(3)}${percentCell("20%")}${countdownCell("2h")}`);

    const minutes = goPanelLines({ windows: [{ id: "1w", ratio: 0.1, resetAtMs: NOW + 90_000 }] }, NOW);
    expect(minutes[2]?.text).toBe(`${labelCell("WEEK")}${bar(1)}${percentCell("10%")}${countdownCell("2m")}`);

    const seconds = goPanelLines({ windows: [{ id: "1m", ratio: 0.1, resetAtMs: NOW + 5_000 }] }, NOW);
    expect(seconds[3]?.text).toBe(`${labelCell("MONTH")}${bar(1)}${percentCell("10%")}${countdownCell("5s")}`);

    // A CALM window still gets its countdown: unlike the one-line `go` row,
    // the panel has a line per window, so the time to relief is not noise.
    const calm = goPanelLines({ windows: [{ id: "1w", ratio: 0.5, resetAtMs: NOW + 3_600_000 }] }, NOW);
    expect(calm[2]?.text).toBe(`${labelCell("WEEK")}${bar(7)}${percentCell("50%")}${countdownCell("1h")}`);

    // The countdown is always the dim column, even beside a flagged meter.
    const flagged = goPanelLines(
      { windows: [{ id: "5h", ratio: 0.95, resetAtMs: NOW + 3_600_000 }] },
      NOW,
    )[1]?.segments;
    expect(flagged?.[flagged.length - 1]).toEqual({ text: countdownCell("1h"), tone: "subdued" });
  });

  test("omits the countdown when the reset is unknown or already past", () => {
    const past = goPanelLines({ windows: [{ id: "5h", ratio: 0.2, resetAtMs: NOW - 1 }] }, NOW);
    expect(past[1]?.text).toBe(`${labelCell("ROLL")}${bar(3)}${percentCell("20%")}`);

    const unknown = goPanelLines({ windows: [{ id: "5h", ratio: 0.2 }] }, NOW);
    expect(unknown[1]?.text).toBe(`${labelCell("ROLL")}${bar(3)}${percentCell("20%")}`);

    const garbage = goPanelLines({ windows: [{ id: "5h", ratio: 0.2, resetAtMs: Number.NaN }] }, NOW);
    expect(garbage[1]?.text).toBe(`${labelCell("ROLL")}${bar(3)}${percentCell("20%")}`);

    // Exactly at the reset instant is "already past": remaining is not > 0.
    const exactly = goPanelLines({ windows: [{ id: "5h", ratio: 0.2, resetAtMs: NOW }] }, NOW);
    expect(exactly[1]?.text).toBe(`${labelCell("ROLL")}${bar(3)}${percentCell("20%")}`);
  });

  test("tones only a flagged window's meter and percent, keeping the countdown dim", () => {
    const usage: GoUsage = {
      windows: [
        { id: "5h", ratio: 0.95, resetAtMs: NOW + 3_600_000 },
        { id: "1w", ratio: 0.5 },
      ],
    };
    const lines = goPanelLines(usage, NOW);
    const flagged = lines[1]?.segments ?? [];
    // The label keeps the line's own colour; the meter and percent take the
    // error tone; the countdown stays the dim relief column.
    expect(flagged.map((segment) => segment.tone)).toEqual([undefined, "error", "subdued"]);
    expect(flagged[0]).toEqual({ text: labelCell("ROLL") });
    expect(flagged[1]).toEqual({ text: `${bar(13)}${percentCell("95%")}`, tone: "error" });
    expect(flagged[2]).toEqual({ text: countdownCell("1h"), tone: "subdued" });

    // The healthy neighbour is untouched apart from its (absent) countdown,
    // so the panel reads as one instrument with a problem.
    expect((lines[2]?.segments ?? []).every((segment) => segment.tone === undefined)).toBe(true);
    expect(lines[2]?.text).toBe(`${labelCell("WEEK")}${bar(7)}${percentCell("50%")}`);
  });

  test("flags a window reporting a non-ok status, even at a calm ratio", () => {
    const throttled = goPanelLines({ windows: [{ id: "1m", ratio: 0.1, status: "throttled" }] }, NOW);
    expect(throttled[3]?.segments?.some((segment) => segment.tone === "error")).toBe(true);

    const ok = goPanelLines({ windows: [{ id: "1m", ratio: 0.1, status: "ok" }] }, NOW);
    expect(ok[3]?.segments?.every((segment) => segment.tone === undefined)).toBe(true);
  });

  test("renders the header plus three dim resting lines with no usage", () => {
    const lines = goPanelLines(undefined, NOW);
    expect(lines).toHaveLength(4);
    expect(lines.map((line) => line.text)).toEqual([
      HEADER,
      `${labelCell("ROLL")}${track()}${percentCell(DASH)}`,
      `${labelCell("WEEK")}${track()}${percentCell(DASH)}`,
      `${labelCell("MONTH")}${track()}${percentCell(DASH)}`,
    ]);
    // The resting value is explicitly subdued: it stays dim even when the row
    // style is set bright, because it is not a reading. The empty track is
    // kept so the panel's shape never jumps between waiting and reading.
    expect(lines[1]?.segments?.[1]).toEqual({ text: `${track()}${percentCell(DASH)}`, tone: "subdued" });
    expect(lines[1]?.segments?.[0]).toEqual({ text: labelCell("ROLL") });

    // An empty window list is the same resting panel, header included.
    expect(goPanelLines({ windows: [] }, NOW).map((line) => line.text)).toEqual(
      lines.map((line) => line.text),
    );

    // A window with no readable ratio keeps its line, drawing an empty meter
    // and the placeholder: a count with no known limit is not a percent.
    expect(goPanelLines({ windows: [{ id: "5h" }] }, NOW)[1]?.text).toBe(
      `${labelCell("ROLL")}${bar(0)}${percentCell(DASH)}`,
    );
  });

  test("clamps a ratio above one and drops a ratio that is not a reading", () => {
    const hot = goPanelLines({ windows: [{ id: "5h", ratio: 1.5 }] }, NOW);
    expect(hot[1]?.text).toBe(`${labelCell("ROLL")}${bar(14)}${percentCell("100%")}`);

    const ratios: readonly unknown[] = [-0.2, Number.NaN, Number.POSITIVE_INFINITY, "0.5"];
    for (const ratio of ratios) {
      const lines = goPanelLines({ windows: [{ id: "5h", ratio }] } as GoUsage, NOW);
      expect(lines[1]?.text).toBe(`${labelCell("ROLL")}${bar(0)}${percentCell(DASH)}`);
    }

    // A legitimate zero is a reading: an empty meter and 0%.
    expect(goPanelLines({ windows: [{ id: "5h", ratio: 0 }] }, NOW)[1]?.text).toBe(
      `${labelCell("ROLL")}${bar(0)}${percentCell("0%")}`,
    );
  });

  test("honours the bar width and falls back on a malformed hint, capped to the sidebar", () => {
    const usage: GoUsage = { windows: [{ id: "5h", ratio: 0.5 }] };
    // The short labels keep their own column: the rail's label width is not
    // honoured, so the instrument never wastes the sidebar on padding.
    expect(goPanelLines(usage, NOW, { labelWidth: 6, barWidth: 4 })[1]?.text).toBe(
      `${labelCell("ROLL")}${bar(2, 4)}${percentCell("50%")}`,
    );
    expect(goPanelLines(undefined, NOW, { labelWidth: 6 })[3]?.text).toBe(
      `${labelCell("MONTH")}${track()}${percentCell(DASH)}`,
    );

    // Anything unreadable is the panel's own default, never a broken line.
    const defaults = `${labelCell("ROLL")}${bar(3)}${percentCell("20%")}`;
    const wide = goPanelLines({ windows: [{ id: "5h", ratio: 0.2 }] }, NOW);
    expect(wide[1]?.text).toBe(defaults);
    expect(goPanelLines({ windows: [{ id: "5h", ratio: 0.2 }] }, NOW, "nope")[1]?.text).toBe(defaults);
    expect(goPanelLines({ windows: [{ id: "5h", ratio: 0.2 }] }, NOW, { barWidth: "big" })[1]?.text).toBe(
      defaults,
    );
    expect(goPanelLines({ windows: [{ id: "5h", ratio: 0.2 }] }, NOW, { barWidth: -3 })[1]?.text).toBe(
      defaults,
    );

    // A wider meter is honoured while it fits the sidebar...
    expect(goPanelLines(usage, NOW, { barWidth: 14 })[1]?.text).toBe(
      `${labelCell("ROLL")}${bar(7, 14)}${percentCell("50%")}`,
    );
    // ...and capped instead of overflowing it.
    const capped = goPanelLines(
      { windows: [{ id: "5h", ratio: 1, resetAtMs: NOW + 30 * 86_400_000 + 23 * 3_600_000 }] },
      NOW,
      { barWidth: 40 },
    );
    expect(capped[1]?.text).toBe(
      `${labelCell("ROLL")}${bar(18, 18)}${percentCell("100%")}${countdownCell("30d23h")}`,
    );
    expect(capped[1]?.text.length).toBeLessThanOrEqual(WIDTH_BUDGET);
  });

  test("never throws on a hostile payload, and still returns the header plus three lines", () => {
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
      expect(lines).toHaveLength(4);
      expect(lines[0]?.text).toBe(HEADER);
      expect(lines.slice(1).map((line) => line.text.slice(0, 5))).toEqual([" ROLL", " WEEK", " MONT"]);
    }

    const throwing = {
      get windows() {
        throw new Error("hostile");
      },
    };
    expect(() => goPanelLines(throwing as unknown as GoUsage, NOW)).not.toThrow();
    expect(goPanelLines(throwing as unknown as GoUsage, NOW).map((line) => line.text)).toEqual([
      HEADER,
      `${labelCell("ROLL")}${track()}${percentCell(DASH)}`,
      `${labelCell("WEEK")}${track()}${percentCell(DASH)}`,
      `${labelCell("MONTH")}${track()}${percentCell(DASH)}`,
    ]);
  });

  test("fills the meter in proportion to the ratio, rounded to whole cells", () => {
    const text = (ratio: number) => goPanelLines({ windows: [{ id: "5h", ratio }] }, NOW)[1]?.text;
    expect(text(0)).toBe(`${labelCell("ROLL")}${bar(0)}${percentCell("0%")}`);
    expect(text(0.04)).toBe(`${labelCell("ROLL")}${bar(1)}${percentCell("4%")}`);
    expect(text(0.05)).toBe(`${labelCell("ROLL")}${bar(1)}${percentCell("5%")}`);
    expect(text(0.5)).toBe(`${labelCell("ROLL")}${bar(7)}${percentCell("50%")}`);
    expect(text(0.99)).toBe(`${labelCell("ROLL")}${bar(14)}${percentCell("99%")}`);
    expect(text(1)).toBe(`${labelCell("ROLL")}${bar(14)}${percentCell("100%")}`);
  });

  test("takes the warning role at 60% and the error role at 90%", () => {
    const tones = (ratio: number) =>
      (goPanelLines({ windows: [{ id: "5h", ratio }] }, NOW)[1]?.segments ?? []).map((segment) => segment.tone);

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

    // And it reaches the line in its own dim column.
    const line = goPanelLines(
      { windows: [{ id: "5h", ratio: 0.1, resetAtMs: NOW + 4 * 3_600_000 + 44 * 60_000 }] },
      NOW,
    )[1];
    expect(line?.text).toBe(`${labelCell("ROLL")}${bar(1)}${percentCell("10%")}${countdownCell("4h44m")}`);
  });

  test("sweeps one bright cell across the filled region, and only with a fill", () => {
    const usage: GoUsage = { windows: [{ id: "5h", ratio: 0.5 }] }; // filled 7 of 14

    expect(brightCell(usage, 0)).toBe(0);
    expect(brightCell(usage, 1)).toBe(1);
    expect(brightCell(usage, 6)).toBe(6);
    expect(brightCell(usage, 7)).toBe(0); // wraps inside the fill

    // No frame (no ticker) and a 0% fill are both static, never a bright cell.
    expect(brightCell(usage)).toBe(-1);
    expect(brightCell({ windows: [{ id: "5h", ratio: 0 }] }, 3)).toBe(-1);

    // A malformed frame is treated as no animation, not a throw.
    expect(brightCell(usage, Number.NaN)).toBe(-1);
    expect(brightCell(usage, -1)).toBe(-1);

    // The text is unchanged by the sweep: only the colour of one cell moves.
    expect(goPanelLines(usage, NOW, undefined, 3)[1]?.text).toBe(
      `${labelCell("ROLL")}${bar(7)}${percentCell("50%")}`,
    );
  });

  test("keeps the empty track at the panel width in the placeholder", () => {
    const data = goPanelLines({ windows: [{ id: "5h", ratio: 0.5 }] }, NOW, { barWidth: 14 })[1];
    const rest = goPanelLines(undefined, NOW, { barWidth: 14 })[1];
    // The meter column is the same width whether or not there is a reading,
    // so the panel's shape never jumps.
    expect(rest?.text.slice(0, 8 + 14)).toBe(`${labelCell("ROLL")}${track(14)}`);
    // 0.5 fills half the (wider) meter: 7 of 14 cells.
    expect(data?.text.slice(0, 8 + 14)).toBe(`${labelCell("ROLL")}${bar(7, 14)}`);
    expect(rest?.text).toBe(`${labelCell("ROLL")}${track(14)}${percentCell(DASH)}`);
  });

  test("renders a short, dim reason tag right after the label, on the first meter line only", () => {
    const lines = goPanelLines(undefined, NOW, undefined, undefined, "no-client");
    // The tag sits immediately after the label, before the track, so a narrow
    // sidebar can never clip it off the edge.
    expect(lines[1]?.text).toBe(`${labelCell("ROLL")}no-client ${track(4)}${percentCell(DASH)}`);
    expect(lines[1]?.segments?.[0]).toEqual({ text: labelCell("ROLL") });
    expect(lines[1]?.segments?.[1]).toEqual({ text: "no-client ", tone: "subdued" });
    expect(lines[1]?.segments?.[2]).toEqual({ text: `${track(4)}${percentCell(DASH)}`, tone: "subdued" });
    // Tagged once: the header stays plain and the other two lines stay plain.
    expect(lines[0]?.text).toBe(HEADER);
    expect(lines[2]?.text).toBe(`${labelCell("WEEK")}${track()}${percentCell(DASH)}`);
    expect(lines[3]?.text).toBe(`${labelCell("MONTH")}${track()}${percentCell(DASH)}`);

    // A reason is meaningless once a window rendered...
    expect(
      goPanelLines({ windows: [{ id: "5h", ratio: 0.2 }] }, NOW, undefined, undefined, "http")[1]?.text,
    ).toBe(`${labelCell("ROLL")}${bar(3)}${percentCell("20%")}`);
    // ...and a hostile tag is dropped rather than drawn.
    expect(goPanelLines(undefined, NOW, undefined, undefined, "not a reason!")[1]?.text).toBe(
      `${labelCell("ROLL")}${track()}${percentCell(DASH)}`,
    );
  });

  test("shortens the resting track by the tag so the line never grows past the meter column", () => {
    const plain = goPanelLines(undefined, NOW)[1]?.text ?? "";
    // A shorter tag leaves some track; a longer one leaves none.
    expect(goPanelLines(undefined, NOW, undefined, undefined, "http")[1]?.text).toBe(
      `${labelCell("ROLL")}http ${track(9)}${percentCell(DASH)}`,
    );
    expect(goPanelLines(undefined, NOW, undefined, undefined, "pending")[1]?.text).toBe(
      `${labelCell("ROLL")}pending ${track(6)}${percentCell(DASH)}`,
    );
    // A tag nearly as wide as the column collapses the track to a stub.
    expect(goPanelLines(undefined, NOW, undefined, undefined, "no-client")[1]?.text).toBe(
      `${labelCell("ROLL")}no-client ${track(4)}${percentCell(DASH)}`,
    );

    for (const reason of ["http", "pending", "no-client", "timeout", "no-bridge"]) {
      const line = goPanelLines(undefined, NOW, undefined, undefined, reason)[1]?.text ?? "";
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
    }
    // Even a hostile bar width never overflows: it is capped to the sidebar.
    for (const line of goPanelLines({ windows: [{ id: "5h", ratio: 1 }] }, NOW, { barWidth: 40 })) {
      expect(line.text.length).toBeLessThanOrEqual(WIDTH_BUDGET);
    }
  });
});
