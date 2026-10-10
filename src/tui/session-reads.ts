// Everything the host knows about the session on screen.
//
// One factory closes over the plugin `context` and returns the read-only
// lookups the rail needs: the session's messages, family tree, status,
// activity, shells, permissions, and derived figures (context occupancy,
// elapsed time, subagent totals, busy). Every lookup degrades to "no data"
// instead of throwing — the rail must never break because a read failed.
// Coercion of untrusted values happens through ./coerce.js.

import type { Plugin } from "@opencode/plugin/tui";
import { createActiveTime } from "./session-elapsed.js";
import { asCount, asRecord, asText, type SessionLike } from "./coerce.js";
import { turnKey, type ThroughputSpan } from "./stats.js";

/**
 * The location the rail reads shell records and VCS from: the host's current
 * location, or its default when no location is set. A host that cannot resolve
 * a default degrades to "no location" rather than taking the rail down.
 */
export function locationOf(context: Plugin.Context) {
  try {
    return context.location ?? context.data.location.default();
  } catch {
    return context.location;
  }
}

export function createSessionReads(context: Plugin.Context) {
  /** How many trailing messages are inspected for tool parts. */
  const RECENT_MESSAGES = 4;

  // The host owns these caches; a failure to read one must never break the
  // rail, so every lookup degrades to "no data" instead of throwing.
  const messagesOf = (sessionID: string): readonly unknown[] => {
    try {
      return context.data.session.message.list(sessionID) ?? [];
    } catch {
      return [];
    }
  };

  // A subagent session is already inside its parent's family total, and the
  // host keys `family()` by the family ROOT — so asking from a child returns
  // its ancestors and siblings as well. Merging that would report the whole
  // tree as this conversation's own, under a label that promises the
  // conversation plus *its* subagents. Only a root has a family beneath it.
  const isFamilyRoot = (sessionID: string): boolean => {
    try {
      return context.data.session.root(sessionID) === sessionID;
    } catch {
      // A host without `root` keeps the previous behaviour rather than
      // silently dropping everyone's subagent total.
      return true;
    }
  };

  // Subagent sessions are separate sessions, and the parent's `cost` does not
  // include them, so a bare `cost` row understates a swarm. Sum the family —
  // and the same scope for `tokens`: the money row already shows the family,
  // so the token rows beside it must share it, or one row's swarm is another
  // row's session. The parent's own tokens come from its session record (its
  // own cost arrives via `ownCost`, already in the caller's hand), every
  // child's from theirs: `input`, `output`, `reasoning`, and both `cache`
  // rungs, so a caller that uses this INSTEAD of the session's own record
  // gets the full family figure.
  const treeTotals = (sessionID: string, ownCost: unknown) => {
    if (!isFamilyRoot(sessionID)) return undefined;

    let ids: readonly string[];
    try {
      ids = context.data.session.family(sessionID) ?? [sessionID];
    } catch {
      return undefined;
    }
    if (ids.length <= 1) return undefined;

    let own: SessionLike | undefined;
    try {
      own = context.data.session.get(sessionID) as SessionLike | undefined;
    } catch {
      own = undefined;
    }
    const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
    const addTokens = (source: SessionLike | undefined): void => {
      const record = asRecord(source?.tokens);
      tokens.input += asCount(record?.["input"]) ?? 0;
      tokens.output += asCount(record?.["output"]) ?? 0;
      tokens.reasoning += asCount(record?.["reasoning"]) ?? 0;
      const cache = asRecord(record?.["cache"]);
      tokens.cache.read += asCount(cache?.["read"]) ?? 0;
      tokens.cache.write += asCount(cache?.["write"]) ?? 0;
    };
    addTokens(own);

    let cost = asCount(ownCost) ?? 0;
    let count = 0;
    for (const id of ids) {
      if (id === sessionID) continue;
      let child: SessionLike | undefined;
      try {
        child = context.data.session.get(id) as SessionLike | undefined;
      } catch {
        // One unreadable member must not blank the rest of the tree.
        continue;
      }
      if (child === undefined) continue;
      count += 1;
      cost += asCount(child.cost) ?? 0;
      addTokens(child);
    }
    return count === 0 ? undefined : { cost, count, tokens };
  };

  // A message's own totals are per-request, so the last assistant message's
  // prompt size is an ESTIMATE of the current context occupancy - not a running
  // total, and not a host-reported figure (hence the `~` on the `context` row).
  // It sums input + cache read + cache WRITE: a written entry still occupies
  // the window, even though `write` is deliberately excluded from the `cache`
  // row's hit-rate denominator (creating an entry is not a lookup).
  const contextUsage = (sessionID: string, model: unknown) => {
    const messages = messagesOf(sessionID);
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const tokens = asRecord(asRecord(messages[index])?.tokens);
      const input = asCount(tokens?.input);
      if (tokens === undefined || input === undefined) continue;
      const cache = asRecord(tokens.cache);
      const used = input + (asCount(cache?.read) ?? 0) + (asCount(cache?.write) ?? 0);
      if (used === 0) return undefined;
      return { used, limit: contextLimit(model) };
    }
    return undefined;
  };

  // The window lives at `limit.context` on the catalog entry, and two
  // providers can expose the same model id with different windows — so the
  // provider has to match too, or the gauge would read the wrong ceiling.
  const contextLimit = (model: unknown): number | undefined => {
    const ref = asRecord(model);
    const id = ref?.id;
    const providerID = ref?.providerID;
    if (typeof id !== "string") return undefined;
    try {
      const location = context.location ?? context.data.location.default();
      for (const entry of context.data.location.model.list(location) ?? []) {
        const record = asRecord(entry);
        if (record === undefined || record.id !== id) continue;
        if (typeof providerID === "string" && record.providerID !== providerID) continue;
        const limit = asRecord(record.limit);
        return asCount(limit?.context) ?? asCount(record.context) ?? asCount(record.contextWindow);
      }
    } catch {
      return undefined;
    }
    return undefined;
  };

  const statusOf = (sessionID: string): string | undefined => {
    try {
      return context.data.session.status(sessionID);
    } catch {
      return undefined;
    }
  };

  // Recent tool parts, oldest first. Only the tail is inspected: a loop that is
  // not currently happening is history, and a hang is by definition now.
  const recentParts = (sessionID: string): readonly unknown[] => {
    const parts: unknown[] = [];
    for (const entry of messagesOf(sessionID).slice(-RECENT_MESSAGES)) {
      const content = asRecord(entry)?.["content"];
      if (Array.isArray(content)) parts.push(...content);
    }
    return parts;
  };

  // The host's own shell records, which outlive the tool call: a backgrounded
  // command returns its result immediately, so its part settles while the
  // process keeps running. This is the only signal that survives that.
  //
  // Shells are listed per LOCATION, not per session, so the session is matched
  // on the record's own `metadata.sessionID` — the documented shape, rather
  // than a session-scoped accessor the published API does not carry.
  const shellsOf = (sessionID: string): readonly unknown[] => {
    try {
      const shells = context.data.shell.list(locationOf(context)) ?? [];
      return shells.filter(
        (entry) => asText(asRecord(asRecord(entry)?.["metadata"])?.["sessionID"]) === sessionID,
      );
    } catch {
      return [];
    }
  };

  // The newest thing the host recorded for this session that is not a tool
  // part, so the quiet-turn rule is not blind to a model that is streaming.
  const lastActivity = (sessionID: string): number | undefined => {
    const messages = messagesOf(sessionID);
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const time = asRecord(asRecord(messages[index])?.["time"]);
      const stamp =
        asCount(time?.["completed"]) ?? asCount(time?.["streamed"]) ?? asCount(time?.["created"]);
      if (stamp !== undefined) return stamp;
    }
    return undefined;
  };

  // What is waiting, not just how many. A bare count tells you to go and look;
  // naming the request tells you whether it is worth looking at.
  const permsOf = (
    sessionID: string,
  ): { count: number; action?: string; resource?: string } | undefined => {
    try {
      const requests = context.data.session.permission.list(sessionID);
      if (requests === undefined || requests.length === 0) return undefined;
      const first = asRecord(requests[0]);
      const action = typeof first?.["action"] === "string" ? first["action"] : undefined;
      const resources = Array.isArray(first?.["resources"]) ? first["resources"] : [];
      const resource = typeof resources[0] === "string" ? resources[0] : undefined;
      return { count: requests.length, action, resource };
    } catch {
      return undefined;
    }
  };

  // Anything genuinely working keeps the status glyph turning: this session
  // (thinking, streaming, running tools), any subagent in its tree, or a shell
  // command still running. Returns `undefined` when the host has not said
  // either way, so the rail can omit the row rather than invent "idle".
  const busy = (sessionID: string): boolean | undefined => {
    const status = statusOf(sessionID);
    if (status === "running") return true;

    try {
      for (const id of context.data.session.family(sessionID) ?? []) {
        if (id === sessionID) continue;
        try {
          if (context.data.session.status(id) === "running") return true;
        } catch {
          // One unreadable child must not hide a running sibling.
        }
      }
    } catch {
      // No subagent status on this host; the shell check below still applies.
    }

    try {
      if (shellsOf(sessionID).some((entry) => asRecord(entry)?.["status"] === "running")) return true;
    } catch {
      // Unreadable shells just mean no shell signal.
    }

    return status === undefined ? undefined : false;
  };

  // Active time over the session's whole lifetime, derived from the host's own
  // timestamps rather than accumulated in this process: the figure is the
  // merged union of the assistant turns' spans across exactly the scope
  // `busy()` consults — the displayed session plus every id `family()`
  // returns — with an uncompleted turn ending at `now` while the scope is
  // genuinely working, and collapsing to its last recorded stamp when nothing
  // is working. So a restart recomputes the same figure instead of resetting,
  // a climbing turn keeps climbing while it is in flight, a settled scope
  // freezes, and a stalled or abandoned turn bills no idle time. Tokens are
  // ignored: a zero-output turn still took wall time. One `now` for the whole
  // scan, so every in-flight turn ends at the same instant and the union
  // cannot be skewed by the reads drifting apart. Every read degrades to
  // empty rather than throwing, so an absent family or an unstamped host hides
  // the row instead of breaking the rail. Monotonicity, caching and the
  // per-session bound live in ./session-elapsed.js; this is only the host read.
  const spansOf = (sessionID: string, now: number): readonly ThroughputSpan[] => {
    try {
      // Whether the scope is genuinely working, read once for the whole scan:
      // every uncompleted turn in it shares the same end rule, and the scope
      // is exactly what `busy()` already consults. A read that throws counts
      // as not busy.
      let live = false;
      try {
        live = busy(sessionID) === true;
      } catch {
        live = false;
      }
      const ids = new Set<string>([sessionID]);
      try {
        for (const id of context.data.session.family(sessionID) ?? []) ids.add(id);
      } catch {
        // No family on this host: the session's own turns still stand.
      }
      const spans: ThroughputSpan[] = [];
      for (const id of ids) {
        for (const entry of messagesOf(id)) {
          const message = asRecord(entry);
          if (message?.["type"] !== "assistant") continue;
          const stamp = asRecord(message["time"]);
          const created = asCount(stamp?.["created"]);
          if (created === undefined) continue;
          const completed = asCount(stamp?.["completed"]);
          const streamed = asCount(stamp?.["streamed"]);
          // A completed turn ends at `completed`, covering its tool
          // settlement. An uncompleted one ends at `now` while the scope is
          // genuinely working, and collapses to its last recorded stamp
          // (`streamed`, else its own start) when nothing is working — so a
          // host that never writes `completed` cannot bill idle either.
          const end = completed ?? (live ? now : (streamed ?? created));
          if (!Number.isFinite(end)) continue;
          const output = asRecord(message["tokens"])?.["output"];
          spans.push({
            key: turnKey(message["id"], created, completed, output, streamed),
            start: created,
            end: Math.max(created, end),
          });
        }
      }
      return spans;
    } catch {
      // A throwing read never reaches the rail: it degrades to no spans.
      return [];
    }
  };

  // Whether the host still knows a session. The elapsed clock's sweep consults
  // this before dropping an entry, so only a forgotten session loses its
  // high-water mark; a throwing or absent record counts as forgotten.
  const knows = (sessionID: string): boolean => {
    try {
      return context.data.session.get(sessionID) !== undefined;
    } catch {
      return false;
    }
  };

  const activeTime = createActiveTime({ spansOf, knows });
  const sessionElapsed = (sessionID: string, now: number = Date.now()): number | undefined =>
    activeTime(sessionID, now);

  return {
    messagesOf,
    treeTotals,
    contextUsage,
    sessionElapsed,
    statusOf,
    recentParts,
    shellsOf,
    lastActivity,
    permsOf,
    busy,
  };
}