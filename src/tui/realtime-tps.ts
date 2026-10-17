// Realtime generation rate, estimated from the host's own streaming delta
// events — the plugin's FIRST host subscription (nothing else here subscribes
// to host events: the guard and go bridges poll, the ticker writes a frame).
//
// Why events and not polls: an in-flight assistant message carries no
// streaming text and no token counts — the host fills the message record's
// text only at `session.text.ended`, its per-turn progress living in an
// "ephemeral progress history" outside the durable record
// (packages/core/src/session/message-updater.ts:342), and `draft.tokens` is
// set only at `session.step.ended`. So any poll of `session.message.list` can
// only see a turn's tokens AFTER it settles — the old poll-delta tracker
// (`createInstantTps`) could never watch a turn stream. The realtime figure
// must come from the host's own delta events instead, following the oc-tps
// design: subscribe to `session.text.delta` / `session.reasoning.delta` and
// estimate tokens from delta bytes.
//
// ESTIMATE, not a measurement: the host publishes real counts only at step
// end. Each non-empty delta is estimated at `max(1, ceil(bytes / 5))` tokens
// (an empty delta carries nothing: 0); the settled average beside it stays
// the real figure.
//
// Pure except for the subscription itself: samples are timestamped with an
// injectable clock so tests pin the window without sleeping.

// In-memory for the plugin's lifetime only: steps observed while the plugin
// ran. A restart forgets every ring — the same limitation as oc-tps, whose
// averages the host never persisted either. The mean covers finalized steps:
// a step's TTFT appears once that step settles, never while it streams.

import type { Plugin } from "@opencode/plugin/tui";
import { asCount, asRecord, asText } from "./coerce.js";
import { smoothTpsRate, TPS_EWMA_ALPHA, tpsNeedsRepaint } from "./throughput.js";

/**
 * How long one delta sample stays in the per-session ring. Deltas older than
 * this never enter the rate: a turn that streamed a minute ago is history,
 * not speed.
 */
export const RT_SAMPLE_WINDOW_MS = 5_000;

/**
 * How long after its last sample a session still counts. A session with no
 * sample for this long is stale and contributes 0 — the decoder is between
 * turns or done, so there is nothing to pace.
 */
export const RT_STALE_MS = 1_500;

/**
 * The maximum finalized step values retained per session. The TTFT mean
 * covers the most recent finalized steps, so the ring drops whole values
 * oldest-first — a mean over retained values can never be negative or
 * fabricated, unlike adjustments against an aggregate that can be evicted
 * and recreated underneath a pending correction.
 */
export const RT_MAX_STEPS = 100;

/**
 * Bound on the per-session sample map, mirroring the old poll tracker's
 * `MAX_TRACKERS` discipline: without eviction a TUI lifetime of
 * session-hopping grows this map forever. Eviction only drops samples — a
 * revisit restarts from zero, exactly like a first sight.
 */
export const RT_MAX_SESSIONS = 50;

/**
 * One delta sample: its estimated tokens, stamped on the host event's own
 * clock (`event.created`), never on a clock this process keeps.
 */
interface RealtimeSample {
  readonly at: number;
  readonly tokens: number;
}

/**
 * Estimate one delta's tokens from its raw bytes.
 *
 * The delta is measured as sent — `Buffer.byteLength` over the full string,
 * never trimmed: a whitespace-only delta still moved the decoder, so `" "`
 * estimates 1 token and `" abcde "` estimates 2. An empty delta carries
 * nothing and estimates 0, never 1. An ESTIMATE, documented at the module
 * top: the host publishes real counts only at step end, and the settled
 * average stays the real figure.
 */
export function estimateDeltaTokens(delta: string): number {
  const bytes = Buffer.byteLength(delta, "utf8");
  return bytes > 0 ? Math.max(1, Math.ceil(bytes / 5)) : 0;
}

/** The realtime tracker: `active` is false when the host offers no subscription surface. */
export interface RealtimeTps {
  /** False when the host has no `data.on` (or it threw): the rate reads 0, never a guess. */
  readonly active: boolean;
  /**
   * The smoothed realtime rate for one displayed session over `ids`.
   *
   * Scope `"session"` passes the displayed session alone; scope `"family"`
   * passes the displayed session plus its family ids. Tokens sum across the
   * ids while the denominator is the WINDOW's wall-clock coverage — merged
   * sample times, so concurrent decoders share wall clock, the same choice
   * the old poll figure and `elapsed` made.
   *
   * A scope with no sample reads 0 (first sight, never a guess), and so does
   * a scope whose newest sample is older than `RT_STALE_MS`. Staleness leaves
   * the smoother untouched, so the next fresh sample resumes from the held
   * figure rather than from zero. There are no baselines to set — samples ARE
   * deltas already — and no backwards-counter branch: deltas are always
   * additive, so a reset can never arrive.
   *
   * Fresh on every call: no cache here. The 1s cache stays on the
   * settled-average scan only.
   */
  rate(displayedSessionID: string, ids: readonly string[]): number;
  /**
   * The mean time to first token over `ids`, in seconds — the oc-tps third
   * figure, reachable from the same event stream.
   *
   * The mean covers the most recent finalized steps observed while the
   * plugin ran (in-memory lifetime): per step, the earliest text/reasoning
   * delta's event time for its `assistantMessageID` minus the step's
   * `started` ("Request dispatch time, before waiting for provider
   * output"), clamped at 0, pushed into the session's ring when the step
   * ends or fails. A step's TTFT appears once that step settles — never
   * while it streams — and a step that settles without any delta contributes
   * nothing. Scope `"session"` means the displayed session's own ring;
   * `"family"` pools every member's rings into one mean. `undefined` while
   * no finalized value is retained — the both line omits the segment rather
   * than inventing one.
   *
   * Fresh on every call: it means the retained values, never a held figure.
   */
  ttft(ids: readonly string[]): number | undefined;
  /** Drop the host subscriptions and the samples. Idempotent. */
  dispose(): void;
}

/** One delta event's untrusted payload, coerced before use. */
interface DeltaReading {
  readonly sessionID: string;
  readonly delta: string;
  readonly at: number;
}

export function createRealtimeTps(
  context: Plugin.Context,
  opts?: { readonly now?: () => number },
): RealtimeTps {
  const now = opts?.now ?? Date.now;
  const samples = new Map<string, RealtimeSample[]>();
  const shown = new Map<string, { smoothed: number | undefined; displayed: number | undefined }>();
  // TTFT state, same lifetime as the samples: pending steps keyed by
  // `assistantMessageID`, and per-session rings of finalized step values.
  // Corrections happen ONLY inside the pending entry — the earliest delta
  // stamp seen — so no session-level arithmetic can drift: the mean derives
  // from retained values on read, and eviction drops whole values. Both maps
  // are bounded: pending steps by the sample ring's bound, rings by session
  // count and per-session value count.
  const pendingStarts = new Map<string, { sessionID: string; started: number; earliest: number | undefined }>();
  const ttftRings = new Map<string, number[]>();
  let disposed = false;
  let active = false;
  const releases: Array<() => void> = [];

  const remember = (sessionID: string, sample: RealtimeSample): void => {
    const known = samples.get(sessionID);
    if (known !== undefined) {
      // Recency refreshes on every sample, so the streaming session is the
      // last one evicted — the same discipline the old tracker map used.
      samples.delete(sessionID);
      known.push(sample);
      samples.set(sessionID, known);
      return;
    }
    if (samples.size >= RT_MAX_SESSIONS) {
      for (const oldest of samples.keys()) {
        samples.delete(oldest);
        break;
      }
    }
    samples.set(sessionID, [sample]);
  };

  const readDelta = (event: unknown): DeltaReading | undefined => {
    const record = asRecord(event);
    const data = asRecord(record?.["data"]);
    const sessionID = asText(data?.["sessionID"]);
    // The delta is byte-measured, never coerced: `asText` trims and rejects
    // whitespace-only strings, which would estimate a whitespace-first token
    // as nothing and hide it from TTFT. A raw string — even empty or blank —
    // is a real decoder event with a real timestamp.
    const raw = data?.["delta"];
    const delta = typeof raw === "string" ? raw : undefined;
    if (sessionID === undefined || delta === undefined) return undefined;
    // The host's own event clock, not ours: `created` is when the decoder
    // moved. A missing stamp falls back to now rather than dropping work.
    const at = asCount(record?.["created"]) ?? now();
    return { sessionID, delta, at };
  };

  const ingest = (event: unknown): void => {
    if (disposed) return;
    const reading = readDelta(event);
    if (reading === undefined) return;
    remember(reading.sessionID, { at: reading.at, tokens: estimateDeltaTokens(reading.delta) });
    noteDelta(event, reading.at);
  };

  /**
   * Record one step's delta timestamp while the step is pending.
   *
   * Delivery order is not trusted: the earliest stamp wins, so a
   * later-received delta carrying an earlier time corrects the step in place.
   * A delta at or after the best stamp is a duplicate, never a re-count. No
   * session-level arithmetic happens here — the mean derives from finalized
   * values on read, so a correction can never drift or negate a total.
   */
  const noteDelta = (event: unknown, at: number): void => {
    const messageID = asText(asRecord(asRecord(event)?.["data"])?.["assistantMessageID"]);
    if (messageID === undefined) return;
    const pending = pendingStarts.get(messageID);
    if (pending === undefined) return;
    if (pending.earliest === undefined || at < pending.earliest) pending.earliest = at;
  };

  const stepStarted = (event: unknown): void => {
    if (disposed) return;
    const data = asRecord(asRecord(event)?.["data"]);
    const sessionID = asText(data?.["sessionID"]);
    const messageID = asText(data?.["assistantMessageID"]);
    // `started` is the dispatch clock: "Request dispatch time, before waiting
    // for provider output" — used uniformly for every step, never the
    // execution start. A step without a usable dispatch stamp cannot time
    // its first token, so it is skipped rather than guessed at.
    const started = asCount(data?.["started"]);
    if (sessionID === undefined || messageID === undefined || started === undefined) return;
    pendingStarts.delete(messageID);
    if (pendingStarts.size >= RT_MAX_SESSIONS) {
      for (const oldest of pendingStarts.keys()) {
        pendingStarts.delete(oldest);
        break;
      }
    }
    pendingStarts.set(messageID, { sessionID, started, earliest: undefined });
  };

  const stepSettled = (event: unknown): void => {
    if (disposed) return;
    const messageID = asText(asRecord(asRecord(event)?.["data"])?.["assistantMessageID"]);
    if (messageID === undefined) return;
    const pending = pendingStarts.get(messageID);
    // Finalize: the pending entry is always dropped. A step that settled
    // without any delta contributes nothing; otherwise its single value —
    // the earliest delta's event time minus dispatch, clamped at 0 — is
    // pushed into the session's ring. The ring drops whole values
    // oldest-first when full, so eviction can only omit steps, never invent
    // or negate them.
    pendingStarts.delete(messageID);
    if (pending === undefined || pending.earliest === undefined) return;
    const value = Math.max(0, pending.earliest - pending.started);
    const ring = ttftRings.get(pending.sessionID);
    if (ring !== undefined) {
      ttftRings.delete(pending.sessionID);
      ring.push(value);
      if (ring.length > RT_MAX_STEPS) ring.splice(0, ring.length - RT_MAX_STEPS);
      ttftRings.set(pending.sessionID, ring);
      return;
    }
    if (ttftRings.size >= RT_MAX_SESSIONS) {
      for (const oldest of ttftRings.keys()) {
        ttftRings.delete(oldest);
        break;
      }
    }
    ttftRings.set(pending.sessionID, [value]);
  };

  // Each subscription stands on its own: the release is retained the moment
  // the call succeeds, so a host that rejects one event keeps the ones it
  // accepted — partial data, with the missing figures degrading naturally —
  // and a failure can never strand an earlier release. The tracker is live
  // while at least one subscription landed.
  try {
    const on = (context as { data?: { on?: unknown } }).data?.on;
    if (typeof on === "function") {
      const subscribe = on as Plugin.Context["data"]["on"];
      const track = (
        type: "session.text.delta" | "session.reasoning.delta" | "session.step.started" | "session.step.ended" | "session.step.failed",
        handler: (event: unknown) => void,
      ): void => {
        try {
          releases.push(subscribe(type, handler));
        } catch {
          // This event stays unsubscribed; the releases already held survive.
        }
      };
      track("session.text.delta", ingest);
      track("session.reasoning.delta", ingest);
      track("session.step.started", stepStarted);
      track("session.step.ended", stepSettled);
      track("session.step.failed", stepSettled);
      active = releases.length > 0;
    }
  } catch {
    // No subscription surface on this host (missing or throwing): the tracker
    // stays degraded and the rate reads 0, never a guess.
    active = false;
  }

  /**
   * Wall-clock coverage of merged sample times, in the oc-tps shape: the gaps
   * between consecutive samples plus the tail to now — concurrent decoders
   * interleave into the same gaps, so they share wall clock instead of adding
   * it. One lone sample clamps to [250, 1000] ms: a single delta proves the
   * decoder moved, but picosecond precision would fake a rate the sample never
   * had.
   */
  const coverageMs = (ordered: readonly RealtimeSample[], at: number): number => {
    const first = ordered[0];
    if (first === undefined) return 0;
    if (ordered.length === 1) {
      return Math.min(Math.max(at - first.at, 250), 1_000);
    }
    let duration = 0;
    for (let index = 1; index < ordered.length; index += 1) {
      duration += Math.max(0, (ordered[index]?.at ?? 0) - (ordered[index - 1]?.at ?? 0));
    }
    duration += Math.max(0, at - (ordered[ordered.length - 1]?.at ?? at));
    return duration;
  };

  const shownOf = (displayedSessionID: string): { smoothed: number | undefined; displayed: number | undefined } => {
    const known = shown.get(displayedSessionID);
    if (known !== undefined) {
      shown.delete(displayedSessionID);
      shown.set(displayedSessionID, known);
      return known;
    }
    const fresh = { smoothed: undefined as number | undefined, displayed: undefined as number | undefined };
    if (shown.size >= RT_MAX_SESSIONS) {
      for (const oldest of shown.keys()) {
        shown.delete(oldest);
        break;
      }
    }
    shown.set(displayedSessionID, fresh);
    return fresh;
  };

  const rate = (displayedSessionID: string, ids: readonly string[]): number => {
    if (!active || disposed) return 0;
    const at = now();
    const seen = new Set<string>();
    const windowed: RealtimeSample[] = [];
    let newest = Number.NEGATIVE_INFINITY;
    for (const id of ids) {
      if (typeof id !== "string" || seen.has(id)) continue;
      seen.add(id);
      const ring = samples.get(id);
      if (ring === undefined) continue;
      const kept = ring.filter((sample) => at - sample.at <= RT_SAMPLE_WINDOW_MS);
      if (kept.length !== ring.length) {
        // Lazy prune: no timer, so the window is enforced on read. An emptied
        // ring leaves no trace — the session reads as a first sight again.
        if (kept.length === 0) samples.delete(id);
        else samples.set(id, kept);
      }
      // Per-session staleness: a member with no sample for ~1.5s contributes
      // 0, even while a sibling still streams — the decoder is between turns
      // or done, so its history must not pace the family.
      let idNewest = Number.NEGATIVE_INFINITY;
      for (const sample of kept) {
        if (sample.at > idNewest) idNewest = sample.at;
      }
      if (kept.length === 0 || at - idNewest > RT_STALE_MS) continue;
      for (const sample of kept) {
        windowed.push(sample);
        if (sample.at > newest) newest = sample.at;
      }
    }
    // First sight reads 0: no samples, no rate — never a guess. Staleness
    // reads 0 too, with the smoother untouched so recovery resumes held.
    if (windowed.length === 0 || at - newest > RT_STALE_MS) return 0;
    windowed.sort((a, b) => a.at - b.at);
    const durationMs = coverageMs(windowed, at);
    if (!(durationMs > 0)) return 0;
    const tokens = windowed.reduce((sum, sample) => sum + sample.tokens, 0);
    const instant = tokens / (durationMs / 1_000);
    if (!Number.isFinite(instant) || instant <= 0) return 0;
    const state = shownOf(displayedSessionID);
    state.smoothed = smoothTpsRate(state.smoothed, instant, TPS_EWMA_ALPHA);
    if (tpsNeedsRepaint(state.displayed, state.smoothed)) state.displayed = state.smoothed;
    return state.displayed ?? 0;
  };

  const ttft = (ids: readonly string[]): number | undefined => {
    if (!active || disposed) return undefined;
    const seen = new Set<string>();
    let totalMs = 0;
    let count = 0;
    for (const id of ids) {
      if (typeof id !== "string" || seen.has(id)) continue;
      seen.add(id);
      const ring = ttftRings.get(id);
      if (ring === undefined) continue;
      for (const value of ring) {
        totalMs += value;
        count += 1;
      }
    }
    // No finalized value retained: unknown, never a guess — the both line
    // omits the segment rather than inventing one.
    if (count === 0) return undefined;
    return totalMs / count / 1_000;
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    for (const release of releases) {
      try {
        release();
      } catch {
        // A failing unsubscribe must not break plugin unload.
      }
    }
    releases.length = 0;
    samples.clear();
    shown.clear();
    pendingStarts.clear();
    ttftRings.clear();
  };

  return { get active() { return active && !disposed; }, rate, ttft, dispose };
}
