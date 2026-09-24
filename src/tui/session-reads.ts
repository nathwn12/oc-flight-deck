// Everything the host knows about the session on screen.
//
// One factory closes over the plugin `context` and returns the read-only
// lookups the rail needs: the session's messages, family tree, status,
// activity, shells, permissions, and derived figures (context occupancy,
// elapsed time, subagent totals, busy). Every lookup degrades to "no data"
// instead of throwing — the rail must never break because a read failed.
// Coercion of untrusted values happens through ./coerce.js.

import type { Plugin } from "@opencode/plugin/tui";
import { asCount, asRecord, asText, type SessionLike } from "./coerce.js";

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
  // include them, so a bare `cost` row understates a swarm. Sum the family.
  const treeTotals = (sessionID: string, ownCost: unknown) => {
    if (!isFamilyRoot(sessionID)) return undefined;

    let ids: readonly string[];
    try {
      ids = context.data.session.family(sessionID) ?? [sessionID];
    } catch {
      return undefined;
    }
    if (ids.length <= 1) return undefined;

    let cost = asCount(ownCost) ?? 0;
    let count = 0;
    for (const id of ids) {
      if (id === sessionID) continue;
      const child = context.data.session.get(id) as SessionLike | undefined;
      if (child === undefined) continue;
      count += 1;
      cost += asCount(child.cost) ?? 0;
    }
    return count === 0 ? undefined : { cost, count };
  };

  // A message's own totals are per-request, so the last assistant message's
  // prompt size *is* the current context occupancy — not a running total.
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

  // Measured against the clock rather than the session's last update, so the
  // row keeps moving between events instead of freezing between turns.
  const sessionElapsed = (session: SessionLike | undefined): number | undefined => {
    const created = asCount(asRecord(session?.time)?.created);
    if (created === undefined) return undefined;
    const elapsed = Date.now() - created;
    return elapsed <= 0 ? undefined : elapsed;
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
      const shells = context.data.shell.list(locationOf()) ?? [];
      return shells.filter(
        (entry) => asText(asRecord(asRecord(entry)?.["metadata"])?.["sessionID"]) === sessionID,
      );
    } catch {
      return [];
    }
  };

  // The host's own shell records are listed per location, not per session.
  const locationOf = () => {
    try {
      return context.location ?? context.data.location.default();
    } catch {
      return context.location;
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

  return {
    messagesOf,
    isFamilyRoot,
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