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
// end. Each delta is estimated at `max(1, ceil(bytes / 5))` tokens; the
// settled average beside it stays the real figure.
//
// Pure except for the subscription itself: samples are timestamped with an
// injectable clock so tests pin the window without sleeping.

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
 * Estimate one delta's tokens from its bytes.
 *
 * `Math.max(1, Math.ceil(Buffer.byteLength(delta, "utf8") / 5))`: every
 * delta moved the decoder, so even an empty one counts one token, and five
 * bytes per token is the working ratio, not a measurement. Documented as an
 * ESTIMATE at the module top: the host publishes real counts only at step
 * end, and the settled average stays the real figure.
 */
export function estimateDeltaTokens(delta: string): number {
  return Math.max(1, Math.ceil(Buffer.byteLength(delta, "utf8") / 5));
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
    const delta = asText(data?.["delta"]);
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
  };

  try {
    const on = (context as { data?: { on?: unknown } }).data?.on;
    if (typeof on === "function") {
      const subscribe = on as Plugin.Context["data"]["on"];
      releases.push(
        subscribe("session.text.delta", ingest),
        subscribe("session.reasoning.delta", ingest),
      );
      active = true;
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
  };

  return { get active() { return active && !disposed; }, rate, dispose };
}
