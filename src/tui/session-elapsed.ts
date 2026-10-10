// Active time over a session scope's whole lifetime, derived rather than
// accumulated.
//
// The figure is the merged union of the assistant-turn spans the host already
// recorded for the scope (see ./stats.js), with a still-in-flight turn ending
// at `now` — recomputed from the host's own records on every fresh read, never
// from wall-clock since `time.created` and never persisted to disk. So a
// restart comes back with the same value instead of resetting (the host
// retains message rows across compaction), while a turn that is in flight
// climbs as `now` advances; when everything settles the figure freezes.
//
// A per-session high-water mark held in this process guarantees the row can
// never visibly step backwards while the host still reports those turns: a
// compaction that drops old messages, or a transient read failure, must not
// shrink what is on screen. Every read is floored at zero, and reads while
// the high-water is still zero return `undefined`, matching the row's own
// "nothing to show yet" behaviour.
//
// The row reads in whole seconds, so the computed union is cached per session
// for `cacheMs` (default one second — the display resolution): the fast tick
// must not rescan every message of the scope twenty times a second. The
// high-water moves only on a fresh computation, never on a cached read. One
// entry per session carries BOTH the mark and the short-lived computed union,
// and the mark is not a cache entry: it must never share a cache's eviction.
// The map is pruned only by a sweep that runs when it grows past `maxSessions`
// (default 256): the sweep drops exactly the entries whose session the host
// no longer knows — asked through `reads.knows`, which defaults to "known"
// when absent — and never an arbitrary recency cut that could evict a live
// session's mark. A TUI lifetime of session-hopping therefore cannot grow the
// map forever, yet a live session's figure cannot step backwards no matter how
// many other sessions were viewed since.
//
// Pure except for its own memory: it takes no clock and no context, so it is
// trivially testable.

import { unionSpanMs, type ThroughputSpan } from "./stats.js";

/** The assistant-turn spans on record for the scope, in-flight turns ending at `now`. */
export interface ActiveSpanReads {
  spansOf(sessionID: string, now: number): readonly ThroughputSpan[];
  /**
   * Whether the host still knows the session. The sweep consults this before
   * dropping an entry; absent, every session counts as known and nothing is
   * ever swept.
   */
  knows?(sessionID: string): boolean;
}

export interface ActiveTimeOptions {
  readonly cacheMs?: number;
  readonly maxSessions?: number;
}

/** One session's cached union and the most it has ever computed. */
interface ActiveEntry {
  union: number;
  at: number;
  high: number;
}

/**
 * Build the active clock. Each fresh computation re-derives the figure from
 * the host's own spans, so the record covers the scope's whole lifetime with
 * no overlap to double-count and nothing held over a restart to go stale —
 * and the high-water keeps the row monotonic across compactions and failed
 * reads alike. Reads while the high-water is zero return `undefined`,
 * matching the row's own "nothing to show yet" behaviour.
 */
export function createActiveTime(
  reads: ActiveSpanReads,
  options?: ActiveTimeOptions,
): (sessionID: string, now: number) => number | undefined {
  const cacheMs = options?.cacheMs ?? 1_000;
  const maxSessions = options?.maxSessions ?? 256;
  const entries = new Map<string, ActiveEntry>();

  // Drop only what the host has forgotten. A generous bound keeps a TUI
  // lifetime of session-hopping from growing the map forever, but the cut is
  // never by recency: evicting a live session would throw away its
  // high-water mark and let the row step backwards.
  const sweepForgotten = (): void => {
    for (const id of entries.keys()) {
      let known = true;
      try {
        known = reads.knows?.(id) ?? true;
      } catch {
        known = true;
      }
      if (!known) entries.delete(id);
    }
  };

  return function activeTimeMs(sessionID: string, now: number): number | undefined {
    let entry = entries.get(sessionID);
    // A stepped-back clock serves whatever is on record rather than rescanning
    // against a `now` the spans never belonged to, and a non-finite `now`
    // serves it too rather than inventing a figure.
    const fresh =
      entry === undefined || (Number.isFinite(now) && now - entry.at >= cacheMs);
    if (fresh && Number.isFinite(now)) {
      let union = 0;
      try {
        union = unionSpanMs(reads.spansOf(sessionID, now));
      } catch {
        union = 0;
      }
      if (!Number.isFinite(union) || union < 0) union = 0;
      const high = Math.max(entry?.high ?? 0, union);
      if (entry === undefined) {
        if (entries.size >= maxSessions) sweepForgotten();
        entry = { union, at: now, high };
        entries.set(sessionID, entry);
      } else {
        entry.union = union;
        entry.at = now;
        entry.high = high;
      }
    }
    const high = entry?.high ?? 0;
    return high <= 0 ? undefined : high;
  };
}
