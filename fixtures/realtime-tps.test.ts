import { describe, expect, test } from "bun:test";
import {
  createRealtimeTps,
  estimateDeltaTokens,
  RT_MAX_SESSIONS,
  RT_MAX_STEPS,
  RT_SAMPLE_WINDOW_MS,
  RT_STALE_MS,
} from "../src/tui/realtime-tps.js";
import { smoothTpsRate, tpsNeedsRepaint, TPS_EWMA_ALPHA } from "../src/tui/throughput.js";

// The realtime TPS tracker: tokens estimated from the host's streaming delta
// events, because a poll of the message list can only see a turn's tokens
// after it settles. A controlled clock pins the window without sleeping.

type Handler = (event: unknown) => void;

interface Bus {
  readonly handlers: Map<string, Handler[]>;
  readonly released: number[];
}

/** A fake host subscription surface that records handlers and emits on demand. */
function busContext(opts?: { now?: () => number; throwing?: boolean; failAt?: number }) {
  const bus: Bus = { handlers: new Map(), released: [] };
  let calls = 0;
  const context = {
    data: {
      on: (type: string, handler: Handler) => {
        if (opts?.throwing === true) throw new Error("no subscription surface");
        calls += 1;
        if (opts?.failAt === calls) throw new Error(`rejected subscription: ${type}`);
        const known = bus.handlers.get(type) ?? [];
        known.push(handler);
        bus.handlers.set(type, known);
        let released = false;
        return () => {
          if (released) return;
          released = true;
          bus.released.push(1);
          const rest = (bus.handlers.get(type) ?? []).filter((entry) => entry !== handler);
          if (rest.length === 0) bus.handlers.delete(type);
          else bus.handlers.set(type, rest);
        };
      },
    },
  };
  return { context: context as unknown as Parameters<typeof createRealtimeTps>[0], bus };
}

function emit(bus: Bus, type: string, sessionID: string, delta: string, at: number) {
  for (const handler of bus.handlers.get(type) ?? []) {
    handler({ data: { sessionID, assistantMessageID: "msg_1", ordinal: 0, delta }, created: at });
  }
}

/** A controllable clock: `at` advances only when the test says so. */
function clock(start = 1_000_000) {
  let at = start;
  return { now: () => at, advance: (ms: number) => { at += ms; } };
}

describe("the realtime estimate", () => {
  test("estimates tokens from raw delta bytes, zero for an empty delta", () => {
    // Five bytes per token, rounded up, measured as sent — never trimmed. A
    // whitespace-only delta still moved the decoder, so `" "` counts one
    // token and `" abcde "` (7 bytes) counts two. An empty delta carries
    // nothing: 0, never 1. An ESTIMATE — the host publishes real counts only
    // at step end.
    expect(estimateDeltaTokens("")).toBe(0);
    expect(estimateDeltaTokens(" ")).toBe(1);
    expect(estimateDeltaTokens("abc")).toBe(1);
    expect(estimateDeltaTokens("abcde")).toBe(1);
    expect(estimateDeltaTokens(" abcde ")).toBe(2);
    expect(estimateDeltaTokens("abcdef")).toBe(2);
    expect(estimateDeltaTokens("x".repeat(500))).toBe(100);
    // Multibyte text counts bytes, not characters.
    expect(estimateDeltaTokens("é".repeat(3))).toBe(2);
  });

  test("a session never seen reads zero, never a guess", () => {
    const time = clock();
    const { context } = busContext();
    const tracker = createRealtimeTps(context, { now: time.now });
    expect(tracker.active).toBe(true);
    expect(tracker.rate("ghost", ["ghost"])).toBe(0);
    tracker.dispose();
  });

  test("one fresh sample paints immediately: samples ARE deltas, there are no baselines to set", () => {
    const time = clock();
    const { context, bus } = busContext();
    const tracker = createRealtimeTps(context, { now: time.now });
    // A 500-byte delta estimates 100 tokens; a lone sample covers a clamped
    // 1 s, so the first fresh read paints 100 tok/s outright.
    emit(bus, "session.text.delta", "s", "x".repeat(500), time.now());
    time.advance(1_000);
    expect(tracker.rate("s", ["s"])).toBe(100);
    tracker.dispose();
  });

  test("reasoning deltas count alongside text deltas", () => {
    const time = clock();
    const { context, bus } = busContext();
    const tracker = createRealtimeTps(context, { now: time.now });
    emit(bus, "session.reasoning.delta", "s", "x".repeat(500), time.now());
    time.advance(1_000);
    expect(tracker.rate("s", ["s"])).toBe(100);
    tracker.dispose();
  });

  test("deltas are additive and monotonic: no reset branch exists", () => {
    const time = clock();
    const { context, bus } = busContext();
    const tracker = createRealtimeTps(context, { now: time.now });
    // Two deltas at the same instant accumulate: 200 estimated tokens over
    // the clamped 1 s lone-sample window. Deltas only ever add — unlike the
    // old poll counters, there is nothing that can step backwards.
    emit(bus, "session.text.delta", "s", "x".repeat(500), time.now());
    emit(bus, "session.text.delta", "s", "x".repeat(500), time.now());
    time.advance(1_000);
    expect(tracker.rate("s", ["s"])).toBe(200);
    tracker.dispose();
  });

  test("staleness reads zero with the smoother untouched", () => {
    const time = clock();
    const { context, bus } = busContext();
    const tracker = createRealtimeTps(context, { now: time.now });
    emit(bus, "session.text.delta", "s", "x".repeat(500), time.now());
    time.advance(1_000);
    expect(tracker.rate("s", ["s"])).toBe(100);
    // Past the stale bound with no new sample: the decoder stopped, so the
    // rate is zero — and the smoother is untouched, so the next fresh sample
    // resumes from the held 100 rather than from zero.
    time.advance(RT_STALE_MS + 100);
    expect(tracker.rate("s", ["s"])).toBe(0);
    // Past the window the old sample prunes away, so the next burst divides
    // alone. A fresh 1000-token delta over a 1 s window is instant 1000:
    // EWMA bends 100 toward it (100 + 0.3 * 900 = 370), which is only
    // possible because the stale polls never moved the smoother.
    time.advance(RT_SAMPLE_WINDOW_MS);
    emit(bus, "session.text.delta", "s", "x".repeat(5000), time.now());
    time.advance(1_000);
    expect(tracker.rate("s", ["s"])).toBeCloseTo(370, 10);
    tracker.dispose();
  });

  test("samples past the window prune away", () => {
    const time = clock();
    const { context, bus } = busContext();
    const tracker = createRealtimeTps(context, { now: time.now });
    emit(bus, "session.text.delta", "s", "x".repeat(500), time.now());
    time.advance(1_000);
    expect(tracker.rate("s", ["s"])).toBe(100);
    time.advance(RT_SAMPLE_WINDOW_MS + 100);
    // The lone sample aged out of the ring: first sight again, reading zero.
    expect(tracker.rate("s", ["s"])).toBe(0);
    tracker.dispose();
  });

  test("family scope sums tokens over shared wall clock; session scope isolates", () => {
    const time = clock();
    const { context, bus } = busContext();
    const tracker = createRealtimeTps(context, { now: time.now });
    // Both sessions stream the same 100 estimated tokens over the same
    // 2 s window: the family paces their sum over the shared coverage.
    emit(bus, "session.text.delta", "root", "x".repeat(500), time.now());
    emit(bus, "session.text.delta", "child", "x".repeat(500), time.now());
    time.advance(1_000);
    // Smoothing state is per displayed session, so the two scopes read
    // through separate keys and never bend each other.
    const session = tracker.rate("root-session", ["root"]);
    const family = tracker.rate("root-family", ["root", "child"]);
    expect(session).toBe(100);
    // Twice the tokens over (nearly) the same wall clock: the family paces
    // both decoders, the way `elapsed` unions their spans.
    expect(family).toBeGreaterThan(session * 1.5);
    tracker.dispose();
  });

  test("a stale member contributes nothing to its family", () => {
    const time = clock();
    const { context, bus } = busContext();
    const tracker = createRealtimeTps(context, { now: time.now });
    emit(bus, "session.text.delta", "root", "x".repeat(500), time.now());
    time.advance(RT_STALE_MS + 100);
    emit(bus, "session.text.delta", "child", "x".repeat(500), time.now());
    time.advance(1_000);
    // The root's sample is stale; only the child's fresh 100 tokens over its
    // 1 s window divide.
    expect(tracker.rate("root", ["root", "child"])).toBe(100);
    tracker.dispose();
  });

  test("the session map evicts instead of growing forever", () => {
    const time = clock();
    const { context, bus } = busContext();
    const tracker = createRealtimeTps(context, { now: time.now });
    expect(RT_MAX_SESSIONS).toBe(50);
    emit(bus, "session.text.delta", "first", "x".repeat(500), time.now());
    time.advance(1_000);
    expect(tracker.rate("first", ["first"])).toBe(100);
    for (let index = 0; index < RT_MAX_SESSIONS; index += 1) {
      emit(bus, "session.text.delta", `s${index}`, "x", time.now());
    }
    // "first" was pushed out: the revisit reads zero, exactly like a first
    // sight — which is also what proves the eviction, since the surviving
    // samples would have divided.
    expect(tracker.rate("first", ["first"])).toBe(0);
    tracker.dispose();
  });

  test("the EWMA bends and the hysteresis holds through noise", () => {
    const time = clock();
    const { context, bus } = busContext();
    const tracker = createRealtimeTps(context, { now: time.now });
    // Burst one: 100 estimated tokens over 1 s paints 100.
    emit(bus, "session.text.delta", "s", "x".repeat(500), time.now());
    time.advance(1_000);
    expect(tracker.rate("s", ["s"])).toBe(100);
    // Burst two, past the window so the old samples prune: instant 103.
    // Smoothed 100 + 0.3 * 3 = 100.9: inside the hysteresis band (under 1
    // tok/s and under 10%), so the held 100 stands.
    time.advance(RT_SAMPLE_WINDOW_MS + 100);
    emit(bus, "session.text.delta", "s", "x".repeat(515), time.now());
    time.advance(1_000);
    expect(tracker.rate("s", ["s"])).toBe(100);
    expect(tpsNeedsRepaint(100, smoothTpsRate(100, 103, TPS_EWMA_ALPHA))).toBe(false);
    // Burst three, instant 500: 100.9 + 0.3 * ~400 clears the band and the
    // figure bends instead of replacing.
    time.advance(RT_SAMPLE_WINDOW_MS + 100);
    emit(bus, "session.text.delta", "s", "x".repeat(5000), time.now());
    time.advance(1_000);
    const bent = tracker.rate("s", ["s"]);
    expect(bent).toBeGreaterThan(100);
    expect(bent).toBeLessThan(500);
    tracker.dispose();
  });

  test("malformed events are skipped, never thrown on", () => {
    const time = clock();
    const { context, bus } = busContext();
    const tracker = createRealtimeTps(context, { now: time.now });
    for (const handler of bus.handlers.get("session.text.delta") ?? []) {
      expect(() => handler(undefined)).not.toThrow();
      expect(() => handler({})).not.toThrow();
      expect(() => handler({ data: { sessionID: "s" }, created: time.now() })).not.toThrow();
      expect(() => handler({ data: { delta: "x".repeat(10) }, created: time.now() })).not.toThrow();
      expect(() => handler({ data: { sessionID: "s", delta: 42 }, created: time.now() })).not.toThrow();
    }
    expect(tracker.rate("s", ["s"])).toBe(0);
    tracker.dispose();
  });

  test("no subscription surface degrades to a zero reader", () => {
    const missing = createRealtimeTps({} as unknown as Parameters<typeof createRealtimeTps>[0]);
    expect(missing.active).toBe(false);
    expect(missing.rate("s", ["s"])).toBe(0);
    expect(() => missing.dispose()).not.toThrow();

    const throwing = createRealtimeTps(busContext({ throwing: true }).context);
    expect(throwing.active).toBe(false);
    expect(throwing.rate("s", ["s"])).toBe(0);
    throwing.dispose();
  });

  test("disposal drops the subscriptions and stops the samples", () => {
    const time = clock();
    const { context, bus } = busContext();
    const tracker = createRealtimeTps(context, { now: time.now });
    expect(bus.handlers.get("session.text.delta")).toHaveLength(1);
    expect(bus.handlers.get("session.reasoning.delta")).toHaveLength(1);
    expect(bus.handlers.get("session.step.started")).toHaveLength(1);
    expect(bus.handlers.get("session.step.ended")).toHaveLength(1);
    expect(bus.handlers.get("session.step.failed")).toHaveLength(1);
    emit(bus, "session.text.delta", "s", "x".repeat(500), time.now());
    time.advance(1_000);
    expect(tracker.rate("s", ["s"])).toBe(100);
    tracker.dispose();
    // Idempotent, and the host handlers are gone.
    expect(() => tracker.dispose()).not.toThrow();
    expect(bus.handlers.get("session.text.delta")).toBeUndefined();
    expect(bus.handlers.get("session.reasoning.delta")).toBeUndefined();
    expect(bus.released).toHaveLength(5);
    // Late events go nowhere and the rate stays zero.
    emit(bus, "session.text.delta", "s", "x".repeat(5000), time.now());
    expect(tracker.rate("s", ["s"])).toBe(0);
  });
});

// Time to first token: per step, the first delta's event time minus the
// step's dispatch stamp — the oc-tps third figure, from the same event
// stream. Only steps observed while the plugin ran can count: the totals are
// in-memory, so a restart forgets them.
describe("the time to first token", () => {
  const step = (bus: Bus, type: string, sessionID: string, messageID: string, extra: Record<string, unknown>, at: number) => {
    for (const handler of bus.handlers.get(type) ?? []) {
      handler({ data: { sessionID, assistantMessageID: messageID, ...extra }, created: at });
    }
  };
  const started = (bus: Bus, sessionID: string, messageID: string, startedAt: number, at = startedAt) => {
    step(bus, "session.step.started", sessionID, messageID, { started: startedAt }, at);
  };
  const delta = (bus: Bus, sessionID: string, messageID: string, at: number, text = "x".repeat(500)) => {
    for (const handler of bus.handlers.get("session.text.delta") ?? []) {
      handler({ data: { sessionID, assistantMessageID: messageID, ordinal: 0, delta: text }, created: at });
    }
  };
  const ended = (bus: Bus, sessionID: string, messageID: string, at: number) => {
    step(bus, "session.step.ended", sessionID, messageID, { finish: "stop" }, at);
  };

  test("a step's ttft appears once the step settles, never while it streams", () => {
    const time = clock();
    const { context, bus } = busContext();
    const tracker = createRealtimeTps(context, { now: time.now });
    // Nothing measured yet: unknown, never a guess.
    expect(tracker.ttft(["s"])).toBeUndefined();
    started(bus, "s", "m1", 1_000);
    // A delta for another step finds no pending start and counts nothing.
    delta(bus, "s", "other", 2_200);
    expect(tracker.ttft(["s"])).toBeUndefined();
    delta(bus, "s", "m1", 2_200);
    // The first delta arrived but the step is still open: still unknown.
    expect(tracker.ttft(["s"])).toBeUndefined();
    ended(bus, "s", "m1", 3_000);
    expect(tracker.ttft(["s"])).toBeCloseTo(1.2, 10);
    tracker.dispose();
  });

  test("the earliest delta wins, however it arrives", () => {
    const time = clock();
    const { context, bus } = busContext();
    const tracker = createRealtimeTps(context, { now: time.now });
    started(bus, "s", "m1", 1_000);
    delta(bus, "s", "m1", 9_000);
    delta(bus, "s", "m1", 2_000);
    // A duplicate of the best stamp changes nothing.
    delta(bus, "s", "m1", 2_000);
    ended(bus, "s", "m1", 10_000);
    expect(tracker.ttft(["s"])).toBe(1);
    tracker.dispose();
  });

  test("means over settled steps, pooled per family and isolated per session", () => {
    const time = clock();
    const { context, bus } = busContext();
    const tracker = createRealtimeTps(context, { now: time.now });
    started(bus, "root", "m1", 0);
    delta(bus, "root", "m1", 1_000);
    ended(bus, "root", "m1", 2_000);
    started(bus, "child", "m2", 0);
    delta(bus, "child", "m2", 3_000);
    ended(bus, "child", "m2", 4_000);
    // Session scope: the displayed session's own ring alone.
    expect(tracker.ttft(["root"])).toBe(1);
    // Family scope: every member's rings pooled into one mean.
    expect(tracker.ttft(["root", "child"])).toBe(2);
    tracker.dispose();
  });

  test("a reasoning delta measures like a text delta", () => {
    const time = clock();
    const { context, bus } = busContext();
    const tracker = createRealtimeTps(context, { now: time.now });
    started(bus, "s", "m1", 500);
    for (const handler of bus.handlers.get("session.reasoning.delta") ?? []) {
      handler({ data: { sessionID: "s", assistantMessageID: "m1", ordinal: 0, delta: "x".repeat(10) }, created: 1_500 });
    }
    ended(bus, "s", "m1", 2_000);
    expect(tracker.ttft(["s"])).toBe(1);
    tracker.dispose();
  });

  test("a step that settles without a delta contributes nothing", () => {
    const time = clock();
    const { context, bus } = busContext();
    const tracker = createRealtimeTps(context, { now: time.now });
    started(bus, "s", "m1", 1_000);
    step(bus, "session.step.ended", "s", "m1", { finish: "stop" }, 9_000);
    expect(tracker.ttft(["s"])).toBeUndefined();
    // And a failed start is dropped the same way: a later delta for it finds
    // nothing pending.
    started(bus, "s", "m2", 1_000);
    step(bus, "session.step.failed", "s", "m2", {}, 2_000);
    delta(bus, "s", "m2", 5_000);
    expect(tracker.ttft(["s"])).toBeUndefined();
    tracker.dispose();
  });

  test("a skewed clock clamps at zero instead of subtracting time", () => {
    const time = clock();
    const { context, bus } = busContext();
    const tracker = createRealtimeTps(context, { now: time.now });
    started(bus, "s", "m1", 5_000);
    delta(bus, "s", "m1", 1_000);
    ended(bus, "s", "m1", 2_000);
    expect(tracker.ttft(["s"])).toBe(0);
    tracker.dispose();
  });

  test("malformed step events are skipped, never thrown on", () => {
    const time = clock();
    const { context, bus } = busContext();
    const tracker = createRealtimeTps(context, { now: time.now });
    for (const handler of bus.handlers.get("session.step.started") ?? []) {
      expect(() => handler(undefined)).not.toThrow();
      expect(() => handler({})).not.toThrow();
      expect(() => handler({ data: { sessionID: "s" }, created: 1_000 })).not.toThrow();
      expect(() => handler({ data: { sessionID: "s", assistantMessageID: "m1" }, created: 1_000 })).not.toThrow();
      expect(() => handler({ data: { sessionID: "s", assistantMessageID: "m1", started: -1 }, created: 1_000 })).not.toThrow();
    }
    for (const handler of bus.handlers.get("session.step.ended") ?? []) {
      expect(() => handler({ data: {}, created: 1_000 })).not.toThrow();
    }
    expect(tracker.ttft(["s"])).toBeUndefined();
    tracker.dispose();
  });

  test("an evicted pending entry simply omits that step", () => {
    const time = clock();
    const { context, bus } = busContext();
    const tracker = createRealtimeTps(context, { now: time.now });
    started(bus, "s", "m1", 1_000);
    delta(bus, "s", "m1", 3_000);
    // Fifty other pending steps push "s"'s out of the bounded map; each
    // settles without a delta so nothing else is measured.
    for (let index = 0; index < RT_MAX_SESSIONS; index += 1) {
      started(bus, `fill${index}`, `n${index}`, 0);
    }
    for (let index = 0; index < RT_MAX_SESSIONS; index += 1) {
      step(bus, "session.step.ended", `fill${index}`, `n${index}`, { finish: "stop" }, 1_000);
    }
    // The evicted step finalizes into nothing: unknown, never a fabricated
    // value — and the later, earlier-stamped delta finds no pending entry.
    delta(bus, "s", "m1", 2_000);
    step(bus, "session.step.ended", "s", "m1", { finish: "stop" }, 4_000);
    expect(tracker.ttft(["s"])).toBeUndefined();
    tracker.dispose();
  });

  test("the ring drops whole values oldest-first", () => {
    const time = clock();
    const { context, bus } = busContext();
    expect(RT_MAX_STEPS).toBe(100);
    const tracker = createRealtimeTps(context, { now: time.now });
    for (let index = 1; index <= RT_MAX_STEPS + 1; index += 1) {
      started(bus, "s", `m${index}`, 0);
      delta(bus, "s", `m${index}`, index * 1_000);
      ended(bus, "s", `m${index}`, index * 1_000 + 500);
    }
    // 101 steps measured 1s..101s; the ring keeps the newest 100, so the
    // mean is exactly (2 + .. + 101) / 100.
    expect(tracker.ttft(["s"])).toBe(51.5);
    tracker.dispose();
  });

  test("eviction interleavings stay exact with no negativity", () => {
    const time = clock();
    const { context, bus } = busContext();
    const tracker = createRealtimeTps(context, { now: time.now });
    // The old aggregate's first failure: total evicted between corrections.
    // Here the pending entry holds the earliest stamp itself, so settling
    // after any amount of other-session traffic still divides 1s exactly.
    started(bus, "s", "m1", 1_000);
    delta(bus, "s", "m1", 3_000);
    for (let index = 0; index < RT_MAX_SESSIONS; index += 1) {
      started(bus, `fill${index}`, `n${index}`, 0);
      delta(bus, `fill${index}`, `n${index}`, 500);
      step(bus, "session.step.ended", `fill${index}`, `n${index}`, { finish: "stop" }, 600);
    }
    delta(bus, "s", "m1", 2_000);
    ended(bus, "s", "m1", 4_000);
    expect(tracker.ttft(["s"])).toBe(1);
    // The old aggregate's second failure: recreation at 0.5s plus a
    // correction to 1s pooled to −0.5s. Here both steps are whole values —
    // the mean of 0.5 and 1 is 0.75 by construction, never negative.
    started(bus, "s", "m2", 0);
    delta(bus, "s", "m2", 500);
    ended(bus, "s", "m2", 1_000);
    expect(tracker.ttft(["s"])).toBe(0.75);
    expect(tracker.ttft(["s"])).toBeGreaterThanOrEqual(0);
    tracker.dispose();
  });

  test("disposal forgets pending steps and finalized rings", () => {
    const time = clock();
    const { context, bus } = busContext();
    const tracker = createRealtimeTps(context, { now: time.now });
    started(bus, "s", "m1", 0);
    delta(bus, "s", "m1", 1_000);
    ended(bus, "s", "m1", 2_000);
    expect(tracker.ttft(["s"])).toBe(1);
    tracker.dispose();
    expect(tracker.ttft(["s"])).toBeUndefined();
    // Late step events go nowhere.
    started(bus, "s", "m2", 0);
    delta(bus, "s", "m2", 1_000);
    step(bus, "session.step.ended", "s", "m2", { finish: "stop" }, 2_000);
    expect(tracker.ttft(["s"])).toBeUndefined();
  });
});
