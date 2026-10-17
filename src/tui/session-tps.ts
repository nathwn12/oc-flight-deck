// Session throughput, measured from the host's own streaming events and its
// own message timestamps — never from a clock this process keeps — as a
// realtime estimate, and as the settled-turn average that estimate complements.
//
// `rt` is the realtime figure from ./realtime-tps.js: it estimates tokens from
// the host's `session.text.delta` / `session.reasoning.delta` events, because
// a poll of `session.message.list` can only see a turn's tokens after it
// settles. It reads fresh on every render — no cache here — and 0 while
// nothing streams. `avg` is the settled-turn average: generation tokens over
// assistant turns that recorded `streamed`, divided by the union of their
// `streamed - created` spans — the whole scope's mean decoding speed, which
// holds steady through idle gaps instead of reading zero between turns. An
// in-flight turn (no `streamed` yet) enters neither side of the average. The
// numerator is generation
// tokens - output plus reasoning, which keeps its own row too - and the
// denominator is generating time only: the union of the streaming spans in
// scope. The scope is `sidebar.tps.scope` (`./config.js`): `"family"` (the
// default) paces the displayed session plus its subagent sessions, summing
// generation tokens across the whole family over the UNION of all their
// spans, so concurrent decoders share wall clock instead of adding it; a
// root that has gone idle while its child is still decoding still reads
// realtime. `"session"` restores the per-session figure: the displayed
// session's own samples alone, reading zero whenever it stops streaming, even
// while a child still runs.
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
// every tick would repeat the same work fifty times a second, so the average
// is held briefly. Zero is cached too: an idle session must not be re-derived
// on each tick either. The realtime figure takes no part in that cache: it is
// estimated from events that arrive between renders, so it is read fresh on
// every render and would go stale behind a 1s hold.
//
// One factory closes over the plugin `context`. The math itself lives in
// ./throughput.js (settled spans, EWMA, hysteresis) and ./realtime-tps.js
// (delta-event samples).

import type { Plugin } from "@opencode/plugin/tui";
import { asCount, asRecord, type SessionLike } from "./coerce.js";
import { DEFAULT_TPS_SCOPE, type TpsScope } from "./config.js";
import { createRealtimeTps, type RealtimeTps } from "./realtime-tps.js";
import {
  settledAverageRate,
  turnKey,
  turnSpan,
  type ThroughputSpan,
} from "./stats.js";

/** What one session's message list contributes to the settled-turn average. */
interface TpsScan {
  /** False only when the host refused to list the session's messages. */
  readonly ok: boolean;
  /** Assistant messages seen, whether or not they carried a timestamp. */
  readonly assistant: number;
  /** Assistant turns that carried any usable timestamp, which proves the host stamps. */
  readonly stamped: number;
  /**
   * The settled-turn average's own spans: turns that carried a usable
   * `created` start AND recorded `streamed`. An in-flight turn has no
   * decoding end yet, so it stays out of the numerator and the denominator
   * together — partial work never dilutes or inflates the mean. With
   * `streamed` recorded the span already ends there (clamped), so each entry
   * is the same object the old `spans` list carried; only membership differs.
   */
  readonly settled: readonly ThroughputSpan[];
}

/**
 * The live signal the TPS reader borrows rather than re-deriving: the active
 * clock (how much generating time is on record?) is the denominator for a host
 * with no message timestamps — that clock already covers the scope, so it is
 * borrowed as-is. It comes from ./session-reads.js; absent, the stamped path
 * still works and the unstamped path reads as unknown for lack of time. There is
 * deliberately no busy gate here: idleness is read off the session's own
 * generating-time delta, never off a family-wide flag.
 */
export interface TpsLiveReads {
  readonly elapsedMsOf?: (sessionID: string, now: number) => number | undefined;
}

export function createTpsReader(
  context: Plugin.Context,
  live?: TpsLiveReads,
  scope: TpsScope = DEFAULT_TPS_SCOPE,
  realtime?: RealtimeTps,
) {
  const TPS_CACHE_MS = 1_000;
  let hostStamps: boolean | undefined;
  let tpsCache: { readonly sessionID: string; readonly at: number; readonly avg: number | undefined } | undefined;
  // The realtime figure's own subscriptions. A caller that already owns one
  // (the plugin setup, which wires disposal) passes it in; tests that only
  // pin the average get the degraded tracker — no `data.on` on their stub
  // context, so `rt` reads 0 and the average asserts alone.
  const tracker = realtime ?? createRealtimeTps(context);

  const scanMessages = (id: string, now: number): TpsScan => {
    let messages: readonly unknown[];
    try {
      messages = context.data.session.message.list(id) ?? [];
    } catch {
      // A refused read is not "this host has no messages".
      return { ok: false, assistant: 0, stamped: 0, settled: [] };
    }
    const settled: ThroughputSpan[] = [];
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
      const settledTurn = completed !== undefined || streamed !== undefined;
      const key = turnKey(message["id"], created, completed, output, streamed);
      const turn: ThroughputSpan = {
        key: settledTurn ? `${key}:${asCount(reasoning) ?? "?"}` : key,
        tokens: output,
        reasoning,
        ...span,
      };
      // Only a turn that recorded `streamed` has a decoding end: without it
      // the turn is still in flight (or settled only its tools), and it stays
      // out of the average entirely. The span above already ends at `streamed`
      // when it is recorded, so the same entry serves the average directly.
      if (streamed !== undefined) settled.push(turn);
    }
    return { ok: true, assistant, stamped, settled };
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

  // Settled spans for the whole family scope: every member's own spans, keyed
  // per member so two sessions' id-less turns sharing a start stay distinct.
  // The union downstream merges their overlaps — concurrent decoders share
  // wall clock, so it is never summed.
  const scanScope = (ids: readonly string[], now: number): TpsScan => {
    let ok = true;
    let assistant = 0;
    let stamped = 0;
    const settled: ThroughputSpan[] = [];
    for (const id of ids) {
      const scan = scanMessages(id, now);
      // A refused read is not "this member has no messages": one failure
      // keeps the capability unknown rather than proving anything.
      ok = ok && scan.ok;
      assistant += scan.assistant;
      stamped += scan.stamped;
      for (const span of scan.settled) settled.push({ ...span, key: `${id} ${String(span.key)}` });
    }
    return { ok, assistant, stamped, settled };
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
  // walk reports it and the average stays unknown rather than dividing a
  // partial figure.
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

  /**
   * Both figures for one displayed session: the realtime estimate and the
   * settled-turn average.
   *
   * `rt` is the delta-event figure, `0` while nothing streams or on a host
   * with no subscription surface. `avg` is the settled-turn mean over the
   * same scope — generation tokens over turns that recorded `streamed`,
   * divided by the union of their spans — and `undefined` when no settled
   * turn exists, so the row hides rather than inventing a rate. `ttft` is
   * the mean time to first token over the same scope, in seconds, and
   * `undefined` while no step with a first delta is on record.
   */
  interface TpsFigures {
    readonly rt: number;
    readonly avg: number | undefined;
    readonly ttft?: number | undefined;
  }

  const computeAvg = (sessionID: string, session: SessionLike | undefined): number | undefined => {
    const time = asRecord(session?.time);
    const created = asCount(time?.["created"]);

    const now = Date.now();

    // Timestamped assistant generation in scope — the whole family under
    // `"family"`, this session's own spans only under `"session"`.
    const scan: TpsScan =
      hostStamps === false
        ? { ok: true, assistant: 0, stamped: 0, settled: [] }
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

    if (hostStamps === true) {
      // A refused member read leaves an incomplete cumulative total, so the
      // average stays unknown rather than dividing partial spans (which
      // would undercount time and inflate the mean).
      // `"session"` never takes this branch: its single read keeps the
      // pre-change behaviour byte-identically.
      if (scope === "family" && scan.ok === false) return undefined;
      // The average over the same scope needs no baselines: settled turns
      // already divide on the first poll. In-flight turns never entered
      // `settled`, so no second filter is needed here.
      return settledAverageRate(scan.settled);
    }

    // No timestamps on this host: the denominator is the active clock, which
    // already covers the family scope (it IS the `elapsed` figure), so it is
    // borrowed as-is. Without that clock there is no honest denominator
    // - the average stays unknown rather than falling back to a lifetime
    // average that bills idle as work.
    const family = scope === "family" ? familyGeneration(sessionID, session) : undefined;
    // As on the stamped path: one unreadable member leaves the total
    // incomplete, so the average stays unknown rather than dividing a partial
    // numerator.
    if (family !== undefined && family.ok === false) return undefined;
    const generation = family?.generation ?? recordGeneration(session);
    // The creation-time gate is the `"session"` scope's alone: without a
    // stamp there is no clock to borrow. Under `"family"` the displayed
    // session may carry no stamp while a child still paces off the
    // family-wide active clock, so the gate must not silence it.
    if (created === undefined && scope === "session") {
      return undefined;
    }
    let genMs = 0;
    try {
      genMs = live?.elapsedMsOf?.(sessionID, now) ?? 0;
    } catch {
      genMs = 0;
    }
    // No per-turn stamps here, so the average is the generation count over
    // the same borrowed active clock, in seconds — and no clock means no
    // average, never a wall-clock lifetime figure.
    return genMs > 0 ? generation / (genMs / 1_000) : undefined;
  };

  // The reader never answers `undefined` for a session it was asked about: a
  // session that is not streaming reads zero immediately, and a session with
  // no figure yet reads zero too. The average is the exception that proves
  // the rule: unknown stays unknown, so the row hides rather than drawing a
  // zero it cannot stand behind. (The row itself hides a zero; that decision
  // lives in ./rows.js.)
  const sessionTps = (sessionID: string, session: SessionLike | undefined): TpsFigures => {
    // The realtime figures are estimated from events that arrive between
    // renders: they read fresh on every render and take no part in the cache
    // below, which holds the settled-average scan alone.
    const ids = scope === "family" ? familyIds(sessionID) : [sessionID];
    let rt = 0;
    try {
      rt = tracker.rate(sessionID, ids);
    } catch {
      rt = 0;
    }
    let ttft: number | undefined;
    try {
      ttft = tracker.ttft(ids);
    } catch {
      ttft = undefined;
    }
    const cached = tpsCache;
    if (cached !== undefined && cached.sessionID === sessionID && Date.now() - cached.at < TPS_CACHE_MS) {
      return { rt, avg: cached.avg, ttft };
    }
    const avg = computeAvg(sessionID, session);
    tpsCache = { sessionID, at: Date.now(), avg };
    return { rt, avg, ttft };
  };

  return { sessionTps };
}
