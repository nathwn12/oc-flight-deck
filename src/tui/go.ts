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
//   * The key is resolved on every poll - first from the host's own credential
//     store, then the `OPENCODE_GO_API_KEY` env var - so a key loaded, rotated,
//     or activated after startup is picked up without a restart.
//
// Why the store bridge at all is documented in ./guard.ts and ./ticker.ts: the
// host's Solid and the plugin's are separate module instances, so only the
// host-owned `context.storage.memory` store can wake the host render.
//
// The bridge never throws. Any failure - no store, no key, refused request,
// non-OK status, malformed JSON - stores `null`, which the getter reads as
// `undefined` so the persist layer renders the placeholder. A missing key is
// explicitly not an error: it is the row's documented "no key" dash path.
//
// A blank panel must never be silent about WHY it is blank, so the store also
// carries a {@link GoNoDataReason} beside the null value: the bridge records
// which stage failed (see the type) and exposes it as `reason`. The two are
// written together, so a reader can never see a null value with a stale reason.

import { normalizeGoUsage, type GoUsage } from "./go-usage.js";

/**
 * Why the bridge has no usage to show.
 *
 * Additive to `value`: a reader that only wants the usage is unchanged, while
 * a surface that has to explain a blank panel reads this alongside it. The set
 * is closed so a renderer can trust it, and each value names the failed stage,
 * not a symptom:
 *
 *   * `"no-client"` - the host's credential client was absent, or it answered
 *     with something that was not a usable list (a throw or a non-array). The
 *     key lookup never had a chance to run.
 *   * `"no-key"`    - the credential client answered, but held no usable
 *     `opencode-go` key entry, and no `OPENCODE_GO_API_KEY` fallback was set.
 *   * `"http"`      - a key was resolved and the usage request threw or came
 *     back non-OK.
 *   * `"parse"`     - the request succeeded but the body did not normalize into
 *     any known window shape.
 */
export type GoNoDataReason = "no-client" | "no-key" | "http" | "parse";

/** The value kept in the host's memory store. Null means "no data". */
interface GoStoreState {
  value: GoUsage | null;
  /**
   * Why `value` is null, or null when there is a value (or the reason is not
   * yet known). Written atomically with `value` so the two never disagree.
   */
  reason: GoNoDataReason | null;
}

/** The store the host hands back: read-only to us, reactive to the host. */
interface GoStore {
  readonly value?: unknown;
  readonly reason?: unknown;
}

/** The mutation function the host hands back. */
type GoUpdate = (mutation: (draft: GoStoreState) => void) => void;

/**
 * The credential store as the bridge reads it.
 *
 * Minimal on purpose, like `storage` above: the bridge needs one capability, so
 * it names one capability and stays trivially stubbable. It is no longer a
 * stand-in for a declaration the pin lacked - the pinned `@opencode/plugin`
 * client (`@opencode/client` 2.0.26) declares `credential.list()`, so the call
 * below is direct and type-checked. The runtime `typeof list === "function"`
 * check stays because the host binary is what actually answers: a host whose
 * client predates the method falls through to the env var instead of throwing.
 */
interface GoCredentialClient {
  readonly credential?: GoCredentialStore;
}

/**
 * The one method the bridge calls on the credential group.
 *
 * The return stays `unknown` deliberately: the payload arrives over the wire
 * and is validated entry by entry at runtime, so trusting a declared element
 * type here would only move the failure into the loop.
 */
interface GoCredentialStore {
  readonly list: () => Promise<unknown>;
}

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
  /** The host's HTTP client, reached only for its credential store. */
  readonly client?: GoCredentialClient;
}

/** Injectable key accessor and fetch, so tests never touch the network or env. */
export interface GoDeps {
  /** Synchronous key override; short-circuits the store and the env var. */
  readonly key?: () => string | undefined;
  /** Async key override; used when `key` is absent, ahead of the store/env. */
  readonly resolveKey?: () => Promise<string | undefined>;
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
  /**
   * Why {@link usage} is `undefined`, or `undefined` when there IS a value (or
   * the reason is not yet known). Read it inside the same render as `usage` so
   * the host registers the dependency and a blank panel can name its cause.
   */
  readonly reason: GoNoDataReason | undefined;
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

/**
 * The env var the Zen Go client reads its key from, matched by name only.
 *
 * Since 0.14.0 this is a fallback: the bridge reads the host's credential store
 * first and only falls back here when the store holds no usable entry.
 */
export const GO_KEY_ENV = "OPENCODE_GO_API_KEY";

/**
 * The integration id the Zen Go provider stores its credential under. The
 * provider id and the integration id are the same string, so this is the one
 * value that selects the right entry out of `credential.list()`.
 */
const GO_INTEGRATION_ID = "opencode-go";

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
    opened = storage.memory(GO_KEY, { initial: { value: null, reason: null } });
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

/** The closed set of reasons, so a corrupt store value can never leak through. */
const GO_NO_DATA_REASONS: readonly GoNoDataReason[] = ["no-client", "no-key", "http", "parse"];

/**
 * Why the store has no value, or `undefined` when it has one or the reason is
 * unreadable. Validated against the closed set for the same reason the frame
 * and usage are: the store is reached across a version boundary and may be
 * written by a hot-reloaded sibling.
 */
function readReason(store: GoStore | undefined): GoNoDataReason | undefined {
  try {
    const reason = store?.reason;
    if (typeof reason !== "string") return undefined;
    return (GO_NO_DATA_REASONS as readonly string[]).includes(reason) ? (reason as GoNoDataReason) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Write the value and its reason as one mutation, so a reader can never observe
 * a null value paired with a stale reason. A non-null value always clears the
 * reason; a null value carries the reason that produced it.
 */
function writeValue(
  opened: { store: GoStore; update: GoUpdate },
  value: GoUsage | null,
  reason: GoNoDataReason,
): boolean {
  try {
    opened.update((draft) => {
      draft.value = value;
      draft.reason = value === null ? reason : null;
    });
    return true;
  } catch {
    return false;
  }
}

function resolveKeyFn(deps: GoDeps | undefined): (() => string | undefined) | undefined {
  if (deps !== undefined) {
    try {
      if (typeof deps.key === "function") return deps.key;
    } catch {
      // fall through to the async override, the store, then the env var
    }
  }
  return undefined;
}

function resolveAsyncKeyFn(deps: GoDeps | undefined): (() => Promise<string | undefined>) | undefined {
  if (deps !== undefined) {
    try {
      if (typeof deps.resolveKey === "function") return deps.resolveKey;
    } catch {
      // fall through to the store, then the env var
    }
  }
  return undefined;
}

/** A credential entry's key, or undefined unless it is a usable `key` value. */
function keyOfValue(value: unknown): string | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (record["type"] !== "key") return undefined;
  const key = record["key"];
  return typeof key === "string" && key.length > 0 ? key : undefined;
}

/**
 * The Zen Go key held in the host's own credential store, plus whether that
 * store was usable at all.
 *
 * Never throws and never logs. `unavailable` is true when the credential client
 * was absent, its `list` was not a function, the call threw, or it answered
 * with a non-array - in every one of those cases the lookup never had a fair
 * chance, which is the `"no-client"` reason. `unavailable` false with no `key`
 * means the store answered and genuinely held no usable entry (`"no-key"`).
 * Among matching entries the `active` one wins; otherwise the first usable one.
 */
async function credentialKey(
  client: GoHost["client"],
): Promise<{ key?: string; unavailable: boolean }> {
  try {
    const store = client?.credential;
    if (store === undefined || typeof store.list !== "function") return { unavailable: true };
    const entries = await store.list();
    if (!Array.isArray(entries)) return { unavailable: true };
    let firstMatch: string | undefined;
    for (const entry of entries) {
      if (entry === null || typeof entry !== "object") continue;
      const record = entry as Record<string, unknown>;
      if (record["integrationID"] !== GO_INTEGRATION_ID) continue;
      const key = keyOfValue(record["value"]);
      if (key === undefined) continue;
      if (record["active"] === true) return { key, unavailable: false };
      if (firstMatch === undefined) firstMatch = key;
    }
    return firstMatch === undefined ? { unavailable: false } : { key: firstMatch, unavailable: false };
  } catch {
    return { unavailable: true };
  }
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
 * Assumption: `deps` is a test-only override. Production omits it, so on each
 * poll the key is resolved from the host's credential store and then from
 * `process.env[GO_KEY_ENV]` (late or rotated keys recover), and the request is
 * the real `fetch` with a bounded timeout.
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
  const asyncKeyFn = resolveAsyncKeyFn(deps);
  const fetchJson = resolveFetchJson(deps);
  const client = host.client;

  // The key source, in order: an injected override (`key`, then `resolveKey`),
  // the host's credential store, then the env var. Never throws. When nothing
  // yields a key the result names WHY, so the blank panel is not silent: a
  // usable store that held no entry is `"no-key"`, a store that could not be
  // asked at all is `"no-client"`.
  const readKey = async (): Promise<{ key?: string; reason?: GoNoDataReason }> => {
    if (keyFn !== undefined) {
      try {
        const key = keyFn();
        return typeof key === "string" && key.length > 0 ? { key } : { reason: "no-key" };
      } catch {
        return { reason: "no-key" };
      }
    }
    if (asyncKeyFn !== undefined) {
      try {
        const key = await asyncKeyFn();
        return typeof key === "string" && key.length > 0 ? { key } : { reason: "no-key" };
      } catch {
        return { reason: "no-key" };
      }
    }
    const stored = await credentialKey(client);
    if (typeof stored.key === "string" && stored.key.length > 0) return { key: stored.key };
    const env = process.env[GO_KEY_ENV];
    if (typeof env === "string" && env.length > 0) return { key: env };
    return { reason: stored.unavailable ? "no-client" : "no-key" };
  };

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
    let keyReason: GoNoDataReason = "no-key";
    try {
      const resolved = await readKey();
      key = resolved.key;
      if (resolved.reason !== undefined) keyReason = resolved.reason;
    } catch {
      key = undefined;
    }
    // No key is the row's "no key" dash path, not an error: store null and
    // make no request, so a keyless install never touches the endpoint.
    if (typeof key !== "string" || key.length === 0) {
      if (!stillCurrent()) return;
      if (!writeValue(opened, null, keyReason)) stopTimer();
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
      if (!writeValue(opened, null, "http")) stopTimer();
      return;
    }
    if (!stillCurrent()) return;
    let normalized: GoUsage | null;
    try {
      normalized = normalizeGoUsage(raw) ?? null;
    } catch {
      normalized = null;
    }
    // A body that normalized to nothing is the `"parse"` reason; a real value
    // clears the reason inside `writeValue`.
    if (!writeValue(opened, normalized, "parse")) stopTimer();
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
    get reason() {
      return readReason(opened.store);
    },
    dispose() {
      disposed = true;
      generation += 1;
      stopTimer();
    },
  };
}
