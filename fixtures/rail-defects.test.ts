import { describe, expect, test } from "bun:test";
import stringWidth from "string-width";
import { createActiveElapsed } from "../src/tui/active-elapsed.js";
import { clip } from "../src/tui/format.js";
import { createSessionReads } from "../src/tui/session-reads.js";
import { createTpsReader } from "../src/tui/session-tps.js";

// Focused regression tests for three rail defects: a throwing family read
// blanking the whole tree total, length-based clipping overrunning the rail on
// wide values, and per-session maps growing without eviction.

// Non-ASCII glyphs are built from code points, never pasted literally.
const CJK = String.fromCharCode(0x6f22);
const EMOJI = String.fromCharCode(0xd83d, 0xde00);
const ELLIPSIS = String.fromCharCode(0x2026);

function stubContext(
  statuses: Record<string, string | undefined> = {},
  families: Record<string, readonly string[]> = {},
  gets: Record<string, unknown> = {},
  messages: Record<string, readonly unknown[]> = {},
  root = "root",
) {
  const directory = "C:\\workspace";
  const context = {
    location: { directory },
    data: {
      location: { default: () => ({ directory }), model: { list: () => [] } },
      session: {
        get: (id: string) => {
          if (id in gets) return gets[id];
          throw new Error(`gone: ${id}`);
        },
        root: () => root,
        status: (id: string) => statuses[id],
        family: (id: string) => families[id] ?? [id],
        message: { list: (id: string) => messages[id] ?? [] },
        permission: { list: () => [] },
      },
      shell: { list: () => [] },
    },
  };
  return context as unknown as Parameters<typeof createSessionReads>[0];
}

// `treeTotals` used to call `session.get(id)` bare inside the loop, so one
// throwing member blanked the whole cost/total. The TPS reader for the same
// walk already caught per id; the tree total now does the same.
describe("treeTotals skips an unreadable member", () => {
  test("a throwing family member does not blank the rest of the tree", () => {
    const reads = createSessionReads(
      stubContext({ root: "idle" }, { root: ["root", "good", "bad"] }, { good: { cost: 5 } }),
    );
    expect(reads.treeTotals("root", 7)).toEqual({ cost: 12, count: 1 });
  });

  test("an unreadable-only tree degrades to no total, not a throw", () => {
    const reads = createSessionReads(
      stubContext({ root: "idle" }, { root: ["root", "bad"] }, {}),
    );
    expect(reads.treeTotals("root", 7)).toBeUndefined();
  });
});

// `clip` was length-based, so a CJK/emoji value that fit in characters still
// drew twice as wide and overran the rail. The budget is cells now.
describe("clip measures cells, not characters", () => {
  test("a CJK value that fits in characters but not in cells is shortened", () => {
    // 18 CJK characters draw 36 cells: the old cut left them whole.
    const clipped = clip(CJK.repeat(18), 18);
    expect(stringWidth(clipped)).toBeLessThanOrEqual(18);
    expect(clipped.endsWith(ELLIPSIS)).toBe(true);
    // 8 CJK (16 cells) plus the one-cell ellipsis is the longest prefix that
    // keeps the ellipsis inside the budget.
    expect(clipped).toBe(CJK.repeat(8) + ELLIPSIS);
  });

  test("an emoji value is clipped by cells and never split", () => {
    const clipped = clip(EMOJI.repeat(9), 5);
    expect(clipped).toBe(EMOJI + EMOJI + ELLIPSIS);
    expect(stringWidth(clipped)).toBeLessThanOrEqual(5);
    // A budget below one cell still shortens rather than splitting the pair.
    expect(clip(EMOJI, 1)).toBe(EMOJI + ELLIPSIS);
  });

  test("ASCII clipping is unchanged", () => {
    expect(clip("short", 22)).toBe("short");
    const id = "ses_f07dc9b3bffeVWC5RUrFGCbyo0";
    expect(clip(id, 18)).toBe(`${id.slice(0, 17)}${ELLIPSIS}`);
    expect(stringWidth(clip(id, 18))).toBe(18);
  });

  test("mixed widths fill the budget by cells", () => {
    // "ab" (2 cells) plus 8 CJK (16 cells) is exactly the budget: untouched.
    expect(clip(`ab${CJK.repeat(8)}`, 18)).toBe(`ab${CJK.repeat(8)}`);
    // One more CJK no longer fits: clipped inside the budget, marked as cut.
    const clipped = clip(`ab${CJK.repeat(9)}`, 18);
    expect(stringWidth(clipped)).toBeLessThanOrEqual(18);
    expect(clipped.endsWith(ELLIPSIS)).toBe(true);
  });
});

// The per-session `states`, `trackers`, and seed maps grew one entry per
// viewed session with no eviction: a TUI-lifetime leak. Each is now bounded
// (cap plus eviction), so pushing past the cap drops the stalest entry and a
// revisit behaves like a first sight.
describe("per-session maps stay bounded", () => {
  const FILLERS = 60;

  test("the active clock evicts stale sessions instead of growing forever", () => {
    const clock = createActiveElapsed(() => true);
    expect(clock("a", 0)).toBeUndefined();
    expect(clock("a", 1_000)).toBe(1_000);
    for (let index = 0; index < FILLERS; index += 1) {
      clock(`s${index}`, 0);
      clock(`s${index}`, 1_000);
    }
    // "a" was pushed out: the revisit rebaselines like a first sight instead
    // of resuming the evicted tally.
    expect(clock("a", 2_000)).toBeUndefined();
  });

  test("the TPS reader evicts stale trackers instead of growing forever", () => {
    const elapsed = new Map<string, number>([["a", 10_000]]);
    const context = {
      data: {
        session: {
          family: (id: string) => [id],
          // Assistant turns with no timestamps: an unstamped host, so the
          // denominator is the supplied active clock, fully controlled here.
          message: { list: () => [{ type: "assistant" }] },
        },
      },
    } as unknown as Parameters<typeof createTpsReader>[0];
    const reader = createTpsReader(context, () => true, {
      busyOf: () => true,
      elapsedMsOf: (id: string) => elapsed.get(id) ?? 10_000,
    });
    // First poll sets the baselines and paints the cumulative average.
    expect(reader.sessionTps("a", { time: { created: 0 }, tokens: { output: 100 } })).toBe(10);
    for (let index = 0; index < FILLERS; index += 1) {
      reader.sessionTps(`s${index}`, { time: { created: 0 }, tokens: { output: 100 } });
    }
    // The tracker for "a" was pushed out: the revisit restarts its baselines
    // (the cumulative average 200/11) instead of smoothing a delta off the
    // evicted one (which would have painted 37).
    elapsed.set("a", 11_000);
    expect(
      reader.sessionTps("a", { time: { created: 0 }, tokens: { output: 200 } }),
    ).toBeCloseTo(200 / 11, 10);
  });

  test("an evicted elapsed seed is re-scanned from the host", () => {
    const messages: Record<string, readonly unknown[]> = {
      a: [
        {
          id: "m1",
          type: "assistant",
          time: { created: 0, completed: 4_000 },
          tokens: { output: 10 },
        },
      ],
    };
    const reads = createSessionReads(stubContext({ a: "idle" }, { a: ["a"] }, {}, messages));
    expect(reads.sessionElapsed("a", 0)).toBe(4_000);
    for (let index = 0; index < FILLERS; index += 1) {
      reads.sessionElapsed(`s${index}`, 0);
    }
    messages.a = [
      {
        id: "m1",
        type: "assistant",
        time: { created: 0, completed: 9_000 },
        tokens: { output: 10 },
      },
    ];
    // Both the seed and the tally for "a" were pushed out: the revisit
    // re-scans the host's current timestamps instead of the stale memo.
    expect(reads.sessionElapsed("a", 1_000)).toBe(9_000);
  });
});
