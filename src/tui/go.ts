// Live Zen Go usage for the Flight Deck `go` row.
//
// This is the poll bridge only. The model it writes (./go-usage.ts) is pure; the
// row renderer is Stage 2. Shape is deliberately cloned from ./guard.ts — poll
// into the host's memory store, expose a reactive getter, never throw — with
// the differences the account-wide scope forces:
//
//   * Guard is per-session, so it waits for `follow(sessionID)` before fetching.
//     Go usage is account-wide: one API key, one shared quota, no session to
//     target — so the timer starts at construction and there is no `follow`.
//   * The key is read on every poll through the same env accessor the Zen Go
//     client uses, so a key loaded or rotated after startup is picked up
//     without a restart.
//
// Why the store bridge at all is documented in ./guard.ts and ./ticker.ts: the
// host's Solid and the plugin's are separate module instances, so only the
// host-owned `context.storage.memory` store can wake the host render.
//
// The bridge never throws. Any failure — no store, no key, refused request,
// non-OK status, malformed JSON — stores `null`, which the getter reads as
// `undefined` so the persist layer renders the placeholder. A missing key is
// explicitly not an error: it is the row's documented "no key" dash path.

import { normalizeGoUsage, type GoUsage } from "./go-usage.js";

/** The value kept in the host's memory store. Null means "no data". */
interface GoStoreState {
  value: GoUsage | null;
}

/** The store the host hands back: read-only to us, reactive to the host. */
interface GoStore {
  readonly value?: unknown;
}

/** The mutation function the host hands back. */
type GoUpdate = (mutation: (draft: GoStoreState) => void) => void;

/** The one host capability the bridge needs, so it stays trivially stubbable. */
export interface GoHost {
  readonly storage?: {
    /**
     * Typed as `unknown` on the return on purpose: this is reached across a
     * beta version boundary, so the shape is checked at runtime instead of
     * trusted from a type that may not match the binary.
     */
    memory(key: string, options: { readonly initial: GoStoreState }): unknown;
  };
}

/** Injectable key accessor and fetch, so tests never touch the network or env. */
export interface GoDeps {
  readonly key?: () => string | undefined;
  readonly fetchJson?: (url: string, init: RequestInit) => Promise<unknown>;
}

interface GoBridge {
  /**
   * Current usage, read from the host's store.
   *
   * This must be read inside the slot render, while the host's reactive scope
   * is active, or it will not register as a dependency and nothing will update.
   * `undefined` means no data, so the persist layer renders the placeholder.
   */
  readonly usage: GoUsage | undefined;
  /** Stops the timer. Safe to call more than once. */
  dispose(): void;
}

/** Namespaced so it cannot collide with another plugin's memory keys. */
export const GO_KEY = "flight-deck.go";

/**
 * How often the bridge re-reads usage.
 *
 * Account-wide quota moves far more slowly than per-session telemetry, and the
 * endpoint is remote, so a poll per minute keeps the row fresh without a
 * request storm. Deliberately not `config.refresh` (that drives the spinner).
 */
export const GO_POLL_MS = 60_000;

/** The Zen Go usage endpoint. Fixed: usage is account-wide, not per-session. */
export const GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";

/** The env var the Zen Go client reads its key from, matched by name only. */
export const GO_KEY_ENV = "OPENCODE_GO_API_KEY";

const GO_TIMEOUT_MS = 10_000;

/**
 * Fetch and parse a usage payload. A non-OK response throws so the poll's one
 * catch handles both transport and status failures; the body is only parsed
 * once the status is known good.
 */
async function defaultFetchJson(url: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`go usage: HTTP ${response.status}`);
  return response.json();
}

// A host whose store does not match the documented shape is treated as no store
// at all: half-opening one would throw on every poll instead of degrading.
// Validated exactly as ./ticker.ts and ./guard.ts validate theirs.
function openStore(storage: NonNullable<GoHost["storage"]>): { store: GoStore; update: GoUpdate } | undefined {
  let opened: unknown;
  try {
    opened = storage.memory(GO_KEY, { initial: { value: null } });
  } catch {
    return undefined;
  }

  if (!Array.isArray(opened) || opened.length < 2) return undefined;
  const [store, update] = opened as [unknown, unknown];
  if (store === null || typeof store !== "object") return undefined;
  if (typeof update !== "function") return undefined;

  return { store: store as GoStore, update: update as GoUpdate };
}

function readUsage(store: GoStore | undefined): GoUsage | undefined {
  try {
    const value = store?.value;
    if (value === null || value === undefined) return undefined;
    return normalizeGoUsage(value);
  } catch {
    return undefined;
  }
}

function writeValue(opened: { store: GoStore; update: GoUpdate }, value: GoUsage | null): boolean {
  try {
    opened.update((draft) => {
      draft.value = value;
    });
    return true;
  } catch {
    return false;
  }
}

function resolveKeyFn(deps: GoDeps | undefined): () => string | undefined {
  if (deps !== undefined) {
    try {
      if (typeof deps.key === "function") return deps.key;
    } catch {
      // fall through to the env accessor
    }
  }
  return () => process.env[GO_KEY_ENV];
}

function resolveFetchJson(deps: GoDeps | undefined): (url: string, init: RequestInit) => Promise<unknown> {
  if (deps !== undefined) {
    try {
      if (typeof deps.fetchJson === "function") return deps.fetchJson;
    } catch {
      // fall through to the real fetch
    }
  }
  return defaultFetchJson;
}

/**
 * Start polling Go usage into the host's memory store, or return `undefined`
 * when there is no usable store.
 *
 * Unlike ./guard.ts there is no `follow`: usage is account-wide, so the timer
 * starts here and reads the key afresh on every poll. The first poll fires
 * immediately so the row populates without waiting a full interval.
 *
 * Assumption: `deps` is a test-only override. Production omits it, so the
 * accessor is `process.env[GO_KEY_ENV]` on each poll (late keys recover) and
 * the request is the real `fetch` with a bounded timeout.
 */
export function startGoBridge(
  host: GoHost | undefined,
  deps?: GoDeps | undefined,
  intervalMs: number = GO_POLL_MS,
): GoBridge | undefined {
  const storage = host?.storage;
  if (host === undefined || storage === undefined || typeof storage.memory !== "function") return undefined;

  const opened = openStore(storage);
  if (opened === undefined) return undefined;

  const cadence = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : GO_POLL_MS;
  const keyFn = resolveKeyFn(deps);
  const fetchJson = resolveFetchJson(deps);

  let timer: ReturnType<typeof setInterval> | undefined;
  // Generation invalidated on dispose, so a poll that outlives its bridge —
  // after disposal or a hot reload where the host store is shared — cannot
  // overwrite newer data.
  let generation = 0;
  // Monotonic request sequence so overlapping polls resolve in start order, not
  // finish order: only the newest request of the current generation may write.
  let nextSeq = 0;
  let latestSeq = 0;
  let disposed = false;

  const stopTimer = (): void => {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
  };

  const poll = async (): Promise<void> => {
    if (disposed) return;
    const myGeneration = generation;
    const mySeq = ++nextSeq;
    latestSeq = mySeq;
    const stillCurrent = () => myGeneration === generation && mySeq === latestSeq && !disposed;

    let key: string | undefined;
    try {
      key = keyFn();
    } catch {
      key = undefined;
    }
    // No key is the row's "no key" dash path, not an error: store null and
    // make no request, so a keyless install never touches the endpoint.
    if (typeof key !== "string" || key.length === 0) {
      if (!stillCurrent()) return;
      if (!writeValue(opened, null)) stopTimer();
      return;
    }

    let raw: unknown;
    try {
      raw = await fetchJson(GO_USAGE_URL, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(GO_TIMEOUT_MS),
      });
    } catch {
      // Refused, timed out, non-OK status, or a transport failure: no data,
      // not an error.
      if (!stillCurrent()) return;
      if (!writeValue(opened, null)) stopTimer();
      return;
    }
    if (!stillCurrent()) return;
    let normalized: GoUsage | null;
    try {
      normalized = normalizeGoUsage(raw) ?? null;
    } catch {
      normalized = null;
    }
    if (!writeValue(opened, normalized)) stopTimer();
  };

  timer = setInterval(() => {
    void poll();
  }, cadence);
  // Populate the row now instead of after the first full cadence.
  void poll();

  return {
    get usage() {
      return readUsage(opened.store);
    },
    dispose() {
      disposed = true;
      generation += 1;
      stopTimer();
    },
  };
}
