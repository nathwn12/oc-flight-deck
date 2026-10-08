// Session throughput, measured from the host's own message timestamps and never
// from a clock this process keeps - as a near-instantaneous output rate, not a
// lifetime average.
//
// Each poll feeds the scope's cumulative output tokens and cumulative
// generating milliseconds into a per-session EWMA tracker (`./throughput.js`):
// the rate is the DELTA between successive polls, smoothed (alpha 0.3) and
// repainted only on a move of >= 1 tok/s or >= 10%, so the row tracks live
// decoding instead of sagging behind everything the session ever did. The
// numerator is output tokens only - reasoning keeps its own row - and the
// denominator is generating time only: the union of the turns' own streaming
// spans on a stamped host, the busy-gated active clock on one without stamps.
// Idle is never divided by; when nothing is busy the tracker freezes and the
// row holds its last figure. The row hides until ~2 s of generating time and
// ~10 tokens are on record, rather than flashing a one-sample rate.
//
// The capability is learned once and remembered for the process. `undefined`
// means "not yet known": a read that failed, or carried no assistant turns,
// tells us nothing and must not choose a metric. Once known it is sticky in
// BOTH directions, so a transient `message.list` failure can never flip a
// stamped host back to the clock path (nor an unstamped host off it) -
// a failure just hides the row. One value for the whole host, deliberately
// not keyed by session.
//
// The rail re-runs on the fast tick, and walking every family message for
// every session would repeat the same work fifty times a second, so the
// result is held briefly. `undefined` is cached too: an idle session must not
// be re-derived on each tick either.
//
// One factory closes over the plugin `context`; `isFamilyRoot` comes from
// ./session-reads.js so a child session keeps its own figure while a root
// sums its tree. The math itself lives in ./throughput.js (pure).

import type { Plugin } from "@opencode/plugin/tui";
import { asCount, asRecord, type SessionLike } from "./coerce.js";
import {
  createInstantTps,
  turnKey,
  turnSpan,
  unionOutputTotals,
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
 * The live signals the TPS reader borrows rather than re-deriving: the busy
 * gate (is anything working?) freezes the row on idle, and the active clock
 * (how much generating time is on record?) is the denominator for a host
 * with no message timestamps. Both come from ./session-reads.js; absent, the
 * stamped path still works and the unstamped path hides for lack of time.
 */
export interface TpsLiveReads {
  readonly busyOf?: (sessionID: string) => boolean | undefined;
  readonly elapsedMsOf?: (sessionID: string, now: number) => number | undefined;
}

export function createTpsReader(
  context: Plugin.Context,
  isFamilyRoot: (sessionID: string) => boolean,
  live?: TpsLiveReads,
) {
  const TPS_CACHE_MS = 1_000;
  let hostStamps: boolean | undefined;
  let tpsCache:
    | { readonly sessionID: string; readonly at: number; readonly value: number | undefined }
    | undefined;
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
      const span = turnSpan(created, completed, streamed, now, "streamed");
      if (span === undefined) continue;
      const tokens = asRecord(message["tokens"]);
      // Output only: reasoning has its own row and no longer inflates the rate.
      spans.push({
        key: turnKey(message["id"], created, completed, tokens?.["output"], streamed),
        tokens: tokens?.["output"],
        ...span,
      });
    }
    return { ok: true, assistant, stamped, spans };
  };

  // Output tokens on record for the scope, for a host with no message
  // timestamps: the session records' own `output` rung, summed over the family
  // from a root. A child asking `family()` gets its ancestors and siblings
  // too, so it keeps its own figure. Reasoning is deliberately excluded.
  const recordOutput = (sessionID: string, session: SessionLike | undefined): number => {
    const outputOf = (source: SessionLike | undefined): number => {
      const tokens = asRecord(source?.tokens);
      return asCount(tokens?.["output"]) ?? 0;
    };
    if (!isFamilyRoot(sessionID)) return outputOf(session);
    try {
      const ids = context.data.session.family(sessionID) ?? [];
      if (ids.length <= 1) return outputOf(session);
      let total = 0;
      for (const id of ids) {
        if (id === sessionID) continue;
        try {
          total += outputOf(context.data.session.get(id) as SessionLike | undefined);
        } catch {
          // One unreadable member must not hide the rest.
        }
      }
      return outputOf(session) + total;
    } catch {
      // No family on this host: the session's own tokens still stand.
      return outputOf(session);
    }
  };

  const busyOf = (sessionID: string): boolean | undefined => {
    try {
      return live?.busyOf?.(sessionID);
    } catch {
      return undefined;
    }
  };

  const computeTps = (sessionID: string, session: SessionLike | undefined): number | undefined => {
    const time = asRecord(session?.time);
    const created = asCount(time?.["created"]);

    // One `now` for the whole scope, so every in-flight turn ends at the same
    // instant and the union cannot be skewed by the scans drifting apart.
    const now = Date.now();
    const busy = busyOf(sessionID);

    // Timestamped assistant output this session has produced, plus - only from
    // a family root - every subagent session's. A child asking `family()` gets
    // its ancestors and siblings back, so it keeps its own spans.
    const scans: TpsScan[] = hostStamps === false ? [] : [scanMessages(sessionID, now)];
    if (hostStamps !== false && isFamilyRoot(sessionID)) {
      try {
        for (const id of context.data.session.family(sessionID) ?? []) {
          if (id !== sessionID) scans.push(scanMessages(id, now));
        }
      } catch {
        // No family on this host: the session's own turns still stand.
      }
    }

    const spans: ThroughputSpan[] = [];
    let assistant = 0;
    let stamped = 0;
    let readOk = false;
    for (const scan of scans) {
      spans.push(...scan.spans);
      assistant += scan.assistant;
      stamped += scan.stamped;
      readOk = readOk || scan.ok;
    }

    if (hostStamps === undefined) {
      // A stamped assistant turn proves the host stamps. Assistant turns with
      // no timestamp prove it does not. Neither, and the capability stays
      // unknown so the row hides rather than guessing a metric.
      if (stamped > 0) hostStamps = true;
      else if (readOk && assistant > 0) hostStamps = false;
      else return undefined;
    }

    const tracker = trackerOf(sessionID);
    if (hostStamps === true) {
      // Generating time is the union of the turns' own streaming spans: idle
      // between turns was never recorded, so it can never enter the rate. An
      // in-flight turn ends at now, so the denominator keeps pace with the
      // decoder while work happens and freezes the instant it settles.
      const { tokens } = unionOutputTotals(spans);
      const genMs = unionSpanMs(spans);
      return tracker(tokens, genMs, busy);
    }

    // No timestamps on this host: the denominator is the busy-gated active
    // clock, which runs only while the scope is actually working. Without that
    // clock there is no honest denominator - the row hides rather than falling
    // back to a lifetime average that bills idle as work.
    if (created === undefined) return tracker(recordOutput(sessionID, session), 0, busy);
    let genMs = 0;
    try {
      genMs = live?.elapsedMsOf?.(sessionID, now) ?? 0;
    } catch {
      genMs = 0;
    }
    return tracker(recordOutput(sessionID, session), genMs, busy);
  };

  const sessionTps = (sessionID: string, session: SessionLike | undefined): number | undefined => {
    const cached = tpsCache;
    if (cached !== undefined && cached.sessionID === sessionID && Date.now() - cached.at < TPS_CACHE_MS) {
      return cached.value;
    }
    const value = computeTps(sessionID, session);
    tpsCache = { sessionID, at: Date.now(), value };
    return value;
  };

  return { sessionTps };
}
