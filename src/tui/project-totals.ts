// Project spend: every session in THIS project, not just the one on screen.
//
// `session.list()` is not scoped - it returns sessions across every
// directory the host knows about, so summing it gives "everything you have
// ever run" while claiming to be a project total. Filtered by `projectID`
// rather than by directory, because one project legitimately spans several
// directories (worktrees).
//
// If the host does not report a project id, the unfiltered list is used, so
// this degrades to the old behaviour instead of showing nothing.
// `project` walks every session the host knows about, and that collection grows
// with your history rather than staying a handful. It moves slowly, so the walk
// is held briefly instead of repeated on every tick.

import type { Plugin } from "@opencode/plugin/tui";
import { asCount, asRecord, asText } from "./coerce.js";

export function createProjectTotals(context: Plugin.Context) {
  const PROJECT_CACHE_MS = 5_000;
  let projectCache:
    | { readonly projectID: string | undefined; readonly at: number; readonly value: { cost: number; count: number } }
    | undefined;

  const projectTotals = (sessionID: string) => {
    try {
      const projectID = asText(asRecord(context.data.session.get(sessionID))?.["projectID"]);
      const cached = projectCache;
      if (cached !== undefined && cached.projectID === projectID && Date.now() - cached.at < PROJECT_CACHE_MS) {
        return cached.value;
      }

      const sessions = context.data.session.list() ?? [];
      const scoped =
        projectID === undefined
          ? sessions
          : sessions.filter((entry) => asText(asRecord(entry)?.["projectID"]) === projectID);

      let cost = 0;
      for (const entry of scoped) cost += asCount(asRecord(entry)?.["cost"]) ?? 0;
      const value = { cost, count: scoped.length };
      projectCache = { projectID, at: Date.now(), value };
      return value;
    } catch {
      return undefined;
    }
  };

  return { projectTotals };
}