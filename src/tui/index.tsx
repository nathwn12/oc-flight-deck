/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui";
import { cautionDetail, cautionText, detectCautions, worstCaution, type Caution } from "./caution.js";
import { cautionThresholds, mergeOptions, resolveConfig } from "./config.js";
import { loadConfigFile } from "./file-config.js";
import { footerLine, railLineSpans, railLines, railLineStyle } from "./presentation.js";
import { ANIMATED_FIELDS, type StatSource } from "./stats.js";
import { attributeMask, themeColor } from "./style.js";
import { startGuardBridge } from "./guard.js";
import { startGoBridge } from "./go.js";
import { startTicker } from "./ticker.js";
import { asCount, asRecord, type SessionLike } from "./coerce.js";
import { createProjectTotals } from "./project-totals.js";
import { createSessionReads, locationOf } from "./session-reads.js";
import { createTpsReader } from "./session-tps.js";

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

    // Bound a bankable window to a few ticks: `min(60s, max(5s, 4 * refreshMs))`,
    // so a suspended process or a sparse-event gap cannot be billed as work.
    const maxBankedMs = Math.min(60_000, Math.max(5_000, 4 * config.refresh));
    const reads = createSessionReads(context, maxBankedMs);
    const {
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
    } = reads;

    const { projectTotals } = createProjectTotals(context);

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

    const { sessionTps } = createTpsReader(context, isFamilyRoot);

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
      config.sidebar.rows.some((name) => ANIMATED_FIELDS.some((field) => field === name));
    let spinnerNeeded = false;
    const ticker = startTicker(context, animated ? config.refresh : 0, () => spinnerNeeded);

    // The guard row is opt-in and polls its own RPC: starting the bridge only
    // when the row is on the rail means no timer and no request for a row
    // nobody renders. The bridge resolves `status` from `context.client` on
    // every poll, so installing guard later appears within its interval.
    const wantGuard = config.sidebar.enabled && config.sidebar.rows.includes("guard");
    const bridge = wantGuard ? startGuardBridge(context) : undefined;

    // The go row is opt-in the same way: a row nobody drew should cost no timer
    // and no request. The bridge is account-wide (one key, one quota), so it
    // starts here and has no session to follow — unlike guard.
    const wantGo = config.sidebar.enabled && config.sidebar.rows.includes("go");
    const goBridge = wantGo ? startGoBridge(context) : undefined;

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

    // A VCS call on a directory with no repository must not throw and take the
    // whole rail down with it, so it degrades to "no branch row", the same way
    // every other missing value does. `locationOf` (from ./session-reads.js) is
    // shared so both sides resolve the host location the same way.
    const branchOf = (location: ReturnType<typeof locationOf>): string | undefined => {
      try {
        return context.data.location.vcs.info(location)?.branch?.current;
      } catch {
        return undefined;
      }
    };

    const snapshot = (sessionID: string): StatSource => {
      const location = locationOf(context);
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
        elapsedMs: wants("elapsed") ? sessionElapsed(sessionID) : undefined,
        turns,
        guard: bridge?.status,
        // Read the go store inside the render too, so a poll re-runs the rail
        // exactly as the guard read does.
        go: goBridge?.usage,
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
            void goBridge?.usage;

            const source = snapshot(sessionID);
            const lines = railLines(config, source);
            if (lines.length === 0) return null;

            return (
              // No padding here: the host already lays out and pads the sidebar,
              // so adding our own would push the rows out of alignment with it.
              //
              // Each line resolves its own look from `config.style`: the fixed
              // lines use `style.lines`, and every live row its own entry or the
              // wildcard. `themeColor`/`attributeMask` are the only things that
              // know how a role or an attribute name becomes renderer state, and
              // they hand back plain props here — never escapes.
              //
              // `?? 0` keeps a line with no attributes on the renderer's own
              // default instead of assigning `undefined` over it, so the shipped
              // config draws exactly what it always drew.
              <box flexDirection="column">
                {lines.map((line) => {
                  const style = railLineStyle(config.style, line);
                  const lineFg = themeColor(style.color, context.theme) as string | undefined;
                  // The span mapping — which run inherits the row's colour and
                  // which takes its own tone — lives in a pure helper, so the
                  // "only the flagged window is red" decision is tested directly.
                  // All this renderer does is resolve each role to a theme colour
                  // and pass `fg`, never ANSI or escapes.
                  return (
                    <text fg={lineFg} attributes={attributeMask(style.attributes) ?? 0}>
                      {railLineSpans(line, style).map((span) => (
                        <span style={{ fg: themeColor(span.color, context.theme) as string | undefined }}>
                          {span.text}
                        </span>
                      ))}
                    </text>
                  );
                })}
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
      goBridge?.dispose();
      for (const release of releases) release();
    };
  },
});
