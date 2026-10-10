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
//   * The key is resolved on every poll - from the host's credential store
//     (direct or wrapped), the provider catalog's resolved `settings.apiKey`,
//     then the `OPENCODE_GO_API_KEY` env var - so a key loaded, rotated, or
//     activated after startup is picked up without a restart. Every source is
//     guarded and bounded, so a hung read becomes a named reason, not a stall.
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

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { normalizeGoUsage, type GoUsage, type GoWindow } from "./go-usage.js";

/**
 * Why the bridge has no usage to show.
 *
 * Additive to `value`: a reader that only wants the usage is unchanged, while
 * a surface that has to explain a blank panel reads this alongside it. The set
 * is closed so a renderer can trust it, and each value names the failed stage,
 * not a symptom:
 *
 *   * `"no-client"` - none of the host's credential sources could be asked at
 *     all: the client was absent, its `list` was not a function, or it answered
 *     with something that was not a usable list. The key lookup never had a
 *     chance to run.
 *   * `"no-key"`    - a source answered, but held no usable `opencode-go`
 *     credential and no `OPENCODE_GO_API_KEY` fallback was set.
 *   * `"http"`      - a key was resolved and the usage request threw or came
 *     back non-OK.
 *   * `"parse"`     - the request succeeded but the body did not normalize into
 *     any known window shape.
 *   * `"timeout"`   - a credential source never settled inside its hard bound,
 *     so the poll stopped waiting rather than stalling forever.
 *   * `"pending"`   - a bridge exists but has produced neither a value nor a
 *     reason yet (its first poll is still in flight).
 */
export type GoNoDataReason = "no-client" | "no-key" | "http" | "parse" | "timeout" | "pending";

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
  /**
   * Some contexts wrap the client one level deeper. Reached only through
   * `credential.list` again, and only when the direct store yielded nothing.
   */
  readonly api?: { readonly credential?: GoCredentialStore };
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
  /**
   * The host's data collections, reached only for the provider catalog: the
   * provider RPC does not redact, so the resolved `settings.apiKey` may be
   * there when the credential store is not.
   */
  readonly data?: {
    readonly location?: {
      readonly provider?: unknown;
    };
  };
}

/** Injectable key accessor and fetch, so tests never touch the network or env. */
export interface GoDeps {
  /** Synchronous key override; short-circuits the store and the env var. */
  readonly key?: () => string | undefined;
  /** Async key override; used when `key` is absent, ahead of the store/env. */
  readonly resolveKey?: () => Promise<string | undefined>;
  readonly fetchJson?: (url: string, init: RequestInit) => Promise<unknown>;
  /** Overrides the credential-source hard bound, so a hung store is testable fast. */
  readonly credentialTimeoutMs?: number;
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
 * value that selects the right entry out of `credential.list()`. It is NOT a
 * key, a label, or a value: which entry is the right one is decided by its
 * `active` flag, which differs per user.
 */
const GO_INTEGRATION_ID = "opencode-go";

const GO_TIMEOUT_MS = 10_000;

/**
 * The hard bound on any single credential source.
 *
 * A credential read that never settles must not stall the poll forever, so it
 * races this bound and resolves to the `"timeout"` reason instead.
 */
export const GO_CREDENTIAL_TIMEOUT_MS = 6_000;

/** Where the poll's observation log lives, under the OS temp directory. */
const GO_LOG_DIR = "opencode";
const GO_LOG_FILE = "flight-deck-go.log";

/** The log is overwritten once it holds this many lines, so it stays small. */
export const GO_LOG_MAX_LINES = 200;

/**
 * Fetch and parse a usage payload. A non-OK response throws so the poll's one
 * catch handles both transport and status failures; the body is only parsed
 * once the status is known good.
 */
async function defaultFetchJson(url: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const error = new Error(`go usage: HTTP ${response.status}`) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }
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

/**
 * Canonical window order, matching ./go-usage.ts, so a stored value reads back
 * in the same order the fetch path wrote it.
 */
const GO_WINDOW_ORDER: readonly GoWindow["id"][] = ["5h", "1w", "1m"];

/** A finite number, or `undefined` when the value is not one. Never throws. */
function asStoredNumber(value: unknown): number | undefined {
  try {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Validate one stored window AS a {@link GoUsage} entry, not a raw payload.
 *
 * The store already holds normalised windows (`{ id, ratio, ... }`), so the
 * raw-payload normaliser must not run here: it only understands `percent` /
 * `used` / `limit`, and a window carrying only `ratio` would fall through
 * `buildWindow` and be dropped, leaving the panel on `pending` despite a good
 * poll. Only the `5h`/`1w`/`1m` ids survive; a present `ratio` must be finite
 * (clamped to `[0, 1]`); `resetAtMs`/`status`/`used`/`limit` are preserved when
 * readable. Never throws.
 */
function asStoredWindow(entry: unknown, seen: Set<GoWindow["id"]>): GoWindow | undefined {
  try {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return undefined;
    const record = entry as Record<string, unknown>;
    let id: unknown;
    let ratioRaw: unknown;
    let usedRaw: unknown;
    let limitRaw: unknown;
    let resetRaw: unknown;
    let statusRaw: unknown;
    try {
      id = record["id"];
    } catch {
      return undefined;
    }
    if (id !== "5h" && id !== "1w" && id !== "1m") return undefined;
    if (seen.has(id)) return undefined;
    try {
      ratioRaw = record["ratio"];
    } catch {
      return undefined;
    }
    let ratio: number | undefined;
    if (ratioRaw !== undefined) {
      const finite = asStoredNumber(ratioRaw);
      if (finite === undefined) return undefined;
      ratio = Math.min(1, Math.max(0, finite));
    }
    let used: number | undefined;
    let limit: number | undefined;
    let resetAtMs: number | undefined;
    let status: string | undefined;
    try {
      usedRaw = record["used"];
      limitRaw = record["limit"];
      resetRaw = record["resetAtMs"];
      statusRaw = record["status"];
    } catch {
      return undefined;
    }
    used = asStoredNumber(usedRaw);
    limit = asStoredNumber(limitRaw);
    resetAtMs = asStoredNumber(resetRaw);
    try {
      if (typeof statusRaw === "string" && statusRaw.trim().length > 0) status = statusRaw.trim();
    } catch {
      status = undefined;
    }
    if (used === undefined && limit === undefined && ratio === undefined) return undefined;
    seen.add(id);
    const result: { -readonly [K in keyof GoWindow]: GoWindow[K] } = { id };
    if (used !== undefined) result.used = used;
    if (limit !== undefined) result.limit = limit;
    if (ratio !== undefined) result.ratio = ratio;
    if (resetAtMs !== undefined) result.resetAtMs = resetAtMs;
    if (status !== undefined) result.status = status;
    return result;
  } catch {
    return undefined;
  }
}

function readUsage(store: GoStore | undefined): GoUsage | undefined {
  try {
    const value = store?.value;
    if (value === null || value === undefined) return undefined;
    if (typeof value !== "object" || Array.isArray(value)) return undefined;
    let windowsRaw: unknown;
    try {
      windowsRaw = (value as Record<string, unknown>)["windows"];
    } catch {
      return undefined;
    }
    if (!Array.isArray(windowsRaw)) return undefined;
    const windows: GoWindow[] = [];
    const seen = new Set<GoWindow["id"]>();
    for (const entry of windowsRaw) {
      const window = asStoredWindow(entry, seen);
      if (window !== undefined) windows.push(window);
    }
    if (windows.length === 0) return undefined;
    windows.sort((a, b) => GO_WINDOW_ORDER.indexOf(a.id) - GO_WINDOW_ORDER.indexOf(b.id));
    return { windows };
  } catch {
    return undefined;
  }
}

/** The closed set of reasons, so a corrupt store value can never leak through. */
export const GO_NO_DATA_REASONS: readonly GoNoDataReason[] = [
  "no-client",
  "no-key",
  "http",
  "parse",
  "timeout",
  "pending",
];

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

/** Read a property without letting a hostile getter or proxy throw. */
function safeGet(target: unknown, key: string): unknown {
  try {
    if (target === null || (typeof target !== "object" && typeof target !== "function")) return undefined;
    return (target as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

/** The credential-source bound, overridable for tests, defaulting to 6s. */
function resolveCredentialTimeout(deps: GoDeps | undefined): number {
  if (deps !== undefined) {
    try {
      const value = deps.credentialTimeoutMs;
      if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
    } catch {
      // fall through to the default bound
    }
  }
  return GO_CREDENTIAL_TIMEOUT_MS;
}

/** Where a resolved key came from, for the observation log only. */
export type GoKeySource = "credential" | "provider" | "env" | "none";

/** One source's outcome: a key, or why it had none, plus whether it answered. */
interface KeyAttempt {
  readonly key?: string;
  readonly reason?: GoNoDataReason;
  /** True when the source answered with a readable collection, key or not. */
  readonly answered: boolean;
}

/** The settled-or-not result of one guarded, timed source call. */
type Settled =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly timedOut: boolean };

/**
 * Await `call()` under a hard bound.
 *
 * A promise that never settles resolves to `timedOut: true` instead of stalling
 * the poll forever; a synchronous throw or a rejection is an error, not a
 * timeout. Never rejects.
 */
function settleCall(call: () => unknown, ms: number): Promise<Settled> {
  let produced: unknown;
  try {
    produced = call();
  } catch {
    return Promise.resolve({ ok: false, timedOut: false });
  }

  const thenable =
    produced !== null && (typeof produced === "object" || typeof produced === "function")
      ? (produced as { then?: unknown }).then
      : undefined;
  if (typeof thenable !== "function") return Promise.resolve({ ok: true, value: produced });

  return new Promise<Settled>((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, timedOut: true }), ms);
    (produced as Promise<unknown>).then(
      (value) => {
        clearTimeout(timer);
        resolve({ ok: true, value });
      },
      () => {
        clearTimeout(timer);
        resolve({ ok: false, timedOut: false });
      },
    );
  });
}

/**
 * The list inside a credential response.
 *
 * The RPC may hand back a bare array or wrap it in an envelope (`{ data: [...] }`,
 * `{ output: [...] }`); every one of those is accepted. Only a value that yields
 * no array at all is not a usable list.
 */
function asList(value: unknown): unknown[] | undefined {
  if (Array.isArray(value)) return value;
  if (value === null || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const data = record["data"];
  if (Array.isArray(data)) return data;
  const output = record["output"];
  if (Array.isArray(output)) return output;
  return undefined;
}

/**
 * Whether a credential entry is the active one.
 *
 * Robust on purpose: the API may serialise `active` as a boolean `true` or a
 * numeric `1`, so any truthy value counts. The active entry is the credential
 * the user selected, and it differs per user - it is never hard-coded.
 */
function isActive(value: unknown): boolean {
  return Boolean(value);
}

/**
 * The Zen Go key among credential entries.
 *
 * The ACTIVE entry for the `opencode-go` integration always wins. A non-active
 * entry is a fallback ONLY when no entry is marked active. Among equally-active
 * entries the first usable one wins.
 */
function goKeyFromEntries(entries: readonly unknown[]): string | undefined {
  let fallback: string | undefined;
  for (const entry of entries) {
    if (entry === null || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    if (record["integrationID"] !== GO_INTEGRATION_ID) continue;
    const key = keyOfValue(record["value"]);
    if (key === undefined) continue;
    if (isActive(record["active"])) return key;
    if (fallback === undefined) fallback = key;
  }
  return fallback;
}

/**
 * Ask one credential store for the Zen Go key.
 *
 * Guarded and timed: a store that is absent, whose `list` is not a function,
 * that throws, times out, or answers with a non-list yields `"no-client"` or
 * `"timeout"` with no key; a store that answers without a usable entry yields
 * `"no-key"`. Never throws.
 */
async function credentialAttempt(store: unknown, ms: number): Promise<KeyAttempt> {
  const list = safeGet(store, "list");
  if (typeof list !== "function") return { reason: "no-client", answered: false };
  const settled = await settleCall(() => (list as () => unknown).call(store), ms);
  if (!settled.ok) return { reason: settled.timedOut ? "timeout" : "no-client", answered: false };
  const entries = asList(settled.value);
  if (entries === undefined) return { reason: "no-client", answered: false };
  const key = goKeyFromEntries(entries);
  return key === undefined ? { reason: "no-key", answered: true } : { key, answered: true };
}

/** The `opencode-go` provider's own `settings.apiKey`, if it is there. */
function providerKeyOf(info: unknown): string | undefined {
  if (info === null || typeof info !== "object") return undefined;
  const record = info as Record<string, unknown>;
  if (record["id"] !== GO_INTEGRATION_ID && record["integrationID"] !== GO_INTEGRATION_ID) return undefined;
  const settings = record["settings"];
  if (settings === null || typeof settings !== "object") return undefined;
  const apiKey = (settings as Record<string, unknown>)["apiKey"];
  return typeof apiKey === "string" && apiKey.length > 0 ? apiKey : undefined;
}

/** Unwrap a one-item envelope (`{ data: ProviderInfo }`) before reading it. */
function unwrapOne(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  const data = (value as Record<string, unknown>)["data"];
  return data !== null && typeof data === "object" && !Array.isArray(data) ? data : value;
}

/**
 * Ask the provider catalog for the `opencode-go` provider's resolved credential.
 *
 * The provider RPC does not redact, so the key may sit in `settings.apiKey`.
 * Either collection shape - `get(id)` or `list()` - is handled defensively, and
 * the call is guarded and timed like every other source. Never throws.
 */
async function providerAttempt(provider: unknown, ms: number): Promise<KeyAttempt> {
  if (provider === null || typeof provider !== "object") return { reason: "no-client", answered: false };
  const collection = provider as Record<string, unknown>;
  const get = collection["get"];
  const list = collection["list"];

  if (typeof get === "function") {
    const settled = await settleCall(() => (get as (id: string) => unknown).call(collection, GO_INTEGRATION_ID), ms);
    if (!settled.ok) return { reason: settled.timedOut ? "timeout" : "no-client", answered: false };
    if (settled.value === undefined || settled.value === null) return { reason: "no-key", answered: true };
    const key = providerKeyOf(unwrapOne(settled.value));
    return key === undefined ? { reason: "no-key", answered: true } : { key, answered: true };
  }

  if (typeof list === "function") {
    const settled = await settleCall(() => (list as () => unknown).call(collection), ms);
    if (!settled.ok) return { reason: settled.timedOut ? "timeout" : "no-client", answered: false };
    const entries = asList(settled.value);
    if (entries === undefined) return { reason: "no-client", answered: false };
    let key: string | undefined;
    for (const entry of entries) {
      const candidate = providerKeyOf(entry);
      if (candidate !== undefined) {
        key = candidate;
        break;
      }
    }
    return key === undefined ? { reason: "no-key", answered: true } : { key, answered: true };
  }

  return { reason: "no-client", answered: false };
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

/** The HTTP status a failure carried, or `"n/a"` when it carried none. */
function httpOf(error: unknown): string {
  const status = error !== null && typeof error === "object" ? (error as { status?: unknown }).status : undefined;
  return typeof status === "number" && Number.isFinite(status) ? String(status) : "n/a";
}

/**
 * The observation boundary: ONE bounded line per poll outcome, so a failure is
 * readable next time.
 *
 * Written under the OS temp directory, resolved via `os.tmpdir()`. It records
 * which source was consulted, whether it produced a key, the HTTP status, the
 * parse result, and the reason - and NEVER the key or any part of it. Best
 * effort: a log that cannot be written must never affect the poll. Rotated by
 * overwriting once the file holds {@link GO_LOG_MAX_LINES} lines.
 */
function logPoll(entry: {
  readonly src: GoKeySource;
  readonly key: boolean;
  readonly http: string;
  readonly parse: string;
  readonly reason: string;
}): void {
  try {
    const directory = join(tmpdir(), GO_LOG_DIR);
    const path = join(directory, GO_LOG_FILE);
    const line = `ts=${new Date().toISOString()} src=${entry.src} key=${entry.key ? "yes" : "no"} http=${entry.http} parse=${entry.parse} reason=${entry.reason}\n`;

    let prior = "";
    try {
      if (existsSync(path)) prior = readFileSync(path, "utf8");
    } catch {
      prior = "";
    }
    const lines = prior.length === 0 ? 0 : prior.split("\n").filter((row) => row.length > 0).length;
    mkdirSync(directory, { recursive: true });
    if (lines >= GO_LOG_MAX_LINES) writeFileSync(path, line);
    else appendFileSync(path, line);
  } catch {
    // Observation must never break the observed.
  }
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
 * poll the key is resolved from the host's credential sources - the credential
 * store, then the provider catalog's `settings.apiKey`, then
 * `process.env[GO_KEY_ENV]` (late or rotated keys recover) - each under a hard
 * bound, and the request is the real `fetch` with a bounded timeout.
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
  const credentialTimeoutMs = resolveCredentialTimeout(deps);
  const client = host.client;
  // Read the nested sources once, through `safeGet`, so a hostile getter or a
  // wrapped client cannot throw out of the setup.
  const directStore = safeGet(client, "credential");
  const wrappedStore = safeGet(safeGet(client, "api"), "credential");
  const providerSource = safeGet(safeGet(safeGet(host, "data"), "location"), "provider");

  // The key source, in order: an injected override (`key`, then `resolveKey`),
  // then the real sources - the host's own credential store (direct, then a
  // context that wraps the client), the provider catalog's unredacted
  // `settings.apiKey`, and finally `OPENCODE_GO_API_KEY`. Every source is
  // guarded and timed, and the result names WHICH source produced the key (or
  // why none did), so the blank panel is never silent and never lies.
  const readKey = async (): Promise<{ key?: string; src: GoKeySource; reason?: GoNoDataReason }> => {
    if (keyFn !== undefined) {
      try {
        const key = keyFn();
        return typeof key === "string" && key.length > 0
          ? { key, src: "credential" }
          : { src: "none", reason: "no-key" };
      } catch {
        return { src: "none", reason: "no-key" };
      }
    }
    if (asyncKeyFn !== undefined) {
      try {
        const key = await asyncKeyFn();
        return typeof key === "string" && key.length > 0
          ? { key, src: "credential" }
          : { src: "none", reason: "no-key" };
      } catch {
        return { src: "none", reason: "no-key" };
      }
    }

    let answered = false;
    let timedOut = false;

    // a. the host's own credential store.
    const direct = await credentialAttempt(directStore, credentialTimeoutMs);
    if (direct.key !== undefined) return { key: direct.key, src: "credential" };
    answered = answered || direct.answered;
    timedOut = timedOut || direct.reason === "timeout";

    // b. a context that wraps the client one level deeper.
    const wrapped = await credentialAttempt(wrappedStore, credentialTimeoutMs);
    if (wrapped.key !== undefined) return { key: wrapped.key, src: "credential" };
    answered = answered || wrapped.answered;
    timedOut = timedOut || wrapped.reason === "timeout";

    // c. the provider catalog's resolved credential.
    const provider = await providerAttempt(providerSource, credentialTimeoutMs);
    if (provider.key !== undefined) return { key: provider.key, src: "provider" };
    answered = answered || provider.answered;
    timedOut = timedOut || provider.reason === "timeout";

    // d. the env var, the last resort.
    const env = process.env[GO_KEY_ENV];
    if (typeof env === "string" && env.length > 0) return { key: env, src: "env" };

    if (answered) return { src: "none", reason: "no-key" };
    return { src: "none", reason: timedOut ? "timeout" : "no-client" };
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
    let keySrc: GoKeySource = "none";
    let keyReason: GoNoDataReason = "no-key";
    try {
      const resolved = await readKey();
      key = resolved.key;
      keySrc = resolved.src;
      if (resolved.reason !== undefined) keyReason = resolved.reason;
    } catch {
      key = undefined;
    }
    // No key is the row's "no key" dash path, not an error: store null and
    // make no request, so a keyless install never touches the endpoint.
    if (typeof key !== "string" || key.length === 0) {
      if (stillCurrent() && !writeValue(opened, null, keyReason)) stopTimer();
      logPoll({ src: keySrc, key: false, http: "n/a", parse: "n/a", reason: keyReason });
      return;
    }

    let raw: unknown;
    try {
      raw = await fetchJson(GO_USAGE_URL, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(GO_TIMEOUT_MS),
      });
    } catch (error) {
      // Refused, timed out, non-OK status, or a transport failure: no data,
      // not an error.
      if (stillCurrent() && !writeValue(opened, null, "http")) stopTimer();
      logPoll({ src: keySrc, key: true, http: httpOf(error), parse: "n/a", reason: "http" });
      return;
    }

    let normalized: GoUsage | null;
    try {
      normalized = normalizeGoUsage(raw) ?? null;
    } catch {
      normalized = null;
    }
    // A body that normalized to nothing is the `"parse"` reason; a real value
    // clears the reason inside `writeValue`.
    if (stillCurrent() && !writeValue(opened, normalized, "parse")) stopTimer();
    logPoll({
      src: keySrc,
      key: true,
      http: "ok",
      parse: normalized === null ? "no" : "ok",
      reason: normalized === null ? "parse" : "none",
    });
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
