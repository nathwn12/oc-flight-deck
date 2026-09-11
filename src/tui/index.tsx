/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui";
import { createSignal } from "solid-js";
import { mergeOptions, resolveConfig } from "./config.js";
import { loadConfigFile } from "./file-config.js";
import { footerLine, liveRowOffset, sidebarLines } from "./presentation.js";
import type { StatSource } from "./stats.js";

// Flight Deck is a read-only instrument panel for the OpenCode V2 CLI/TUI. It
// shows the open session's agent, model, branch, cost, tokens, and cache hit
// rate in the sidebar. It uses only the official CLI plugin boundary —
// `@opencode/plugin/tui`, `context.ui.slot`, and theme tokens.
//
// Read-only by construction: it never writes, requests, stores, subscribes, or
// polls. Everything it shows is state the host already holds in memory.
//
// Appearance comes from, in order of precedence:
//   1. `context.options` — the host's plugin options, when the host forwards them
//   2. `flight-deck.jsonc` (or `.opencode/flight-deck.jsonc`) in the project
//   3. the sane defaults in ./config.ts
// See flight-deck.example.jsonc for the commented template.

type SessionLike = { cost?: unknown; model?: unknown; time?: unknown };

function asCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export default Plugin.define({
  id: "flight-deck-tui",
  setup(context) {
    const directory = context.location?.directory ?? process.cwd();
    const file = loadConfigFile(directory);
    const { config, issues } = resolveConfig(mergeOptions(file.options, context.options));

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

    // Subagent sessions are separate sessions, and the parent's `cost` does not
    // include them, so a bare `cost` row understates a swarm. Sum the family.
    const treeTotals = (sessionID: string, ownCost: unknown) => {
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

    // The catalog field name for the window size is not guaranteed across
    // versions, so accept the likely spellings and otherwise show no limit.
    const contextLimit = (model: unknown): number | undefined => {
      const id = asRecord(model)?.id;
      if (typeof id !== "string") return undefined;
      try {
        const location = context.location ?? context.data.location.default();
        for (const entry of context.data.location.model.list(location) ?? []) {
          const record = asRecord(entry);
          if (record === undefined || record.id !== id) continue;
          return asCount(record.context) ?? asCount(record.limit) ?? asCount(record.contextWindow);
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

    // Project spend: every session the host knows about here, not just the one
    // on screen. Answers "what has this repo cost me", not "this conversation".
    const projectTotals = () => {
      try {
        const sessions = context.data.session.list() ?? [];
        let cost = 0;
        for (const entry of sessions) cost += asCount(asRecord(entry)?.cost) ?? 0;
        return { cost, count: sessions.length };
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

    const permsOf = (sessionID: string): number | undefined => {
      try {
        return context.data.session.permission.list(sessionID)?.length;
      } catch {
        return undefined;
      }
    };

    // Throughput of the last completed turn. The host records when streaming
    // finished, so this is measured rather than estimated from wall-clock.
    const lastTps = (sessionID: string): number | undefined => {
      const messages = messagesOf(sessionID);
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = asRecord(messages[index]);
        const tokens = asRecord(message?.tokens);
        const output = asCount(tokens?.output);
        const time = asRecord(message?.time);
        const created = asCount(time?.created);
        const streamed = asCount(time?.streamed);
        if (output === undefined || created === undefined || streamed === undefined) continue;
        const duration = streamed - created;
        if (duration <= 0) continue;
        return output / (duration / 1_000);
      }
      return undefined;
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
      return sizes.slice(-12);
    };

    // A ticker exists only for clock-derived rows; everything else updates from
    // the host's own events. `refresh: 0` opts out of it entirely.
    const [frame, setFrame] = createSignal(0);
    const timer =
      config.refresh > 0 ? setInterval(() => setFrame((value) => value + 1), config.refresh) : undefined;

    // Read session state inside the render so the rail stays live: cost and
    // tokens climb as the session runs, and the branch appears once VCS
    // resolves. Nothing here writes, requests, or leaves the process.
    const snapshot = (sessionID: string): StatSource => {
      const location = context.location ?? context.data.location.default();
      const session = context.data.session.get(sessionID) as SessionLike | undefined;
      const turns = messagesOf(sessionID).length;

      return {
        ...session,
        branch: context.data.location.vcs.info(location)?.branch?.current,
        tree: treeTotals(sessionID, session?.cost),
        context: contextUsage(sessionID, session?.model),
        project: projectTotals(),
        status: statusOf(sessionID),
        perms: permsOf(sessionID),
        tps: lastTps(sessionID),
        spark: sparkValues(sessionID),
        elapsedMs: sessionElapsed(session),
        turns,
        // Read the tick so the slot re-runs each frame.
        frame: frame(),
      };
    };

    if (config.sidebar.enabled) {
      releases.push(
        context.ui.slot({
          append: "sidebar.content",
          render: ({ sessionID }) => {
            const lines = sidebarLines(config, snapshot(sessionID));
            if (lines.length === 0) return null;
            const offset = Math.min(liveRowOffset(config), lines.length);
            return (
              // No padding here: the host already lays out and pads the sidebar,
              // so adding our own would push the rows out of alignment with it.
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
      if (timer !== undefined) clearInterval(timer);
      for (const release of releases) release();
    };
  },
});
