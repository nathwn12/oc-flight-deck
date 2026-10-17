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

// In-memory for the plugin's lifetime only: steps observed while the plugin
// ran. A restart forgets every total — the same limitation as oc-tps, whose
// averages the host never persisted either.

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
   * Per step: the first `session.text.delta` / `session.reasoning.delta` for
   * its `assistantMessageID`, its event time minus the step's `started`
   * ("Request dispatch time, before waiting for provider output"), clamped
   * at 0. Later deltas never re-count; a step that ends or fails without any
   * delta contributes nothing. Scope `"session"` means the displayed
   * session's own steps; `"family"` pools every member's steps into one mean.
   * `undefined` while no step with a first delta is on record — the both
   * line omits the segment rather than inventing one.
   *
   * Fresh on every call: it divides the running totals, never a held value.
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
  // TTFT state, same lifetime as the samples: pending dispatch stamps keyed
  // by `assistantMessageID`, and running totals keyed by session. Both
  // bounded with eviction like the sample ring — a host that starts steps it
  // never ends must not grow these maps forever. A pending step keeps the
  // earliest delta timestamp seen so far: delivery order is not trusted, so a
  // later-received delta carrying an earlier stamp corrects the step.
  const pendingStarts = new Map<string, { sessionID: string; started: number; best: number | undefined }>();
  const ttftTotals = new Map<string, { totalMs: number; count: number }>();
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
    measureFirstToken(event, reading.at);
  };

  /**
   * Fold one step's delta into its session's TTFT totals.
   *
   * While the step is pending, every delta's own event time is a candidate:
   * the earliest wins, so a later-received delta carrying an earlier stamp
   * corrects the step's contribution in place (the session total moves by
   * the delta between old and new). A delta at or after the best stamp is a
   * duplicate, never a re-count. The step stays live — its ttft shows as
   * soon as its first delta arrives and improves if an earlier-stamped delta
   * lands later — until `session.step.ended` / `session.step.failed`
   * finalizes it. The per-step figure is the delta's event time minus the
   * step's `started`, clamped at 0 so a skewed clock can never subtract
   * time. A step that settles without any delta leaves nothing behind.
   */
  const measureFirstToken = (event: unknown, at: number): void => {
    const messageID = asText(asRecord(asRecord(event)?.["data"])?.["assistantMessageID"]);
    if (messageID === undefined) return;
    const pending = pendingStarts.get(messageID);
    if (pending === undefined) return;
    const step = Math.max(0, at - pending.started);
    const prev = pending.best;
    // A delta at or after the best stamp adds nothing — duplicates and
    // later tokens never re-count.
    if (prev !== undefined && step >= prev) return;
    const adjust = prev === undefined ? step : step - prev;
    pending.best = step;
    const total = ttftTotals.get(pending.sessionID);
    if (total !== undefined) {
      ttftTotals.delete(pending.sessionID);
      ttftTotals.set(pending.sessionID, {
        totalMs: total.totalMs + adjust,
        count: total.count + (prev === undefined ? 1 : 0),
      });
      return;
    }
    // The session's total is missing: evicted after this step was first
    // measured, or never seeded because the session's history aged out. Seed
    // from the step's own corrected value — never from a subtraction against
    // a total that is no longer there, which would fabricate a zero from a
    // negative adjust. This seed is sufficient (no need to shield sessions
    // with pending steps from eviction): `pending.best` always carries this
    // step's corrected measurement locally, so the seed is exact for the
    // step itself, and totals eviction by design already concedes older
    // history. Neither map can grow from it — both stay under their bound.
    if (ttftTotals.size >= RT_MAX_SESSIONS) {
      for (const oldest of ttftTotals.keys()) {
        ttftTotals.delete(oldest);
        break;
      }
    }
    ttftTotals.set(pending.sessionID, { totalMs: step, count: 1 });
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
    pendingStarts.set(messageID, { sessionID, started, best: undefined });
  };

  const stepSettled = (event: unknown): void => {
    if (disposed) return;
    const messageID = asText(asRecord(asRecord(event)?.["data"])?.["assistantMessageID"]);
    if (messageID === undefined) return;
    // Finalize: the step's contribution stands as measured, and a step that
    // settled without any delta leaves nothing behind — its pending start is
    // dropped rather than left to linger.
    pendingStarts.delete(messageID);
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
      const total = ttftTotals.get(id);
      if (total === undefined) continue;
      totalMs += total.totalMs;
      count += total.count;
    }
    // No step with a first delta on record: unknown, never a guess — the
    // both line omits the segment rather than inventing one.
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
    ttftTotals.clear();
  };

  return { get active() { return active && !disposed; }, rate, ttft, dispose };
}
