import { describe, expect, test } from "bun:test";
import {
  createRealtimeTps,
  estimateDeltaTokens,
  RT_MAX_SESSIONS,
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
function busContext(opts?: { now?: () => number; throwing?: boolean }) {
  const bus: Bus = { handlers: new Map(), released: [] };
  const context = {
    data: {
      on: (type: string, handler: Handler) => {
        if (opts?.throwing === true) throw new Error("no subscription surface");
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
  test("estimates tokens from delta bytes, at least one per delta", () => {
    // Five bytes per token, rounded up; every delta moved the decoder, so
    // even an empty one counts one. An ESTIMATE — the host publishes real
    // counts only at step end.
    expect(estimateDeltaTokens("")).toBe(1);
    expect(estimateDeltaTokens("abc")).toBe(1);
    expect(estimateDeltaTokens("abcde")).toBe(1);
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
    emit(bus, "session.text.delta", "s", "x".repeat(500), time.now());
    time.advance(1_000);
    expect(tracker.rate("s", ["s"])).toBe(100);
    tracker.dispose();
    // Idempotent, and the host handlers are gone.
    expect(() => tracker.dispose()).not.toThrow();
    expect(bus.handlers.get("session.text.delta")).toBeUndefined();
    expect(bus.handlers.get("session.reasoning.delta")).toBeUndefined();
    expect(bus.released).toHaveLength(2);
    // Late events go nowhere and the rate stays zero.
    emit(bus, "session.text.delta", "s", "x".repeat(5000), time.now());
    expect(tracker.rate("s", ["s"])).toBe(0);
  });
});
