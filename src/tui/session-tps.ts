// Session throughput, measured from the host's own message timestamps and never
// from a clock this process keeps - as a near-instantaneous output rate, not a
// lifetime average.
//
// Each poll feeds cumulative generation tokens and cumulative generating
// milliseconds into the EWMA tracker (`./throughput.js`): the rate is the
// DELTA between successive polls, smoothed (alpha 0.3) and repainted only on
// a move of >= 1 tok/s or >= 10%, so the row tracks live decoding instead of
// sagging behind everything ever produced. The numerator is generation
// tokens - output plus reasoning, which keeps its own row too - and the
// denominator is generating time only: the union of the streaming spans in
// scope. The scope is `sidebar.tps.scope` (`./config.js`): `"family"` (the
// default) paces the displayed session plus its subagent sessions, summing
// generation tokens across the whole family over the UNION of all their
// spans, so concurrent decoders share wall clock instead of adding it; a
// root that has gone idle while its child is still decoding still reads
// live. `"session"` restores the per-session figure: the displayed session's
// own tokens over its own spans, reading zero whenever its own generating
// time does not advance, even while a child still runs. The idle test is the
// denominator's delta either way: when the generating time in scope does not
// advance between polls, nothing in scope is generating right now, so the
// reader reports zero — idle means no tokens per second are being produced.
// The first poll for a session only sets the tracker's baselines and reads
// as zero — no rate is known yet, and the cumulative lifetime average never
// seeds the figure, so a session deep into its life must not flash its
// history as if it were live.
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
import { DEFAULT_TPS_SCOPE, type TpsScope } from "./config.js";
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

export function createTpsReader(context: Plugin.Context, live?: TpsLiveReads, scope: TpsScope = DEFAULT_TPS_SCOPE) {
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

  // The displayed session plus every id `family()` returns for it — the same
  // traversal `busy()` in ./session-reads.js consults, so the scope is the
  // one the `elapsed` row already covers. A host without `family()` degrades
  // to the session alone rather than failing the row.
  const familyIds = (sessionID: string): readonly string[] => {
    const ids = [sessionID];
    try {
      for (const id of context.data.session.family(sessionID) ?? []) {
        if (id === sessionID || ids.includes(id)) continue;
        ids.push(id);
      }
    } catch {
      // No family on this host: the session's own turns still stand.
    }
    return ids;
  };

  // Generation spans for the whole family scope: every member's own spans,
  // keyed per member so two sessions' id-less turns sharing a start stay
  // distinct. The union downstream merges their overlaps — concurrent
  // decoders share wall clock, so it is never summed.
  const scanScope = (ids: readonly string[], now: number): TpsScan => {
    let ok = true;
    let assistant = 0;
    let stamped = 0;
    const spans: ThroughputSpan[] = [];
    for (const id of ids) {
      const scan = scanMessages(id, now);
      // A refused read is not "this member has no messages": one failure
      // keeps the capability unknown rather than proving anything.
      ok = ok && scan.ok;
      assistant += scan.assistant;
      stamped += scan.stamped;
      for (const span of scan.spans) spans.push({ ...span, key: `${id} ${String(span.key)}` });
    }
    return { ok, assistant, stamped, spans };
  };

  // Generation tokens on record for the session: its own record's `output`
  // and `reasoning` rungs. The `"session"` scope stops here — a root reports
  // only its own rate, and a child keeps its own figure.
  const recordGeneration = (session: SessionLike | undefined): number => {
    const tokens = asRecord(session?.tokens);
    return (asCount(tokens?.["output"]) ?? 0) + (asCount(tokens?.["reasoning"]) ?? 0);
  };

  // Generation tokens on record for the whole family scope: the displayed
  // session's own rungs plus every member's. One unreadable member must not
  // blank the rest of the tree — but the total is then incomplete, so the
  // walk reports it and the caller holds the tracker's baselines instead of
  // feeding the partial figure in.
  const familyGeneration = (
    sessionID: string,
    session: SessionLike | undefined,
  ): { readonly ok: boolean; readonly generation: number } => {
    let generation = recordGeneration(session);
    let ok = true;
    for (const id of familyIds(sessionID)) {
      if (id === sessionID) continue;
      try {
        generation += recordGeneration(context.data.session.get(id) as SessionLike | undefined);
      } catch {
        // One unreadable member must not blank the rest of the tree.
        ok = false;
      }
    }
    return { ok, generation };
  };

  const computeTps = (sessionID: string, session: SessionLike | undefined): number | undefined => {
    const time = asRecord(session?.time);
    const created = asCount(time?.["created"]);

    const now = Date.now();

    // Timestamped assistant generation in scope — the whole family under
    // `"family"`, this session's own spans only under `"session"`.
    const scan: TpsScan =
      hostStamps === false
        ? { ok: true, assistant: 0, stamped: 0, spans: [] }
        : scope === "family"
          ? scanScope(familyIds(sessionID), now)
          : scanMessages(sessionID, now);

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
      // A refused member read leaves an incomplete cumulative total: feeding
      // it in would move the baselines, and the member's history would return
      // as a spike on recovery. The poll reads as zero with the baselines
      // held, so the next healthy poll divides only what is genuinely new.
      // `"session"` never takes this branch: its single read keeps the
      // pre-change behaviour byte-identically.
      if (scope === "family" && scan.ok === false) return 0;
      // Generating time is the union of the turns' spans in scope: idle
      // between turns was never recorded, so it can never enter the rate. An
      // in-flight turn ends at now, so the denominator keeps pace with the
      // decoder while work happens and freezes the instant it settles. The
      // numerator over it is generation: output plus reasoning.
      const { tokens } = unionGenerationTotals(scan.spans);
      const genMs = unionSpanMs(scan.spans);
      return tracker(tokens, genMs);
    }

    // No timestamps on this host: the denominator is the active clock, which
    // already covers the family scope (it IS the `elapsed` figure), so it is
    // borrowed as-is. Without that clock there is no honest denominator
    // - the row reads as zero rather than falling back to a lifetime average
    // that bills idle as work.
    const family = scope === "family" ? familyGeneration(sessionID, session) : undefined;
    // As on the stamped path: one unreadable member leaves the total
    // incomplete, so the poll reads as zero with the baselines held.
    if (family !== undefined && family.ok === false) return 0;
    const generation = family?.generation ?? recordGeneration(session);
    // The creation-time gate is the `"session"` scope's alone: without a
    // stamp there is no clock to borrow. Under `"family"` the displayed
    // session may carry no stamp while a child still paces off the
    // family-wide active clock, so the gate must not silence it.
    if (created === undefined && scope === "session") return tracker(recordGeneration(session), 0);
    let genMs = 0;
    try {
      genMs = live?.elapsedMsOf?.(sessionID, now) ?? 0;
    } catch {
      genMs = 0;
    }
    return tracker(generation, genMs);
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
