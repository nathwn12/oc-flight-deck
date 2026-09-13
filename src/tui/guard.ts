// Live harness status for the Flight Deck rail, sourced from oc-harness-guard's RPC.
//
// Why the contract is mirrored rather than imported:
//
// The host installs each plugin into its own isolated tree
// (`~/.cache/opencode/npm/<pkg>@latest/<ts>/node_modules/<pkg>`) and Node/bun
// resolution only walks ancestor `node_modules`. Guard's tree is a sibling,
// never an ancestor, so `import("oc-harness-guard/rpc")` cannot resolve.
// Declaring guard as a dependency would make installing deck download guard,
// breaking the promise that installing one never forces the other. So the
// contract is defined locally (`id: "harness-guard"`, method `status`) and the
// payload is read defensively, exactly how every other source field is treated
// (`unknown` + coercion). This is sound because the wire routes on id + method
// name only and the client performs no schema validation at call time; the
// server validates against its own registered contract. Drift degrades to the
// placeholder instead of throwing.
//
// Why this publishes through `context.storage.memory`, like ./ticker.ts:
//
// The host's Solid is compiled into the `opencode2` binary while this plugin
// resolves its own `solid-js` from the npm cache. Those are two module
// instances, and Solid keeps dependency tracking in module state — so a
// plugin-local signal is invisible to the host render. `context.storage.memory`
// returns a store owned by the *host's* Solid, so writing it from a timer
// notifies the host's render, and reading it inside the slot render registers
// the dependency that makes the rail re-run.
//
// The bridge never throws. Any failure (no store, RPC unavailable, `refused`,
// malformed output) stores `null`, which the getter reads as `undefined` so
// the persist layer renders the placeholder.

/** Aggregates from guard's `status` output. Only what the row needs. */
export interface GuardAirworthiness {
  readonly available: boolean;
  readonly findings: number;
}

export interface GuardWarden {
  readonly available: boolean;
  readonly breaches: number;
  readonly orphans: number;
}

export interface GuardFlightPlan {
  readonly available: boolean;
}

export interface GuardStatus {
  readonly airworthiness?: GuardAirworthiness;
  readonly warden?: GuardWarden;
  readonly flightPlan?: GuardFlightPlan;
}

/** The value kept in the host's memory store. Null means "no data". */
interface GuardStoreState {
  value: GuardStatus | null;
}

/** The store the host hands back: read-only to us, reactive to the host. */
interface GuardStore {
  readonly value?: unknown;
}

/** The mutation function the host hands back. */
type GuardUpdate = (mutation: (draft: GuardStoreState) => void) => void;

/** The host capabilities the bridge needs, so it stays trivially stubbable. */
export interface GuardHost {
  readonly storage?: {
    /**
     * Typed as `unknown` on the return on purpose: this is reached across a
     * beta version boundary, so the shape is checked at runtime instead of
     * trusted from a type that may not match the binary.
     */
    memory(key: string, options: { readonly initial: GuardStoreState }): unknown;
  };
  /** Untyped on purpose: resolved defensively at poll time, never trusted. */
  readonly client?: unknown;
}

/** Injectable RPC accessor, so tests never need a real host client. */
export interface GuardDeps {
  readonly status: (input: { readonly sessionID: string }) => Promise<unknown>;
}

export interface GuardBridge {
  /**
   * Current status, read from the host's store.
   *
   * This must be read inside the slot render, while the host's reactive scope
   * is active, or it will not register as a dependency and nothing will update.
   * `undefined` means no data, so the persist layer renders the placeholder.
   */
  readonly status: GuardStatus | undefined;
  /**
   * Retarget the bridge at the rendered session and fetch immediately when it
   * changes. Idempotent: following the same session twice does not re-fetch.
   * Never throws.
   */
  follow(sessionID: string | undefined): void;
  /** Stops the timer. Safe to call more than once. */
  dispose(): void;
}

/** Namespaced so it cannot collide with another plugin's memory keys. */
export const GUARD_KEY = "flight-deck.guard";

/**
 * How often the bridge re-reads guard status.
 *
 * A dedicated constant, deliberately not `config.refresh`: the ticker wakes
 * the renderer up to ten times a second for the spinner, while a breach or
 * orphan needs no such cadence. Ten seconds keeps a status indicator fresh
 * without a request storm, and polling (rather than push events) avoids the
 * location-bearing event envelope. Revisit push only if the platform offers a
 * location-free envelope.
 */
export const GUARD_POLL_MS = 10_000;

/**
 * Mirrored guard contract. See the module header for why it is mirrored.
 *
 * The schemas are intentionally permissive: the server validates against its
 * own registered contract, and the client performs no validation at call time,
 * so precision here would only create a second place to drift. The payload is
 * normalized defensively after the call.
 */
export const GUARD_CONTRACT = {
  id: "harness-guard",
  methods: {
    status: {
      input: { type: "object", properties: { sessionID: { type: "string" } }, required: ["sessionID"] },
      output: { type: "object" },
    },
  },
  events: {},
} as const;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * A non-negative whole count. Numbers only when finite and `>= 0`, floored;
 * arrays count by length; everything else is dropped (reported as `undefined`
 * so the caller can fall back). Mirrors the posture of the rest of `stats.ts`.
 */
function asCount(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return Math.floor(value);
  if (Array.isArray(value)) return value.length;
  return undefined;
}

function countOrZero(...candidates: readonly unknown[]): number {
  for (const candidate of candidates) {
    const count = asCount(candidate);
    if (count !== undefined) return count;
  }
  return 0;
}

function normalizeAirworthiness(value: unknown): GuardAirworthiness | undefined {
  const section = asRecord(value);
  if (section === undefined) return undefined;
  // Only an explicit boolean makes a section usable. A present section with a
  // missing or garbage `available` is dropped rather than read as either `ok`
  // or `unknown`: it is neither a signal nor a reported outage.
  if (section.available !== true && section.available !== false) return undefined;
  return {
    available: section.available === true,
    findings: countOrZero(section.findings, section.counts),
  };
}

function normalizeWarden(value: unknown): GuardWarden | undefined {
  const section = asRecord(value);
  if (section === undefined) return undefined;
  if (section.available !== true && section.available !== false) return undefined;
  return {
    available: section.available === true,
    breaches: countOrZero(section.breaches),
    orphans: countOrZero(section.orphans),
  };
}

function normalizeFlightPlan(value: unknown): GuardFlightPlan | undefined {
  const section = asRecord(value);
  if (section === undefined) return undefined;
  if (section.available !== true && section.available !== false) return undefined;
  return { available: section.available === true };
}

/**
 * Normalize untrusted guard output, or `undefined` when there is no usable
 * data. Never throws: every field is coerced, everything else is dropped.
 */
export function normalizeGuardStatus(value: unknown): GuardStatus | undefined {
  try {
    const top = asRecord(value);
    if (top === undefined) return undefined;
    const airworthiness = normalizeAirworthiness(top.airworthiness);
    const warden = normalizeWarden(top.warden);
    const flightPlan = normalizeFlightPlan(top.flightPlan);
    if (airworthiness === undefined && warden === undefined && flightPlan === undefined) return undefined;
    const status: { -readonly [K in keyof GuardStatus]: GuardStatus[K] } = {};
    if (airworthiness !== undefined) status.airworthiness = airworthiness;
    if (warden !== undefined) status.warden = warden;
    if (flightPlan !== undefined) status.flightPlan = flightPlan;
    return status;
  } catch {
    return undefined;
  }
}

// A host whose store does not match the documented shape is treated as no store
// at all: half-opening one would throw on every poll instead of degrading.
// Validated exactly as ./ticker.ts validates its store.
function openStore(storage: NonNullable<GuardHost["storage"]>): { store: GuardStore; update: GuardUpdate } | undefined {
  let opened: unknown;
  try {
    opened = storage.memory(GUARD_KEY, { initial: { value: null } });
  } catch {
    return undefined;
  }

  if (!Array.isArray(opened) || opened.length < 2) return undefined;
  const [store, update] = opened as [unknown, unknown];
  if (store === null || typeof store !== "object") return undefined;
  if (typeof update !== "function") return undefined;

  return { store: store as GuardStore, update: update as GuardUpdate };
}

function readStatus(store: GuardStore | undefined): GuardStatus | undefined {
  try {
    const value = store?.value;
    if (value === null || value === undefined) return undefined;
    return normalizeGuardStatus(value);
  } catch {
    return undefined;
  }
}

function resolveStatusFn(host: GuardHost, deps: GuardDeps | undefined): GuardDeps["status"] | undefined {
  if (deps !== undefined) {
    try {
      if (typeof deps.status === "function") return deps.status;
    } catch {
      return undefined;
    }
    return undefined;
  }
  try {
    const client = asRecord(host.client);
    const rpc = client?.rpc;
    if (typeof rpc !== "function") return undefined;
    // Local, justified cast: the wire routes on id + method name only and the
    // client performs no schema validation at call time, so the local schemas
    // only have to satisfy the generic bound, not match the server exactly.
    // The payload is normalized defensively after the call, so drift degrades
    // to the placeholder instead of throwing.
    //
    // NEVER use `.call`/`.apply` on the rpc factory itself: the real client
    // attaches its raw API onto the callable (`Object.assign(makeRpc(...),
    // raw.rpc)`), so the factory's `.call` is the raw `rpc.call` endpoint —
    // not `Function.prototype.call`. Using it would POST
    // `/api/rpc/undefined/undefined` and silently yield `undefined`. Invoke
    // the factory directly; the resulting `status` is a plain function, so a
    // direct call is safe there too.
    const factory = rpc as (definition: typeof GUARD_CONTRACT) => { readonly status?: unknown };
    const remote = factory(GUARD_CONTRACT) as { readonly status?: unknown };
    const status = (remote as Record<string, unknown>).status;
    if (typeof status !== "function") return undefined;
    return (input) => (status as (arg: { readonly sessionID: string }) => Promise<unknown>)(input);
  } catch {
    return undefined;
  }
}

function writeValue(opened: { store: GuardStore; update: GuardUpdate }, value: GuardStatus | null): boolean {
  try {
    opened.update((draft) => {
      draft.value = value;
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Start polling guard status into the host's memory store, or return
 * `undefined` when there is no usable store.
 *
 * A missing RPC is not an error: the bridge still opens its store and keeps
 * polling, writing `null` until guard answers. That way installing guard later
 * appears within the poll interval instead of needing a restart. Only a
 * missing or unusable store degrades to no bridge, exactly like the ticker.
 * Nothing here ever throws into the caller or the render.
 *
 * Assumption: `deps` is a test-only override. Production omits it so the
 * bridge resolves `status` from `host.client` on every poll (late installs
 * recover); tests inject a fake `status` plus a short `intervalMs`.
 */
export function startGuardBridge(
  host: GuardHost | undefined,
  deps?: GuardDeps | undefined,
  intervalMs: number = GUARD_POLL_MS,
): GuardBridge | undefined {
  const storage = host?.storage;
  if (host === undefined || storage === undefined || typeof storage.memory !== "function") return undefined;

  const opened = openStore(storage);
  if (opened === undefined) return undefined;

  const cadence = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : GUARD_POLL_MS;
  let currentSessionID: string | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  // Generation invalidated on dispose and on every follow() session change, so
  // a poll that outlives its session — or its bridge, after disposal or a hot
  // reload where the host memory store is shared — cannot overwrite newer data.
  let generation = 0;
  // Monotonic request sequence so overlapping polls for the same session
  // resolve in start order, not finish order: only the newest request of the
  // current generation may write.
  let nextSeq = 0;
  let latestSeq = 0;
  let disposed = false;

  const stopTimer = () => {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
  };

  const poll = async (sessionID: string | undefined): Promise<void> => {
    if (disposed) return;
    if (sessionID === undefined || sessionID.length === 0) return;
    const myGeneration = generation;
    const mySeq = ++nextSeq;
    latestSeq = mySeq;
    const stillCurrent = () => myGeneration === generation && mySeq === latestSeq && !disposed;
    let raw: unknown;
    try {
      const statusFn = resolveStatusFn(host, deps);
      if (statusFn === undefined) {
        if (!stillCurrent()) return;
        if (currentSessionID !== sessionID) return;
        if (!writeValue(opened, null)) stopTimer();
        return;
      }
      raw = await statusFn({ sessionID });
    } catch {
      // `refused`, unavailable, or any transport failure: no data, not an error.
      // Abort check below still applies so a late session change wins.
      if (!stillCurrent()) return;
      if (currentSessionID !== sessionID) return;
      if (!writeValue(opened, null)) stopTimer();
      return;
    }
    // A session change, a newer request, or disposal during the await makes
    // this response stale; the fresh request's own poll will overwrite, so
    // drop it rather than flash it. The generation check also covers A→B→A,
    // where the session ID matches again but the response is still stale.
    if (!stillCurrent()) return;
    if (currentSessionID !== sessionID) return;
    let normalized: GuardStatus | null;
    try {
      normalized = normalizeGuardStatus(raw) ?? null;
    } catch {
      normalized = null;
    }
    if (!writeValue(opened, normalized)) stopTimer();
  };

  timer = setInterval(() => {
    const sessionID = currentSessionID;
    if (sessionID === undefined) return;
    void poll(sessionID);
  }, cadence);

  return {
    get status() {
      return readStatus(opened.store);
    },
    follow(sessionID: string | undefined) {
      try {
        if (disposed) return;
        const next = typeof sessionID === "string" && sessionID.length > 0 ? sessionID : undefined;
        if (next === currentSessionID) return;
        // Every session change invalidates in-flight polls, including A→B→A
        // where the ID matches again but the earlier response is still stale.
        generation += 1;
        currentSessionID = next;
        if (next === undefined) {
          if (!writeValue(opened, null)) stopTimer();
          return;
        }
        // Clear stale per-session data immediately so a switch never flashes
        // the previous session's verdict while the fresh fetch is in flight.
        // A failing clear stops the timer, mirroring the ticker's store-fails
        // behavior; the getter then reads whatever the host still holds.
        if (!writeValue(opened, null)) {
          stopTimer();
          return;
        }
        void poll(next);
      } catch {
        // Following a session must never break the render that reported it.
      }
    },
    dispose() {
      disposed = true;
      generation += 1;
      stopTimer();
    },
  };
}
