// Session throughput, measured from the host's own message timestamps and never
// from a clock this process keeps - as a near-instantaneous output rate, not a
// lifetime average.
//
// Each poll feeds THIS session's cumulative output tokens and cumulative
// generating milliseconds into its EWMA tracker (`./throughput.js`): the rate
// is the DELTA between successive polls, smoothed (alpha 0.3) and repainted
// only on a move of >= 1 tok/s or >= 10%, so the row tracks live decoding
// instead of sagging behind everything the session ever did. The numerator is
// generation tokens - output plus reasoning, which keeps its own row too - and
// the denominator is generating time only: the union of this session's own
// turns' streaming spans. A root reports only its own rate now: a subagent's
// turns are its own work, paced under its own row. The idle test is per-session
// too, and it is the denominator that performs it: when the session's own
// generating time does not advance between polls, the session is not generating
// right now, so the reader reports zero — idle means no tokens per second are
// being produced. No family-wide busy flag enters this path: a parent that has
// stopped generating reads as zero even while its child is still running. The
// first poll for a session only sets the tracker's baselines and reads as zero
// — no rate is known yet, and the cumulative lifetime average never seeds the
// figure, so a session deep into its life must not flash its history as if it
// were live.
//
// The capability is learned once and remembered for the process. `undefined`
// means "not yet known": a read that failed, or carried no assistant turns,
// tells us nothing and must not choose a metric. Once known it is sticky in
// BOTH directions, so a transient `message.list` failure can never flip a
// stamped host back to the clock path (nor an unstamped host off it) -
// a failure just reads as zero. One value for the whole host, deliberately
// not keyed by session.
//
// The rail re-runs on the fast tick, and walking the session's messages on
// every tick would repeat the same work fifty times a second, so the result
// is held briefly. Zero is cached too: an idle session must not be re-derived
// on each tick either.
//
// One factory closes over the plugin `context`. The math itself lives in
// ./throughput.js (pure).

import type { Plugin } from "@opencode/plugin/tui";
import { asCount, asRecord, type SessionLike } from "./coerce.js";
import {
  createInstantTps,
  turnKey,
  turnSpan,
  unionGenerationTotals,
  unionSpanMs,
  type ThroughputSpan,
} from "./stats.js";

/** What one session's message list contributes to its instantaneous rate. */
interface TpsScan {
  /** False only when the host refused to list the session's messages. */
  readonly ok: boolean;
  /** Assistant messages seen, whether or not they carried a timestamp. */
  readonly assistant: number;
  /** Assistant turns that carried any usable timestamp, which proves the host stamps. */
  readonly stamped: number;
  /** Spans for turns that carried a usable `created` start. */
  readonly spans: readonly ThroughputSpan[];
}

/**
 * The live signal the TPS reader borrows rather than re-deriving: the active
 * clock (how much generating time is on record?) is the denominator for a host
 * with no message timestamps — that clock already covers the scope, so it is
 * borrowed as-is. It comes from ./session-reads.js; absent, the stamped path
 * still works and the unstamped path reads as zero for lack of time. There is
 * deliberately no busy gate here: idleness is read off the session's own
 * generating-time delta, never off a family-wide flag.
 */
export interface TpsLiveReads {
  readonly elapsedMsOf?: (sessionID: string, now: number) => number | undefined;
}

export function createTpsReader(context: Plugin.Context, live?: TpsLiveReads) {
  const TPS_CACHE_MS = 1_000;
  let hostStamps: boolean | undefined;
  let tpsCache: { readonly sessionID: string; readonly at: number; readonly value: number } | undefined;
  // One EWMA tracker per displayed session, bounded: without eviction a TUI
  // lifetime of session-hopping grows this map forever. Eviction only drops
  // smoothing - a revisit restarts its baselines, exactly like a first sight.
  // Recency refreshes on every poll, so the watched session is always the last
  // one evicted.
  const MAX_TRACKERS = 50;
  const trackers = new Map<string, ReturnType<typeof createInstantTps>>();

  const trackerOf = (sessionID: string): ReturnType<typeof createInstantTps> => {
    const known = trackers.get(sessionID);
    if (known !== undefined) {
      trackers.delete(sessionID);
      trackers.set(sessionID, known);
      return known;
    }
    const fresh = createInstantTps();
    if (trackers.size >= MAX_TRACKERS) {
      for (const oldest of trackers.keys()) {
        trackers.delete(oldest);
        break;
      }
    }
    trackers.set(sessionID, fresh);
    return fresh;
  };

  const scanMessages = (id: string, now: number): TpsScan => {
    let messages: readonly unknown[];
    try {
      messages = context.data.session.message.list(id) ?? [];
    } catch {
      // A refused read is not "this host has no messages".
      return { ok: false, assistant: 0, stamped: 0, spans: [] };
    }
    const spans: ThroughputSpan[] = [];
    let assistant = 0;
    let stamped = 0;
    for (const entry of messages) {
      const message = asRecord(entry);
      if (message?.["type"] !== "assistant") continue;
      assistant += 1;
      const stamp = asRecord(message["time"]);
      const created = asCount(stamp?.["created"]);
      const completed = asCount(stamp?.["completed"]);
      const streamed = asCount(stamp?.["streamed"]);
      // "Stamped" depends only on the timestamps, never on the output count: a
      // batch of zero-output assistant turns still proves the host stamps.
      if (created === undefined && completed === undefined && streamed === undefined) continue;
      stamped += 1;
      // Without `created` there is no start; the turn is skipped, not guessed.
      // `tps` ends a turn at `streamed`: decoding stopped is the numerator clock.
      const span = turnSpan(created, completed, streamed, now);
      if (span === undefined) continue;
      const tokens = asRecord(message["tokens"]);
      // Generation: output plus reasoning, which keeps its own row too. A
      // settled id-less turn keys on its final counts, so two settled records
      // sharing a start but differing in reasoning stay distinct.
      const output = tokens?.["output"];
      const reasoning = tokens?.["reasoning"];
      const settled = completed !== undefined || streamed !== undefined;
      const key = turnKey(message["id"], created, completed, output, streamed);
      spans.push({
        key: settled ? `${key}:${asCount(reasoning) ?? "?"}` : key,
        tokens: output,
        reasoning,
        ...span,
      });
    }
    return { ok: true, assistant, stamped, spans };
  };

  // Generation tokens on record for the session: its own record's `output`
  // and `reasoning` rungs. Per-session, like everything else here — a root
  // reports only its own rate, and a child keeps its own figure.
  const recordGeneration = (session: SessionLike | undefined): number => {
    const tokens = asRecord(session?.tokens);
    return (asCount(tokens?.["output"]) ?? 0) + (asCount(tokens?.["reasoning"]) ?? 0);
  };

  const computeTps = (sessionID: string, session: SessionLike | undefined): number | undefined => {
    const time = asRecord(session?.time);
    const created = asCount(time?.["created"]);

    const now = Date.now();

    // Timestamped assistant generation this session has produced — its own
    // spans only, never the family's.
    const scan: TpsScan = hostStamps === false ? { ok: true, assistant: 0, stamped: 0, spans: [] } : scanMessages(sessionID, now);

    if (hostStamps === undefined) {
      // A stamped assistant turn proves the host stamps. Assistant turns with
      // no timestamp prove it does not. Neither, and the capability stays
      // unknown so the row reads as zero rather than guessing a metric.
      if (scan.stamped > 0) hostStamps = true;
      else if (scan.ok && scan.assistant > 0) hostStamps = false;
      else return undefined;
    }

    const tracker = trackerOf(sessionID);
    if (hostStamps === true) {
      // Generating time is the union of the turns' own streaming spans: idle
      // between turns was never recorded, so it can never enter the rate. An
      // in-flight turn ends at now, so the denominator keeps pace with the
      // decoder while work happens and freezes the instant it settles. The
      // numerator over it is generation: output plus reasoning.
      const { tokens } = unionGenerationTotals(scan.spans);
      const genMs = unionSpanMs(scan.spans);
      return tracker(tokens, genMs);
    }

    // No timestamps on this host: the denominator is this session's own active
    // clock, which already covers the scope (it IS the `elapsed` figure), so
    // it is borrowed as-is. Without that clock there is no honest denominator
    // - the row reads as zero rather than falling back to a lifetime average
    // that bills idle as work.
    if (created === undefined) return tracker(recordGeneration(session), 0);
    let genMs = 0;
    try {
      genMs = live?.elapsedMsOf?.(sessionID, now) ?? 0;
    } catch {
      genMs = 0;
    }
    return tracker(recordGeneration(session), genMs);
  };

  // The reader never answers `undefined` for a session it was asked about: a
  // session that is not generating reads as zero immediately — its generating
  // time is not advancing, so the tracker reports zero — and a session with no
  // figure yet reads as zero too. (The row itself hides a zero; that decision
  // lives in ./rows.js.)
  const sessionTps = (sessionID: string, session: SessionLike | undefined): number => {
    const cached = tpsCache;
    if (cached !== undefined && cached.sessionID === sessionID && Date.now() - cached.at < TPS_CACHE_MS) {
      return cached.value;
    }
    const value = computeTps(sessionID, session) ?? 0;
    tpsCache = { sessionID, at: Date.now(), value };
    return value;
  };

  return { sessionTps };
}
