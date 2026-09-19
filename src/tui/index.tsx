/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui";
import { cautionDetail, cautionText, detectCautions, worstCaution, type Caution } from "./caution.js";
import { cautionThresholds, mergeOptions, resolveConfig } from "./config.js";
import { loadConfigFile } from "./file-config.js";
import { footerLine, liveRowOffset, sidebarLines } from "./presentation.js";
import { ANIMATED_FIELDS, sessionThroughput, type StatSource } from "./stats.js";
import { startGuardBridge } from "./guard.js";
import { startTicker } from "./ticker.js";

// Flight Deck is a read-only instrument panel for the OpenCode V2 CLI/TUI. It
// shows the open session's agent, model, branch, cost, tokens, and cache hit
// rate in the sidebar. It uses only the official CLI plugin boundary —
// `@opencode/plugin/tui`, `context.ui.slot`, and theme tokens.
//
// Read-only but for one thing: the animation tick writes a single counter into
// the host's ephemeral plugin-memory store. It has to, because a timer owned by
// this plugin cannot wake the host's renderer — see ./ticker.ts for why. That
// counter is in-process, scoped to this plugin, and gone when the TUI exits.
// Everything the rail displays is state the host already holds in memory.
//
// Appearance comes from, in order of precedence:
//   1. `context.options` — the host's plugin options, when the host forwards them
//   2. the one global config file, `flight-deck.jsonc` in the opencode
//      configuration directory
//   3. the sane defaults in ./config.ts
// See flight-deck.example.jsonc for the commented template.

/** How many trailing messages are inspected for tool parts. */
const RECENT_MESSAGES = 4;

type SessionLike = { cost?: unknown; model?: unknown; time?: unknown; tokens?: unknown };

function asCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function asText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text.length === 0 ? undefined : text;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export default Plugin.define({
  id: "flight-deck-tui",
  setup(context) {
    const file = loadConfigFile();
    const { config, issues } = resolveConfig(mergeOptions(file.options, context.options));

    // Only the rows actually on the rail are worth deriving: the rail re-runs on
    // every tick, and a figure nobody asked to see should not cost a walk of the
    // session database or the model catalog.
    const rows = config.sidebar.enabled ? new Set(config.sidebar.rows) : new Set<string>();
    const wants = (name: string): boolean => rows.has(name);

    if (file.issue !== undefined && file.source !== undefined) {
      console.warn(`[flight-deck] ${file.issue}`);
    }
    const problems = file.issue !== undefined ? [file.issue, ...issues] : issues;
    if (problems.length > 0) {
      const extra = problems.length > 1 ? ` (+${problems.length - 1} more)` : "";
      context.ui.toast.show({
        title: "Flight Deck",
        message: `Ignoring invalid config: ${problems[0]}${extra}`,
        variant: "warning",
      });
    }

    const footer = footerLine(config);
    const releases: Array<() => void> = [];

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

    const cautionThreshold = cautionThresholds(config.caution);

    const cautionsOf = (sessionID: string, now: number): Caution[] =>
      detectCautions({
        parts: recentParts(sessionID),
        shells: shellsOf(sessionID),
        now,
        sessionRunning: statusOf(sessionID) === "running",
        lastMessageAt: lastActivity(sessionID),
        thresholds: cautionThreshold,
      });

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

    // Overall session throughput: every output token the conversation has
    // produced, divided by how long the session has been alive. Subagents run as
    // separate sessions, so their output is summed in — this is the whole
    // session's rate, not the main chat's last turn. Measured from the session's
    // own clock (`time.updated`, falling back to now) so a finished session
    // settles on a stable figure instead of decaying as it sits on screen.
    const sessionTps = (sessionID: string, session: SessionLike | undefined): number | undefined => {
      const time = asRecord(session?.time);
      const created = asCount(time?.["created"]);
      if (created === undefined) return undefined;
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

    // Recent turn sizes, oldest first. Drawn from messages the host already
    // holds, so the sparkline needs no history of our own to accumulate.
    const sparkValues = (sessionID: string): readonly number[] => {
      const sizes: number[] = [];
      for (const entry of messagesOf(sessionID)) {
        const message = asRecord(entry);
        if (message?.type !== "assistant") continue;
        const output = asCount(asRecord(message.tokens)?.output);
        if (output === undefined) continue;
        sizes.push(output);
      }
      // Windowed by the configured width, not a hardcoded one: `sparkWidth` is
      // capped here first, so a wider setting used to be silently impossible.
      return sizes.slice(-config.layout.sparkWidth);
    };

    // A ticker exists only for clock-derived rows; everything else updates from
    // the host's own events. It is skipped entirely when nothing on the rail
    // animates, and `refresh: 0` opts out regardless. The tick has to live in the
    // host's reactive graph rather than ours, or it re-renders nothing at all.
    const animated =
      config.sidebar.enabled &&
      config.sidebar.rows.some((name) => (ANIMATED_FIELDS as readonly string[]).includes(name));
    let spinnerNeeded = false;
    const ticker = startTicker(context, animated ? config.refresh : 0, () => spinnerNeeded);

    // The guard row is opt-in and polls its own RPC: starting the bridge only
    // when the row is on the rail means no timer and no request for a row
    // nobody renders. The bridge resolves `status` from `context.client` on
    // every poll, so installing guard later appears within its interval.
    const wantGuard = config.sidebar.enabled && config.sidebar.rows.includes("guard");
    const bridge = wantGuard ? startGuardBridge(context) : undefined;

    // Read session state inside the render so the rail stays live: cost and
    // tokens climb as the session runs, and the branch appears once VCS
    // resolves. Nothing here writes, requests, or leaves the process.
    // Only the worst is ever drawn: the rail has one line for this, and two
    // simultaneous observations is one problem with two symptoms.
    //
    // Returns a plain string, themed exactly like every other live row. The
    // annunciator carries its meaning in its glyph, not in a colour of its own:
    // a row that suddenly brightens reads as a different kind of thing rather
    // than as the same panel telling you something.
    const announce = (sessionID: string): string | undefined => {
      if (!config.caution.enabled) return undefined;
      const top = worstCaution(cautionsOf(sessionID, Date.now()));
      return top === undefined ? undefined : cautionText(top, config.glyphs);
    };

    // Both of these are host lookups like any other, and the slot render must
    // not throw: an unreachable default location, or a VCS call on a directory
    // with no repository, would take the whole rail down with it. Each degrades
    // to "no branch row", the same way every other missing value does.
    const locationOf = () => {
      try {
        return context.location ?? context.data.location.default();
      } catch {
        return context.location;
      }
    };

    const branchOf = (location: ReturnType<typeof locationOf>): string | undefined => {
      try {
        return context.data.location.vcs.info(location)?.branch?.current;
      } catch {
        return undefined;
      }
    };

    const snapshot = (sessionID: string): StatSource => {
      const location = locationOf();
      const session = context.data.session.get(sessionID) as SessionLike | undefined;
      const isBusy = busy(sessionID);
      // The fast tick exists for the spinner, and the spinner is only drawn while
      // something is moving. Everything else on the rail reads in seconds.
      spinnerNeeded = wants("status") && isBusy === true;

      // A "turn" is one prompt and the work it caused. The host's message list
      // also carries system, shell and switch records, so counting records
      // reports several times the turns actually taken.
      const turns = wants("turns")
        ? messagesOf(sessionID).filter((entry) => asRecord(entry)?.["type"] === "user").length
        : undefined;

      return {
        ...session,
        caution: wants("caution") ? announce(sessionID) : undefined,
        branch: wants("branch") ? branchOf(location) : undefined,
        tree: wants("cost") || wants("total") ? treeTotals(sessionID, session?.cost) : undefined,
        context: wants("context") ? contextUsage(sessionID, session?.model) : undefined,
        project: wants("project") ? projectTotals(sessionID) : undefined,
        status: wants("status") ? statusOf(sessionID) : undefined,
        busy: isBusy,
        perms: wants("perms") ? permsOf(sessionID) : undefined,
        tps: wants("tps") ? sessionTps(sessionID, session) : undefined,
        spark: wants("spark") ? sparkValues(sessionID) : undefined,
        elapsedMs: wants("elapsed") ? sessionElapsed(session) : undefined,
        turns,
        guard: bridge?.status,
        // Read the tick inside the render so the host registers a dependency on
        // it; that read is what makes the rail re-run on the ticker's schedule.
        frame: ticker?.frame ?? 0,
      };
    };

    // The toast is opt-in and deliberately not the signal — the rail is. It
    // fires on the transition into a caution, once per distinct problem, and
    // re-arms when the session goes quiet, so a persistent hang cannot nag.
    // Reading state on a timer rather than inside the render keeps the render a
    // pure function of what it was given.
    let watchedSession: string | undefined;
    let toastedKey: string | undefined;
    let watchTimer: ReturnType<typeof setInterval> | undefined;

    if (config.caution.enabled && config.caution.toast) {
      watchTimer = setInterval(() => {
        const sessionID = watchedSession;
        if (sessionID === undefined) return;
        try {
          const top = worstCaution(cautionsOf(sessionID, Date.now()));
          if (top === undefined || top.severity !== "caution") {
            toastedKey = undefined;
            return;
          }
          if (top.key === toastedKey) return;
          toastedKey = top.key;
          context.ui.toast.show({
            title: "Flight Deck",
            message: cautionDetail(top),
            variant: "warning",
          });
        } catch {
          // A warning must never be able to break the panel it warns about.
        }
      }, config.refresh > 0 ? config.refresh : 1_000);
    }

    if (config.sidebar.enabled) {
      releases.push(
        context.ui.slot({
          append: "sidebar.content",
          render: ({ sessionID }) => {
            // The annunciator is drawn from a timer, so the toast watcher needs
            // to know which session is on screen. Reading the frame is what
            // subscribes this render to the host's tick — without it nothing
            // re-runs between host events, and a stall is precisely the failure
            // that produces no host events at all.
            watchedSession = sessionID;
            // Keep the guard bridge on the rendered session: the follow fetches
            // immediately on change, and the status read below subscribes this
            // render to the bridge's host store, so polls re-run the rail.
            bridge?.follow(sessionID);
            void ticker?.frame;
            void bridge?.status;

            const source = snapshot(sessionID);
            const lines = sidebarLines(config, source);
            if (lines.length === 0) return null;
            const offset = Math.min(liveRowOffset(config), lines.length);

            return (
              // No padding here: the host already lays out and pads the sidebar,
              // so adding our own would push the rows out of alignment with it.
              //
              // Every live row gets the same token, the annunciator included. It
              // is the same panel; only the glyph changes.
              <box flexDirection="column">
                {lines.map((line, index) => (
                  <text fg={index < offset ? context.theme.text.default : context.theme.text.subdued}>{line}</text>
                ))}
              </box>
            );
          },
        }),
      );
    }

    if (footer !== undefined) {
      releases.push(
        context.ui.slot({
          append: "prompt.footer.status",
          render: () => <text fg={context.theme.text.subdued}>{footer}</text>,
        }),
      );
    }

    return () => {
      if (watchTimer !== undefined) clearInterval(watchTimer);
      watchTimer = undefined;
      ticker?.dispose();
      bridge?.dispose();
      for (const release of releases) release();
    };
  },
});
