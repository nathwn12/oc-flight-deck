import { describe, expect, test } from "bun:test";
import stringWidth from "string-width";
import { clip } from "../src/tui/format.js";
import { createSessionReads } from "../src/tui/session-reads.js";
import { createTpsReader } from "../src/tui/session-tps.js";

// Focused regression tests for rail defects: a throwing family read blanking
// the whole tree total, length-based clipping overrunning the rail on wide
// values, per-session maps growing without eviction, and scope leaks between
// the money row and its neighbouring rows.

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
// walk already caught per id; the tree total now does the same — and it rolls
// up the family's tokens alongside its cost, so the token rows share the
// money row's scope instead of showing one session beside a family's bill.
describe("treeTotals skips an unreadable member and rolls up tokens", () => {
  test("a throwing family member does not blank the rest of the tree", () => {
    const reads = createSessionReads(
      stubContext({ root: "idle" }, { root: ["root", "good", "bad"] }, {
        root: { cost: 7, tokens: { input: 100, output: 50, cache: { read: 20, write: 5 } } },
        good: { cost: 5, tokens: { input: 10, output: 20, reasoning: 5, cache: { read: 30 } } },
      }),
    );
    expect(reads.treeTotals("root", 7)).toEqual({
      cost: 12,
      count: 1,
      tokens: { input: 110, output: 70, reasoning: 5, cache: { read: 50, write: 5 } },
    });
  });

  test("an unreadable-only tree degrades to no total, not a throw", () => {
    const reads = createSessionReads(
      stubContext({ root: "idle" }, { root: ["root", "bad"] }, {}),
    );
    expect(reads.treeTotals("root", 7)).toBeUndefined();
  });

  test("no descendants means no tree, even with tokens on record", () => {
    const reads = createSessionReads(
      stubContext({ root: "idle" }, { root: ["root"] }, {
        root: { cost: 7, tokens: { input: 100, output: 50 } },
      }),
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

// The per-session maps stay bounded. The TPS tracker map is LRU-capped (cap
// plus eviction): pushing past the cap drops the stalest tracker and a revisit
// restarts its baselines instead of smoothing a delta off evicted state. The
// elapsed clock instead sweeps only sessions the host forgot, so a live
// session's high-water mark survives any amount of session-hopping.
describe("per-session maps stay bounded", () => {
  const FILLERS = 60;

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
    const reader = createTpsReader(context, {
      elapsedMsOf: (id: string) => elapsed.get(id) ?? 10_000,
    });
    // First poll sets the baselines; no rate is known yet, so it reads zero
    // rather than the cumulative average.
    expect(reader.sessionTps("a", { time: { created: 0 }, tokens: { output: 100 } })).toBe(0);
    for (let index = 0; index < FILLERS; index += 1) {
      reader.sessionTps(`s${index}`, { time: { created: 0 }, tokens: { output: 100 } });
    }
    // The tracker for "a" was pushed out: the revisit restarts its baselines
    // and reads zero — which is also what proves the eviction, since the
    // surviving tracker would have smoothed a 100-tokens-over-1-s delta.
    elapsed.set("a", 11_000);
    expect(
      reader.sessionTps("a", { time: { created: 0 }, tokens: { output: 200 } }),
    ).toBe(0);
  });

  test("a live elapsed figure survives crowding past the sweep bound", () => {
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
    // "a" stays known to the host; the filler sessions never existed there.
    const reads = createSessionReads(stubContext({ a: "idle" }, { a: ["a"] }, { a: { cost: 1 } }, messages));
    expect(reads.sessionElapsed("a", 0)).toBe(4_000);
    for (let index = 0; index < 300; index += 1) {
      reads.sessionElapsed(`s${index}`, 0);
    }
    messages.a = [
      {
        id: "m1",
        type: "assistant",
        time: { created: 0, completed: 900 },
        tokens: { output: 10 },
      },
    ];
    // Three hundred sessions tripped the sweep, which dropped only the
    // forgotten fillers: "a" holds its high-water instead of re-deriving the
    // shrunken record.
    expect(reads.sessionElapsed("a", 60_000)).toBe(4_000);
  });
});

// `tps` is directly per-session: each session paces only its own decoder, and
// the idle test is the session's own generating-time delta — no family-wide
// busy flag reaches the reader, so a parent that stopped generating reads as
// zero even while its child is still running. The first poll for a session
// only sets the tracker's baselines and reads as zero: no cumulative average
// ever seeds the figure.
describe("tps is directly per-session", () => {
  const turn = (id: string, streamed: number, tokens: Record<string, number>) => ({
    id,
    type: "assistant",
    time: { created: 0, streamed },
    tokens,
  });
  const familyContext = (messages: Record<string, readonly unknown[]>) =>
    ({
      data: {
        session: {
          family: (id: string) => [id],
          message: { list: (id: string) => messages[id] ?? [] },
        },
      },
    }) as unknown as Parameters<typeof createTpsReader>[0];

  test("a root with its own and a child's spans reports only its own rate", async () => {
    const messages: Record<string, readonly unknown[]> = {
      root: [turn("r1", 2_000, { output: 60, reasoning: 40 })],
      child: [turn("c1", 5_000, { output: 900, reasoning: 100 })],
    };
    const reader = createTpsReader(familyContext(messages));
    // First sight only sets the baselines: no rate is known yet.
    expect(reader.sessionTps("root", { time: { created: 0 } })).toBe(0);
    await Bun.sleep(1_100);
    // Both turns advance: the parent gains 100 generation tokens over 1 new
    // second; the child gains 1,100 over 1 new second of its wider span.
    messages.root = [turn("r1", 3_000, { output: 160, reasoning: 40 })];
    messages.child = [turn("c1", 6_000, { output: 1_900, reasoning: 200 })];
    // The parent's own delta is 100 tok/s. Folding the child's advancing turn
    // in would add its 1,100 tokens to a 1 s wider union and read 1,200.
    expect(reader.sessionTps("root", { time: { created: 0 } })).toBe(100);
  });

  test("a parent that stopped generating reads zero while its child still runs", async () => {
    const messages: Record<string, readonly unknown[]> = {
      root: [turn("r1", 2_000, { output: 60, reasoning: 40 })],
      child: [turn("c1", 2_000, { output: 900, reasoning: 100 })],
    };
    const reader = createTpsReader(familyContext(messages));
    // Establish a live rate: first sight sets the baselines, the advancing
    // second poll paints 100 tok/s.
    expect(reader.sessionTps("root", { time: { created: 0 } })).toBe(0);
    await Bun.sleep(1_100);
    messages.root = [turn("r1", 3_000, { output: 160, reasoning: 40 })];
    expect(reader.sessionTps("root", { time: { created: 0 } })).toBe(100);
    // The parent's spans freeze while the child keeps advancing elsewhere. The
    // parent's own unmoved denominator reads as zero — not its last rate, and
    // the child's work cannot hold it up.
    await Bun.sleep(1_100);
    messages.child = [turn("c1", 4_000, { output: 1_900, reasoning: 200 })];
    expect(reader.sessionTps("root", { time: { created: 0 } })).toBe(0);
  });

  test("first sight never seeds from the cumulative lifetime average", () => {
    const reader = createTpsReader(
      familyContext({
        root: [turn("r1", 2_000, { output: 60, reasoning: 40 })],
        child: [turn("c1", 2_000, { output: 900, reasoning: 100 })],
      }),
    );
    // A session deep into its life: the root's own 100 generation tokens over
    // its 2 s span would seed 50 as a cumulative average. No rate is known
    // yet, so the first poll reads as zero instead — for the child too.
    expect(reader.sessionTps("root", { time: { created: 0 } })).toBe(0);
    expect(reader.sessionTps("child", { time: { created: 0 } })).toBe(0);
  });

  test("tps returns zero when there is no figure yet, never undefined", () => {
    const reader = createTpsReader(familyContext({}));
    expect(reader.sessionTps("quiet", { time: { created: 0 } })).toBe(0);
  });
});

// The TPS numerator is generation - output plus reasoning - on both host
// paths: the stamped union over message turns, and the unstamped session
// record. A thinking-heavy turn reads as speed, not as idle time with no
// output yet.
describe("TPS counts reasoning as generation", () => {
  const stampedContext = (messages: Record<string, readonly unknown[]>) =>
    ({
      data: {
        session: {
          family: (id: string) => [id],
          message: { list: (id: string) => messages[id] ?? [] },
        },
      },
    }) as unknown as Parameters<typeof createTpsReader>[0];

  test("a stamped turn divides output plus reasoning over its streaming span", async () => {
    const messages: Record<string, readonly unknown[]> = {
      s: [
        {
          id: "m1",
          type: "assistant",
          time: { created: 0, streamed: 2_000 },
          tokens: { output: 60, reasoning: 40 },
        },
      ],
    };
    const reader = createTpsReader(stampedContext(messages));
    // First sight sets the baselines: no rate is known yet.
    expect(reader.sessionTps("s", { time: { created: 0 } })).toBe(0);
    await Bun.sleep(1_100);
    // The turn gains 200 generation tokens over 2 new seconds: 100 tok/s. An
    // output-only numerator would see half the delta and read 50.
    messages.s = [
      {
        id: "m1",
        type: "assistant",
        time: { created: 0, streamed: 4_000 },
        tokens: { output: 160, reasoning: 140 },
      },
    ];
    expect(reader.sessionTps("s", { time: { created: 0 } })).toBe(100);
  });

  test("a reasoning-only stamped turn still paces the decoder", async () => {
    const messages: Record<string, readonly unknown[]> = {
      s: [
        {
          id: "m1",
          type: "assistant",
          time: { created: 0, streamed: 2_000 },
          tokens: { reasoning: 120 },
        },
      ],
    };
    const reader = createTpsReader(stampedContext(messages));
    expect(reader.sessionTps("s", { time: { created: 0 } })).toBe(0);
    await Bun.sleep(1_100);
    // Reasoning grows 120 → 320 over 2 new seconds: 100 tok/s. Output-only
    // would see no new output tokens and read zero.
    messages.s = [
      {
        id: "m1",
        type: "assistant",
        time: { created: 0, streamed: 4_000 },
        tokens: { reasoning: 320 },
      },
    ];
    expect(reader.sessionTps("s", { time: { created: 0 } })).toBe(100);
  });

  test("the unstamped record path sums the output and reasoning rungs", async () => {
    const elapsed = new Map<string, number>([["s", 10_000]]);
    const context = {
      data: {
        session: {
          family: (id: string) => [id],
          message: { list: () => [{ type: "assistant" }] },
        },
      },
    } as unknown as Parameters<typeof createTpsReader>[0];
    const reader = createTpsReader(context, {
      elapsedMsOf: (id: string) => elapsed.get(id) ?? 10_000,
    });
    expect(
      reader.sessionTps("s", { time: { created: 0 }, tokens: { output: 100, reasoning: 50 } }),
    ).toBe(0);
    await Bun.sleep(1_100);
    // Reasoning grows 50 → 250 while output holds: +200 over 2 s of active
    // clock. Output-only would see no new output and read zero.
    elapsed.set("s", 12_000);
    expect(
      reader.sessionTps("s", { time: { created: 0 }, tokens: { output: 100, reasoning: 250 } }),
    ).toBe(100);
  });
});
