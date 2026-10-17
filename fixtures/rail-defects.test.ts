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

/**
 * A stub context with a fake host subscription surface for the realtime
 * tracker, plus an `emit` that delivers one delta event on the host's own
 * clock. The reader under test builds its default tracker against this bus —
 * injected samples, no sleeps, no message-list polling.
 */
function deltaContext(
  messages: Record<string, readonly unknown[]> = {},
  family: (id: string) => readonly string[] = (id) => [id],
) {
  const handlers = new Map<string, Array<(event: unknown) => void>>();
  const emit = (type: string, sessionID: string, delta: string, at: number) => {
    emitRaw(type, { data: { sessionID, assistantMessageID: "msg_1", ordinal: 0, delta }, created: at });
  };
  const emitRaw = (type: string, event: unknown) => {
    for (const handler of handlers.get(type) ?? []) {
      handler(event);
    }
  };
  const context = {
    data: {
      session: {
        family,
        message: { list: (id: string) => messages[id] ?? [] },
      },
      shell: { list: () => [] },
    },
  } as unknown as Parameters<typeof createTpsReader>[0];
  (context as unknown as { data: { on: unknown } }).data.on = (
    type: string,
    handler: (event: unknown) => void,
  ) => {
    const known = handlers.get(type) ?? [];
    known.push(handler);
    handlers.set(type, known);
    return () => {
      handlers.set(type, (handlers.get(type) ?? []).filter((entry) => entry !== handler));
    };
  };
  return { context, emit, emitRaw };
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

  test("a root with no descendants still reports its own figure, count zero", () => {
    const reads = createSessionReads(
      stubContext({ root: "idle" }, { root: ["root", "bad"] }, {}),
    );
    // `root` itself is unreadable too, so only the caller's own cost survives:
    // the family figure is the session's own cost against a count of zero.
    expect(reads.treeTotals("root", 7)).toEqual({
      cost: 7,
      count: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    });
  });

  test("no descendants means count zero, not a missing tree", () => {
    const reads = createSessionReads(
      stubContext({ root: "idle" }, { root: ["root"] }, {
        root: { cost: 7, tokens: { input: 100, output: 50 } },
      }),
    );
    // The `total` row now draws this: the session's own cost, `0 subagents`.
    expect(reads.treeTotals("root", 7)).toEqual({
      cost: 7,
      count: 0,
      tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
    });
  });

  test("a non-root session has no family figure of its own", () => {
    const reads = createSessionReads(
      stubContext({ root: "idle" }, {}, {}, {}, "parent"),
    );
    // `root()` answers with the parent, so this session's family is not its own
    // to total — unchanged by the childless fix.
    expect(reads.treeTotals("child", 1)).toBeUndefined();
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

// The per-session maps stay bounded. The realtime tracker's sample map is
// LRU-capped (cap plus eviction): pushing past the cap drops the stalest
// session's samples and a revisit reads zero, exactly like a first sight —
// which is also what proves the eviction, since surviving samples would
// divide. The elapsed clock instead sweeps only sessions the host forgot, so
// a live session's high-water mark survives any amount of session-hopping.
describe("per-session maps stay bounded", () => {
  const FILLERS = 60;

  test("the realtime tracker evicts stale sample rings instead of growing forever", () => {
    const { context, emit } = deltaContext();
    const reader = createTpsReader(context);
    // A fresh 100-token delta a second ago paints 100 tok/s outright.
    emit("session.text.delta", "a", "x".repeat(500), Date.now() - 1_000);
    expect(reader.sessionTps("a", { time: { created: 0 } }).rt).toBe(100);
    for (let index = 0; index < FILLERS; index += 1) {
      emit("session.text.delta", `s${index}`, "x", Date.now() - 1_000);
    }
    // The ring for "a" was pushed out: the revisit reads zero, exactly like a
    // first sight — which is also what proves the eviction, since the
    // surviving samples would have divided.
    expect(reader.sessionTps("a", { time: { created: 0 } }).rt).toBe(0);
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

// `rt` under scope `"session"` is directly per-session: each session paces
// only its own delta stream, and the idle test is the session's own
// staleness — no family-wide flag reaches the reader, so a parent that
// stopped streaming reads as zero even while its child still runs. A session
// with no samples reads as zero: no rate is ever guessed. The turns below
// carry no `streamed` rung, so the average stays unknown and the realtime
// figure asserts alone. These pin that scope explicitly; the shipped
// `"family"` default is covered in fixtures/render.test.ts.
describe("rt is directly per-session", () => {
  // A stamped turn with nothing settled: capability known, average unknown.
  const openTurn = (id: string) => ({ id, type: "assistant", time: { created: 0 }, tokens: { output: 1 } });

  test("a root with its own and a child's deltas reports only its own rate", () => {
    const messages: Record<string, readonly unknown[]> = {
      root: [openTurn("r1")],
      child: [openTurn("c1")],
    };
    const { context, emit } = deltaContext(messages);
    const reader = createTpsReader(context, undefined, "session");
    // Both sessions stream 100 estimated tokens a second ago. The parent's
    // own stream divides alone: folding the child's stream in would double
    // the tokens over the same wall clock and read 200.
    const at = Date.now() - 1_000;
    emit("session.text.delta", "root", "x".repeat(500), at);
    emit("session.text.delta", "child", "x".repeat(500), at);
    expect(reader.sessionTps("root", { time: { created: 0 } })).toEqual({ rt: 100, avg: undefined });
  });

  test("a parent that stopped streaming reads zero while its child still runs", () => {
    const messages: Record<string, readonly unknown[]> = {
      root: [openTurn("r1")],
      child: [openTurn("c1")],
    };
    const { context, emit } = deltaContext(messages);
    const reader = createTpsReader(context, undefined, "session");
    // The parent's only sample is stale (past the window for good measure)
    // while the child streamed a second ago. The parent's own silence reads
    // as zero — not its last rate, and the child's work cannot hold it up.
    emit("session.text.delta", "root", "x".repeat(500), Date.now() - 10_000);
    emit("session.text.delta", "child", "x".repeat(500), Date.now() - 1_000);
    expect(reader.sessionTps("root", { time: { created: 0 } }).rt).toBe(0);
    expect(reader.sessionTps("child", { time: { created: 0 } }).rt).toBe(100);
  });

  test("first sight never guesses a cumulative figure", () => {
    const { context } = deltaContext({
      root: [openTurn("r1")],
      child: [openTurn("c1")],
    });
    const reader = createTpsReader(context, undefined, "session");
    // No deltas injected: nothing streamed yet, so both read zero — the old
    // poll tracker's lifetime-average flash has nowhere to come from.
    expect(reader.sessionTps("root", { time: { created: 0 } }).rt).toBe(0);
    expect(reader.sessionTps("child", { time: { created: 0 } }).rt).toBe(0);
  });

  test("rt returns zero when there is no figure yet, never undefined", () => {
    const { context } = deltaContext({});
    const reader = createTpsReader(context, undefined, "session");
    expect(reader.sessionTps("quiet", { time: { created: 0 } }).rt).toBe(0);
  });
});

// The realtime estimate counts every delta the host emits — text and
// reasoning — because both paced the decoder. A thinking-heavy turn reads as
// speed, not as silence with no output yet.
describe("rt counts reasoning deltas as generation", () => {
  const openTurn = (id: string) => ({ id, type: "assistant", time: { created: 0 }, tokens: { output: 1 } });

  test("a reasoning delta paces the decoder like a text delta", () => {
    const { context, emit } = deltaContext({ s: [openTurn("m1")] });
    const reader = createTpsReader(context, undefined, "session");
    // 100 estimated tokens a second ago, carried on the reasoning channel.
    // A text-only numerator would see nothing streaming and read zero.
    emit("session.reasoning.delta", "s", "x".repeat(500), Date.now() - 1_000);
    expect(reader.sessionTps("s", { time: { created: 0 } })).toEqual({ rt: 100, avg: undefined });
  });
});

// Family-scope rt hardening: there are no baselines to hold — deltas are
// additive, so a partial message walk cannot spike a later figure — and the
// creation-time gate belongs to the average alone. A member message read that
// throws leaves the average unknown while the realtime figure stands; and an
// unstamped root without `time.created` still paces its children, for both
// figures, off the family-wide streams and clock.
describe("family rt sums concurrent decoders and degrades with the average", () => {
  const familyOf = (id: string) => (id === "root" ? ["root", "child"] : [id]);
  const openTurn = (id: string) => ({ id, type: "assistant", time: { created: 0 }, tokens: { output: 1 } });

  test("concurrent decoders share wall clock instead of adding it", () => {
    const { context, emit } = deltaContext({ root: [openTurn("r1")], child: [openTurn("c1")] }, familyOf);
    const family = createTpsReader(context, undefined, "family");
    const session = createTpsReader(context, undefined, "session");
    // Both sessions stream 100 estimated tokens over the same second: the
    // family paces their 200-token sum over the shared 1 s coverage, while
    // the session reader paces the root alone.
    const at = Date.now() - 1_000;
    emit("session.text.delta", "root", "x".repeat(500), at);
    emit("session.text.delta", "child", "x".repeat(500), at);
    expect(family.sessionTps("root", { time: { created: 0 } }).rt).toBe(200);
    expect(session.sessionTps("root", { time: { created: 0 } }).rt).toBe(100);
  });

  test("ttft pools family steps into one mean while session scope isolates", () => {
    const { context, emitRaw } = deltaContext({}, familyOf);
    const family = createTpsReader(context, undefined, "family");
    const session = createTpsReader(context, undefined, "session");
    const step = (type: string, sessionID: string, messageID: string, extra: Record<string, unknown>, at: number) => {
      emitRaw(type, { data: { sessionID, assistantMessageID: messageID, ...extra }, created: at });
    };
    const delta = (sessionID: string, messageID: string, at: number) => {
      step("session.text.delta", sessionID, messageID, { ordinal: 0, delta: "x" }, at);
    };
    const settle = (sessionID: string, messageID: string, at: number) => {
      step("session.step.ended", sessionID, messageID, { finish: "stop" }, at);
    };
    // Dispatch at 0, first token a second later in the root; three seconds
    // later in the child. Steps finalize at end — the mean rides the both
    // line beside rt and avg.
    step("session.step.started", "root", "m1", { started: 0 }, 0);
    delta("root", "m1", 1_000);
    settle("root", "m1", 1_500);
    step("session.step.started", "child", "m2", { started: 0 }, 0);
    delta("child", "m2", 3_000);
    settle("child", "m2", 3_500);
    expect(family.sessionTps("root", { time: { created: 0 } }).ttft).toBe(2);
    expect(session.sessionTps("root", { time: { created: 0 } }).ttft).toBe(1);
    expect(family.sessionTps("root", { time: { created: 0 } })).toEqual({ rt: 0, avg: undefined, ttft: 2 });
  });

  test("a failed member message read leaves the average unknown while rt stands", () => {
    const messages: Record<string, readonly unknown[]> = {
      root: [{ id: "r1", type: "assistant", time: { created: 0, streamed: 2_000 }, tokens: { output: 60, reasoning: 40 } }],
      child: [{ id: "c1", type: "assistant", time: { created: 0, streamed: 2_000 }, tokens: { output: 900, reasoning: 100 } }],
    };
    const { context, emit } = deltaContext(messages, familyOf);
    // The child's read fails: partial spans would undercount time and inflate
    // the mean, so the average stays unknown — while the realtime figure,
    // estimated from events rather than polls, stands on the root's stream.
    type List = (id: string) => readonly unknown[];
    const session = (context as unknown as { data: { session: { message: { list: List } } } }).data.session;
    const list = session.message.list;
    session.message.list = (id: string) => {
      if (id === "child") throw new Error("transient child read failure");
      return list(id);
    };
    const reader = createTpsReader(context, undefined, "family");
    emit("session.text.delta", "root", "x".repeat(500), Date.now() - 1_000);
    expect(reader.sessionTps("root", { time: { created: 0 } })).toEqual({ rt: 100, avg: undefined });
  });

  test("family scope paces a child off the active clock when the root carries no creation stamp", () => {
    const { context, emit } = deltaContext({}, familyOf);
    const session = (context as unknown as { data: { session: { get: (id: string) => unknown; message: { list: () => readonly unknown[] } } } }).data.session;
    session.get = (id: string) => {
      // The displayed session carries no `time.created` at all; the
      // child carries the tokens.
      if (id === "root") return { tokens: { output: 0 } };
      if (id === "child") return { tokens: { output: 100 } };
      throw new Error(`gone: ${id}`);
    };
    session.message.list = () => [{ type: "assistant" }];
    const clock = new Map<string, number>([["root", 1_000]]);
    const reader = createTpsReader(
      context,
      { elapsedMsOf: (id: string) => clock.get(id) ?? 0 },
      "family",
    );
    const rootSession = { tokens: { output: 0 } };
    // The child streams 100 estimated tokens a second ago: rt paces it with
    // no gate at all, while the average divides the 100 recorded tokens over
    // the same 1 s of family-wide active clock.
    emit("session.text.delta", "child", "x".repeat(500), Date.now() - 1_000);
    expect(reader.sessionTps("root", rootSession)).toEqual({ rt: 100, avg: 100 });
  });

  test("session scope keeps the creation-time gate for the average only", () => {
    // Same host state as above — unstamped, root without `time.created` —
    // but `"session"` restores the gate for the average: no stamp, no
    // clock, so the average stays unknown. The realtime figure has no gate:
    // the root's own stream still paces.
    const { context, emit } = deltaContext({}, familyOf);
    const session = (context as unknown as { data: { session: { get: (id: string) => unknown; message: { list: () => readonly unknown[] } } } }).data.session;
    session.get = (id: string) => {
      if (id === "root") return { tokens: { output: 0 } };
      if (id === "child") return { tokens: { output: 100 } };
      throw new Error(`gone: ${id}`);
    };
    session.message.list = () => [{ type: "assistant" }];
    const clock = new Map<string, number>([["root", 1_000]]);
    const reader = createTpsReader(
      context,
      { elapsedMsOf: (id: string) => clock.get(id) ?? 0 },
      "session",
    );
    const rootSession = { tokens: { output: 0 } };
    emit("session.text.delta", "root", "x".repeat(500), Date.now() - 1_000);
    expect(reader.sessionTps("root", rootSession)).toEqual({ rt: 100, avg: undefined });
  });
});

// The reader's second figure: the settled-turn average over the same scope,
// handed over beside the realtime rt estimate. Unlike the estimate it needs
// no baselines — settled turns already divide on the first poll, so `avg`
// draws immediately — and an in-flight turn (no `streamed` yet) stays out of
// the numerator and the denominator together. These pin the pair shape, the
// settled-only rule, the family union, the unstamped clock path, and the
// partial-read degradation.
describe("the tps reader hands over the settled-turn average beside the rt estimate", () => {
  const stampedContext = (
    messages: Record<string, readonly unknown[]>,
    family: (id: string) => readonly string[] = (id) => [id],
  ) =>
    ({
      data: {
        session: {
          family,
          message: { list: (id: string) => messages[id] ?? [] },
        },
      },
    }) as unknown as Parameters<typeof createTpsReader>[0];

  test("the first poll already divides: no baseline, no seeded cumulative figure", () => {
    const reader = createTpsReader(
      stampedContext({
        root: [{ id: "r1", type: "assistant", time: { created: 0, streamed: 2_000 }, tokens: { output: 60, reasoning: 40 } }],
      }),
      undefined,
      "session",
    );
    // The root's own 100 generation tokens over its 2 s span: 50 tok/s on the
    // first poll, while the live half still waits for a delta.
    expect(reader.sessionTps("root", { time: { created: 0 } })).toEqual({ rt: 0, avg: 50 });
  });

  test("an in-flight turn stays out of the numerator and the denominator together", () => {
    const messages: Record<string, readonly unknown[]> = {
      root: [
        { id: "r1", type: "assistant", time: { created: 0, streamed: 2_000 }, tokens: { output: 60, reasoning: 40 } },
        // Still decoding: no `streamed` rung, 5,000 fresh output tokens.
        { id: "r2", type: "assistant", time: { created: 2_000 }, tokens: { output: 5_000 } },
      ],
    };
    const reader = createTpsReader(stampedContext(messages), undefined, "session");
    // Only the settled turn divides: 100 over 2 s. Counting the in-flight
    // turn's tokens over its open span would read 2,550.
    expect(reader.sessionTps("root", { time: { created: 0 } })).toEqual({ rt: 0, avg: 50 });
  });

  test("a turn that settled only its tools is not settled work", () => {
    const messages: Record<string, readonly unknown[]> = {
      root: [
        { id: "r1", type: "assistant", time: { created: 0, streamed: 2_000 }, tokens: { output: 60, reasoning: 40 } },
        // `completed` with no `streamed`: the tools settled, but the decoding
        // end was never recorded, so this turn has no span in the average.
        { id: "r2", type: "assistant", time: { created: 2_000, completed: 7_000 }, tokens: { output: 500 } },
      ],
    };
    const reader = createTpsReader(stampedContext(messages), undefined, "session");
    expect(reader.sessionTps("root", { time: { created: 0 } }).avg).toBe(50);
  });

  test("the family scope unions settled spans instead of adding them", () => {
    const messages: Record<string, readonly unknown[]> = {
      // Overlapping settled turns: 100 tokens over [0, 2 s] beside 1,000 over
      // [0, 5 s], sharing one 5 s wall clock.
      root: [{ id: "r1", type: "assistant", time: { created: 0, streamed: 2_000 }, tokens: { output: 60, reasoning: 40 } }],
      child: [{ id: "c1", type: "assistant", time: { created: 0, streamed: 5_000 }, tokens: { output: 900, reasoning: 100 } }],
    };
    const reader = createTpsReader(
      stampedContext(messages, (id) => (id === "root" ? ["root", "child"] : [id])),
      undefined,
      "family",
    );
    // 1,100 generation tokens over the 5 s union: 220. Summing the spans
    // instead of unioning them would divide by 7 s and read ~157.
    expect(reader.sessionTps("root", { time: { created: 0 } })).toEqual({ rt: 0, avg: 220 });
  });

  test("with no settled turn the average is unknown, never zero", () => {
    // In-flight only: no `streamed` rung anywhere, so there is nothing to
    // divide — the row hides rather than drawing a zero it cannot stand behind.
    const reader = createTpsReader(
      stampedContext({
        root: [{ id: "r1", type: "assistant", time: { created: 0 }, tokens: { output: 50 } }],
      }),
      undefined,
      "session",
    );
    expect(reader.sessionTps("root", { time: { created: 0 } })).toEqual({ rt: 0, avg: undefined });
  });

  test("a failed member read leaves the average unknown with the live zero", () => {
    const messages: Record<string, readonly unknown[]> = {
      root: [{ id: "r1", type: "assistant", time: { created: 0, streamed: 2_000 }, tokens: { output: 60, reasoning: 40 } }],
      child: [{ id: "c1", type: "assistant", time: { created: 0, streamed: 2_000 }, tokens: { output: 900, reasoning: 100 } }],
    };
    const context = {
      data: {
        session: {
          family: (id: string) => (id === "root" ? ["root", "child"] : [id]),
          message: {
            list: (id: string) => {
              if (id === "child") throw new Error("transient child read failure");
              return messages[id] ?? [];
            },
          },
        },
      },
    } as unknown as Parameters<typeof createTpsReader>[0];
    const reader = createTpsReader(context, undefined, "family");
    // Partial spans would undercount time and inflate the mean, so the poll
    // degrades instead of dividing: live zero, average unknown.
    expect(reader.sessionTps("root", { time: { created: 0 } })).toEqual({ rt: 0, avg: undefined });
  });

  test("the unstamped path divides generation over the borrowed active clock", () => {
    const context = {
      data: {
        session: {
          family: (id: string) => [id],
          // Assistant turns with no timestamps: an unstamped host.
          message: { list: () => [{ type: "assistant" }] },
        },
      },
    } as unknown as Parameters<typeof createTpsReader>[0];
    const clock = new Map<string, number>([["s", 10_000]]);
    const reader = createTpsReader(context, { elapsedMsOf: (id: string) => clock.get(id) ?? 0 });
    // 150 generation tokens over 10 s of active clock: 15. The live half
    // still waits for a delta, so the pair reads zero beside it.
    expect(
      reader.sessionTps("s", { time: { created: 0 }, tokens: { output: 100, reasoning: 50 } }),
    ).toEqual({ rt: 0, avg: 15 });
  });

  test("the unstamped average is unknown when the clock has nothing to lend", () => {
    const context = {
      data: {
        session: {
          family: (id: string) => [id],
          message: { list: () => [{ type: "assistant" }] },
        },
      },
    } as unknown as Parameters<typeof createTpsReader>[0];
    const reader = createTpsReader(context, { elapsedMsOf: () => 0 });
    // Generation on record but no generating time: no honest denominator, so
    // no average — never the wall-clock lifetime figure.
    expect(
      reader.sessionTps("s", { time: { created: 0 }, tokens: { output: 100, reasoning: 50 } }),
    ).toEqual({ rt: 0, avg: undefined });
  });
});
