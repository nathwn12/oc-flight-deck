// The animation tick is small but load-bearing: it is the only thing that makes
// `elapsed` move and the spinner turn, and it is the plugin's only write.

import { describe, expect, test } from "bun:test";
// The client build by path: the bare specifier resolves to the SSR build, which
// has no reactive graph, so effects never run under it. See ./solid-client.d.ts.
import { createRenderEffect, createRoot, createSignal } from "solid-js/dist/solid.js";
import { startTicker, TICKER_KEY, type TickerHost } from "../src/tui/ticker.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A plain-object store: enough to pin wiring, disposal, and the degrade paths. */
function fakeHost(initialFrame = 0) {
  const state = { frame: initialFrame };
  const seen: { keys: string[]; writes: number } = { keys: [], writes: 0 };
  const host: TickerHost = {
    storage: {
      memory: (key: string, options: { readonly initial: { frame: number } }) => {
        seen.keys.push(key);
        state.frame = options.initial.frame;
        return [
          state,
          (mutation: (draft: { frame: number }) => void) => {
            seen.writes += 1;
            mutation(state);
          },
        ];
      },
    },
  };
  return { host, state, seen };
}

// A host store built on the client build's own signal, so the store and the
// reader share one reactive instance.
//
// `solid-js/store` cannot be used here: it imports the bare specifier
// internally, which lands on the SSR core, and the reader would then be a
// different instance from the store. That is precisely the split this plugin
// exists to work around, and it is why the store is hand-built from a signal.
function reactiveHost(): TickerHost {
  const [state, setState] = createSignal({ frame: 0 });
  return {
    storage: {
      memory: () => {
        const store = {
          get frame() {
            return state().frame;
          },
        };
        const update = (mutation: (draft: { frame: number }) => void) =>
          setState((previous) => {
            const next = { ...previous };
            mutation(next);
            return next;
          });
        return [store, update];
      },
    },
  };
}

describe("flight deck ticker", () => {
  // The property the whole design rests on: `Ticker.frame`'s getter reads through
  // to the host's store, so a reader inside the host's reactive scope registers a
  // dependency and a write from our timer wakes it. If anyone ever "optimises"
  // this into a cached counter, or moves the read out of the slot render, the
  // rail silently freezes again — and this is the only thing that would notice.
  test("a tick re-runs a real reactive reader of the host store", async () => {
    const ticker = startTicker(reactiveHost(), 5);
    expect(ticker).toBeDefined();

    let reads = 0;
    let lastSeen = -1;
    await createRoot(async (dispose) => {
      createRenderEffect(() => {
        reads += 1;
        lastSeen = ticker!.frame;
      });
      await sleep(60);
      dispose();
    });

    // The initial run plus at least two ticks. A non-reactive getter stays at 1.
    expect(reads).toBeGreaterThanOrEqual(3);
    expect(lastSeen).toBeGreaterThanOrEqual(2);
    ticker?.dispose();
  });

  test("dispose stops waking that reader", async () => {
    const ticker = startTicker(reactiveHost(), 5);
    let reads = 0;
    await createRoot(async (dispose) => {
      createRenderEffect(() => {
        reads += 1;
        void ticker?.frame;
      });
      await sleep(40);
      ticker?.dispose();
      const settled = reads;
      await sleep(40);
      expect(reads).toBe(settled);
      dispose();
    });
  });

  test("advances the host store on a schedule and stops on dispose", async () => {
    const { host, state, seen } = fakeHost();

    const ticker = startTicker(host, 5);
    expect(ticker).toBeDefined();
    expect(ticker?.frame).toBe(0);
    expect(seen.keys).toEqual([TICKER_KEY]);

    await sleep(60);
    const running = ticker!.frame;
    expect(running).toBeGreaterThan(0);
    expect(state.frame).toBe(running);

    ticker?.dispose();
    const frozen = ticker!.frame;
    await sleep(40);
    // Disposal must actually stop the timer, not merely stop reporting.
    expect(ticker?.frame).toBe(frozen);
    expect(state.frame).toBe(frozen);
  });

  // The rail must read the host's value, not a private counter: reading the host
  // store inside the render is the whole mechanism that makes it re-render.
  test("reports whatever the host store currently holds", () => {
    const { host, state } = fakeHost();
    const ticker = startTicker(host, 5);

    state.frame = 7;
    expect(ticker?.frame).toBe(7);
    state.frame = 0;
    expect(ticker?.frame).toBe(0);
    ticker?.dispose();
  });

  test("normalises a corrupt frame instead of rendering NaN or undefined", () => {
    const { host, state } = fakeHost();
    const ticker = startTicker(host, 5);

    for (const value of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
      state.frame = value as number;
      expect(ticker?.frame).toBe(0);
    }
    // A fractional frame would index the spinner's frame list with a
    // non-integer, which renders the literal text `undefined`.
    state.frame = 2.7;
    expect(ticker?.frame).toBe(2);
    delete (state as { frame?: number }).frame;
    expect(ticker?.frame).toBe(0);
    ticker?.dispose();
  });

  test("is opt-out, and opts out cleanly", () => {
    const { host, seen } = fakeHost();
    for (const interval of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(startTicker(host, interval)).toBeUndefined();
    }
    // Nothing should have been claimed from the host at all.
    expect(seen.keys).toEqual([]);
  });

  test("degrades to no ticker rather than breaking the TUI", () => {
    // A host that predates this API, or one whose store refuses to open.
    expect(startTicker(undefined, 100)).toBeUndefined();
    expect(startTicker({}, 100)).toBeUndefined();
    expect(startTicker({ storage: {} } as TickerHost, 100)).toBeUndefined();
    expect(
      startTicker(
        {
          storage: {
            memory: () => {
              throw new Error("no store for you");
            },
          },
        } as TickerHost,
        100,
      ),
    ).toBeUndefined();
  });

  // A half-open store would otherwise throw on every single tick.
  test("treats a malformed host store as no store", () => {
    for (const returned of [undefined, {}, "nonsense", [undefined], [{ frame: 0 }], [{ frame: 0 }, null], [null, () => {}]]) {
      const host = { storage: { memory: () => returned } } as TickerHost;
      expect(startTicker(host, 100)).toBeUndefined();
    }
  });

  test("stops itself rather than raising on every tick when the store fails", async () => {
    let calls = 0;
    const host: TickerHost = {
      storage: {
        memory: () => {
          const store = { frame: 0 };
          return [
            store,
            () => {
              calls += 1;
              throw new Error("store closed");
            },
          ];
        },
      },
    };

    const ticker = startTicker(host, 5);
    expect(ticker).toBeDefined();
    await sleep(60);

    expect(calls).toBe(1);
    expect(ticker?.frame).toBe(0);
    ticker?.dispose();
  });

  test("keeps its store key namespaced to this plugin", () => {
    // Pinned literally: a coordinated rename would otherwise pass unnoticed and
    // collide with another plugin's key.
    expect(TICKER_KEY).toBe("flight-deck.frame");
  });

  // The spinner is the only reason the tick exists, and it is hidden while
  // nothing is running. When idle the store write is skipped on all but one tick
  // a second, so the host's reactive graph is not woken for an unchanged picture.
  test("backs the store write off while nothing is running", async () => {
    const idle = fakeHost();
    const idleTicker = startTicker(idle.host, 5, () => false);
    expect(idleTicker).toBeDefined();
    await sleep(60);
    expect(idle.seen.writes).toBe(0);
    idleTicker?.dispose();

    const busy = fakeHost();
    const busyTicker = startTicker(busy.host, 5, () => true);
    expect(busyTicker).toBeDefined();
    await sleep(60);
    expect(busy.seen.writes).toBeGreaterThanOrEqual(5);

    // Disposal still stops the timer, not merely the reporting.
    busyTicker?.dispose();
    const frozen = busy.seen.writes;
    await sleep(40);
    expect(busy.seen.writes).toBe(frozen);
  });
});
