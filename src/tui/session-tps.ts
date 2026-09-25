// Session throughput, measured from the host's own message timestamps and never
// from a clock this process keeps. A host that stamps its assistant turns gets
// an active-work average: output tokens divided by the union of the turns' own
// spans, so idle between turns is not in the denominator and the figure freezes
// once everything settles. A host proven to expose no message timestamps uses
// the lifetime average instead.
//
// The capability is learned once and remembered for the process. `undefined`
// means "not yet known": a read that failed, or carried no assistant turns,
// tells us nothing and must not choose a metric. Once known it is sticky in
// BOTH directions, so a transient `message.list` failure can never flip a
// stamped host back to the lifetime average (nor an unstamped host off it) —
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
//
// RESIDUAL RISK, disclosed: the lifetime fallback for an unstamped host still
// includes idle time and can therefore sag below a peak per-turn rate. There is
// no timestamp on such a host with which to exclude it.

import type { Plugin } from "@opencode/plugin/tui";
import { asCount, asRecord, type SessionLike } from "./coerce.js";
import { sessionThroughput, turnKey, turnSpan, unionSpanThroughput, type ThroughputSpan } from "./stats.js";

/** What one session's message list contributes to its active-work average. */
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

export function createTpsReader(
  context: Plugin.Context,
  isFamilyRoot: (sessionID: string) => boolean,
) {
  const TPS_CACHE_MS = 1_000;
  let hostStamps: boolean | undefined;
  let tpsCache:
    | { readonly sessionID: string; readonly at: number; readonly value: number | undefined }
    | undefined;

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
      const span = turnSpan(created, completed, streamed, now);
      if (span === undefined) continue;
      const output = asRecord(message["tokens"])?.["output"];
      spans.push({ key: turnKey(message["id"], created, completed, output), tokens: output, ...span });
    }
    return { ok: true, assistant, stamped, spans };
  };

  // The lifetime average, the metric of last resort for a host that exposes no
  // per-message timestamps. Measured from the session's own clock
  // (`time.updated`, falling back to now) so a finished session settles on a
  // stable figure instead of decaying as it sits on screen.
  const lifetimeTps = (
    sessionID: string,
    session: SessionLike | undefined,
    created: number,
    time: Record<string, unknown> | undefined,
  ): number | undefined => {
    const updated = asCount(time?.["updated"]);
    const end = updated === undefined ? Date.now() : Math.min(Date.now(), updated);
    const elapsed = end - created;
    if (elapsed <= 0) return undefined;

    const own = asCount(asRecord(session?.tokens)?.["output"]);
    let output = own;
    // Only a family root owns the tree beneath it; a child asking `family()`
    // gets its ancestors and siblings too, so it keeps its own figure.
    if (isFamilyRoot(sessionID)) {
      try {
        const ids = context.data.session.family(sessionID) ?? [];
        if (ids.length > 1) {
          let total = 0;
          let sawOne = false;
          for (const id of ids) {
            const member = context.data.session.get(id) as SessionLike | undefined;
            const out = asCount(asRecord(member?.tokens)?.["output"]);
            if (out === undefined) continue;
            total += out;
            sawOne = true;
          }
          if (sawOne) output = total;
        }
      } catch {
        // No family on this host: the session's own tokens still stand.
      }
    }
    return sessionThroughput(output, elapsed);
  };

  const computeTps = (sessionID: string, session: SessionLike | undefined): number | undefined => {
    const time = asRecord(session?.time);
    const created = asCount(time?.["created"]);
    if (created === undefined) return undefined;

    // A host proven unstamped needs no message read at all: its metric is the
    // lifetime average whether or not the read would have succeeded.
    if (hostStamps === false) return lifetimeTps(sessionID, session, created, time);

    // One `now` for the whole scope, so every in-flight turn ends at the same
    // instant and the union cannot be skewed by the scans drifting apart.
    const now = Date.now();

    // Timestamped assistant output this session has produced, plus — only from
    // a family root — every subagent session's. A child asking `family()` gets
    // its ancestors and siblings back, so it keeps its own spans.
    const scans: TpsScan[] = [scanMessages(sessionID, now)];
    if (isFamilyRoot(sessionID)) {
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

    if (hostStamps === true) return unionSpanThroughput(spans);
    return lifetimeTps(sessionID, session, created, time);
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
