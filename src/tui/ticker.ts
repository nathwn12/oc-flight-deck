// The animation tick that drives Flight Deck's clock-derived rows.
//
// Why this is not a `createSignal`:
//
// The host's Solid is compiled into the `opencode2` binary. This plugin
// resolves its own `solid-js` from the npm cache, because the plugin packaging
// model has plugins supply their own renderer peers. Those are two module
// instances, and Solid keeps its dependency tracking in module state — so a
// signal created in one instance is invisible to an effect owned by the other.
// A `setInterval` + `createSignal` ticker therefore advanced a counter that
// nothing was listening to: `elapsed` sat frozen and the spinner never turned.
//
// `context.storage.memory` is the documented bridge. It returns a store owned
// by the *host's* Solid, so writing it from a timer notifies the host's render,
// and reading it inside the slot render registers the dependency that makes the
// rail re-run on that schedule.
//
// This is the only state the plugin writes, and it is deliberately the
// smallest, most disposable surface available: ephemeral, in-process, scoped to
// this plugin, gone when the TUI exits. Not the durable store, not a session,
// not a file, not the network.
//
// The tick serves the spinner first, but the spinner is only drawn while work
// is happening. When nothing is moving the store is written about once a second
// instead of on every interval — see `IDLE_REFRESH_MS` — so the host's reactive
// graph is woken a tenth as often for a picture that has not changed.
//
// The host is a beta and its store is reached across a version boundary, so
// everything about it is validated at runtime and every failure path degrades to
// "no ticker" rather than raising into the TUI.

/** The value kept in the host's memory store. A single monotonic counter. */
interface FrameState {
  frame: number;
}

/** The store the host hands back: read-only to us, reactive to the host. */
interface FrameStore {
  readonly frame?: unknown;
}

/** The mutation function the host hands back. */
type FrameUpdate = (mutation: (draft: FrameState) => void) => void;

/** The one host capability the ticker needs, so it stays trivially stubbable. */
export interface TickerHost {
  readonly storage?: {
    /**
     * Typed as `unknown` on purpose: this is the one host call reached across a
     * beta version boundary, so the shape is checked at runtime instead of
     * trusted from a type that may not match the binary.
     */
    memory(key: string, options: { readonly initial: FrameState }): unknown;
  };
}

export interface Ticker {
  /**
   * Current frame, read from the host's store.
   *
   * This must be read inside the slot render, while the host's reactive scope
   * is active, or it will not register as a dependency and nothing will update.
   */
  readonly frame: number;
  /** Stops the timer. Safe to call once; the plugin calls it on cleanup. */
  dispose(): void;
}

/** Namespaced so it cannot collide with another plugin's memory keys. */
export const TICKER_KEY = "flight-deck.frame";

/**
 * How often the frame still advances while nothing is moving.
 *
 * The spinner needs ~10 frames a second, but it is only drawn while work is
 * happening. When idle, only `elapsed` and the annunciator still need a tick,
 * and both read in whole seconds — so the host renderer is woken once a second
 * instead of ten times. The timer itself keeps firing (cheap); it is the store
 * write, which wakes the host's reactive graph, that is skipped.
 */
export const IDLE_REFRESH_MS = 1_000;

// Untrusted store values are normalised here rather than at the render, so a
// corrupt frame can never reach the spinner's array index.
function readFrame(store: FrameStore | undefined): number {
  const value = store?.frame;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

// A host whose store does not match the documented shape is treated as no store
// at all: half-opening one would throw on every tick instead of degrading.
function openStore(storage: NonNullable<TickerHost["storage"]>): { store: FrameStore; update: FrameUpdate } | undefined {
  let opened: unknown;
  try {
    opened = storage.memory(TICKER_KEY, { initial: { frame: 0 } });
  } catch {
    return undefined;
  }

  if (!Array.isArray(opened) || opened.length < 2) return undefined;
  const [store, update] = opened as [unknown, unknown];
  if (store === null || typeof store !== "object") return undefined;
  if (typeof update !== "function") return undefined;

  return { store: store as FrameStore, update: update as FrameUpdate };
}

/**
 * Start the animation tick, or return `undefined` when it is switched off.
 *
 * A missing or unusable host store is not an error: the rail then updates only
 * on host events, which is exactly how it behaved before the ticker was fixed.
 * Degrading quietly keeps a cosmetic panel from ever breaking the TUI.
 */
export function startTicker(
  host: TickerHost | undefined,
  intervalMs: number,
  isBusy: () => boolean = () => true,
): Ticker | undefined {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return undefined;

  const storage = host?.storage;
  if (storage === undefined || typeof storage.memory !== "function") return undefined;

  const opened = openStore(storage);
  if (opened === undefined) return undefined;

  const idleEvery = Math.max(1, Math.round(IDLE_REFRESH_MS / intervalMs));
  let ticks = 0;

  let timer: ReturnType<typeof setInterval> | undefined = setInterval(() => {
    ticks += 1;

    // A broken busy predicate must never freeze the spinner, so it degrades to
    // "busy" rather than propagating.
    let busy = true;
    try {
      busy = isBusy();
    } catch {
      busy = true;
    }
    // While idle, skip the store write on all but every `idleEvery`th tick.
    if (!busy && ticks % idleEvery !== 0) return;

    try {
      opened.update((draft) => {
        draft.frame = readFrame(draft) + 1;
      });
    } catch {
      // A store that starts failing mid-run must not raise on every tick
      // forever. Put the timer down and let the rail fall back to host events.
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    }
  }, intervalMs);

  return {
    get frame() {
      return readFrame(opened.store);
    },
    dispose() {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    },
  };
}
