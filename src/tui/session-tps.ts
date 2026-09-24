// Session throughput, measured from two sources chosen by host capability and
// never by the moment. A host that stamps its messages gets a trailing-window
// rate — output tokens over the last minute, subagents summed in — so the
// figure reflects current speed rather than a whole-conversation average. A
// host proven to expose no message timestamps uses the lifetime average.
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
// result is held briefly. `undefined` is cached too: an idle window must not
// be re-derived on each tick either.
//
// One factory closes over the plugin `context`; `isFamilyRoot` comes from
// ./session-reads.js so a child session keeps its own figure while a root
// sums its tree. The math itself lives in ./throughput.js (pure) and
// ./stats.js.

import type { Plugin } from "@opencode/plugin/tui";
import { asCount, asRecord, type SessionLike } from "./coerce.js";
import { sessionThroughput, TPS_WINDOW_MS, windowedThroughput, type ThroughputSample } from "./stats.js";

/** What one session's message list contributes to a throughput window. */
interface TpsScan {
  /** False only when the host refused to list the session's messages. */
  readonly ok: boolean;
  /** Assistant messages seen, whether or not they carried a timestamp. */
  readonly assistant: number;
  /** Samples that carried a usable timestamp. */
  readonly samples: readonly ThroughputSample[];
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

  const scanMessages = (id: string): TpsScan => {
    let messages: readonly unknown[];
    try {
      messages = context.data.session.message.list(id) ?? [];
    } catch {
      // A refused read is not "this host has no messages".
      return { ok: false, assistant: 0, samples: [] };
    }
    const samples: ThroughputSample[] = [];
    let assistant = 0;
    for (const entry of messages) {
      const message = asRecord(entry);
      if (message?.["type"] !== "assistant") continue;
      assistant += 1;
      const stamp = asRecord(message["time"]);
      const at =
        asCount(stamp?.["completed"]) ?? asCount(stamp?.["streamed"]) ?? asCount(stamp?.["created"]);
      // "Stamped" depends only on the timestamp, never on the output count: a
      // batch of zero-output assistant turns still proves the host stamps.
      if (at === undefined) continue;
      samples.push({ tokens: asRecord(message["tokens"])?.["output"], at });
    }
    return { ok: true, assistant, samples };
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

    // Timestamped assistant output this session has produced, plus — only from
    // a family root — every subagent session's. A child asking `family()` gets
    // its ancestors and siblings back, so it keeps its own samples.
    const scans: TpsScan[] = [scanMessages(sessionID)];
    if (isFamilyRoot(sessionID)) {
      try {
        for (const id of context.data.session.family(sessionID) ?? []) {
          if (id !== sessionID) scans.push(scanMessages(id));
        }
      } catch {
        // No family on this host: the session's own samples still stand.
      }
    }

    const samples: ThroughputSample[] = [];
    let assistant = 0;
    let readOk = false;
    for (const scan of scans) {
      samples.push(...scan.samples);
      assistant += scan.assistant;
      readOk = readOk || scan.ok;
    }

    if (hostStamps === undefined) {
      // A stamped assistant turn proves the host stamps. Assistant turns with
      // no timestamp prove it does not. Neither, and the capability stays
      // unknown so the row hides rather than guessing a metric.
      if (samples.length > 0) hostStamps = true;
      else if (readOk && assistant > 0) hostStamps = false;
      else return undefined;
    }

    if (hostStamps === true) {
      return windowedThroughput(samples, Date.now(), TPS_WINDOW_MS, created);
    }
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