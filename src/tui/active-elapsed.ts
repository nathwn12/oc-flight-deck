// Accumulated active time for one session, measured rather than assumed.
//
// Wall-clock since `time.created` reports a session left open overnight as a
// night's work. This clock only advances while the session — or something in
// its family, or one of its shells — is actually running, and it freezes the
// instant everything settles. `busy()` decides that, so the `elapsed` and
// `status` rows can never disagree about whether work is happening.
//
// One session is watched at a time. Reading a different session means the gap
// on the previous one happened off-watch, so its next read rebaselines and
// banks nothing. A window is billed only when the session was busy at both
// ends and the window was observed within the bound — so no single unobserved
// gap is ever billed beyond the optional `maxBankedMs`, and a longer gap banks
// nothing at all.
//
// State is a per-session accumulator held in this process and keyed by the
// displayed session, so an unrelated project's session can never contribute.
// The figure starts from a seed the caller may supply: the merged spans of the
// assistant turns the host already recorded for that session's scope. That is
// read once, from the host's own timestamps, so a restart comes back with the
// work already on record instead of zero. Work observed live after that first
// read keeps accumulating on top in memory, and a host that offers no seed
// (or no timestamps) starts at zero and behaves exactly as it did before. The
// seed is asked for once per session, when that session is first seen; an
// unknown busy state (`undefined`) freezes rather than inventing motion.

/** How the caller answers "is this session working right now?". */
export type BusyRead = (sessionID: string) => boolean | undefined;

/** How the caller answers "how much work is already on record for this session?". */
export type SeedRead = (sessionID: string) => number | undefined;

export interface ActiveElapsedOptions {
  /**
   * Longest window that may be banked as work. A longer one was not observed
   * — a suspended process, sparse host events — so it banks nothing.
   *
   * Defaults to 60_000 so the module's own contract holds even when the
   * caller supplies no bound. A production caller still passes its own
   * derived bound.
   */
  readonly maxBankedMs?: number;

  /**
   * Starting tally for a session, read once — on the first observation of that
   * session — so restart-stable work already on record is not lost. Floored at
   * zero; a non-finite or throwing read is treated as zero, never propagated.
   */
  readonly seedOf?: SeedRead;
}

/** One session's running tally and the last instant it was observed. */
interface ActiveState {
  accumulated: number;
  lastAt: number;
  running: boolean;
}

/**
 * Build the active clock. One session is watched at a time. A read banks the
 * time since the previous read only when the session was running at BOTH ends
 * of that window — so overlapping activities record one wall-clock window, not
 * one per activity, and a window in which the session settled is treated as
 * idle rather than billed. Reads while the tally is zero return `undefined`,
 * matching the row's own "nothing to show yet" behaviour.
 *
 * The observation boundary is unconditional: a read of a different session than
 * the one before it rebaselines and banks nothing, because the gap happened
 * off-watch. The optional `maxBankedMs` is an independent cap on top of that —
 * any window longer than it was unobserved and banks nothing — not a switch for
 * the boundary. Undercount is acceptable, over-count is not.
 */
export function createActiveElapsed(isBusy: BusyRead, options: ActiveElapsedOptions = {}) {
  const states = new Map<string, ActiveState>();
  // The module's own contract must hold without the caller opting in; the
  // production caller still passes its own derived bound.
  const maxBankedMs = options.maxBankedMs ?? 60_000;
  let lastRead: string | undefined;

  return function activeElapsedMs(sessionID: string, now: number): number | undefined {
    if (!Number.isFinite(now)) return undefined;

    // A throwing or unknown read means "not known to be busy", which freezes.
    let busy = false;
    try {
      busy = isBusy(sessionID) === true;
    } catch {
      busy = false;
    }

    // Observation boundary: a different session on screen means this one's
    // gap since the last read happened off-watch, so take a fresh baseline.
    const boundary = lastRead !== undefined && lastRead !== sessionID;
    lastRead = sessionID;

    let state = states.get(sessionID);
    if (state === undefined) {
      // First sight of this session: take the seed once, here, so the record
      // covers everything up to the moment observation begins and the
      // accumulator below covers everything after — no overlap, no double
      // count. Floored at zero; a non-finite or throwing read is zero.
      let seed = 0;
      if (options.seedOf !== undefined) {
        try {
          const value = options.seedOf(sessionID);
          if (typeof value === "number" && Number.isFinite(value) && value > 0) seed = value;
        } catch {
          seed = 0;
        }
      }
      state = { accumulated: seed, lastAt: now, running: false };
      states.set(sessionID, state);
    } else if (!boundary && state.running && busy) {
      // Only a window that was busy at BOTH ends and short enough to have been
      // observed is work. A settled gap is idle; a stalled or stepped-back
      // clock must never subtract; an over-long window was not watched.
      const delta = now - state.lastAt;
      if (delta > 0 && delta <= maxBankedMs) state.accumulated += delta;
    }

    state.running = busy;
    state.lastAt = now;
    return state.accumulated <= 0 ? undefined : state.accumulated;
  };
}
