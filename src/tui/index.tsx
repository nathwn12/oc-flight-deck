import { Plugin } from "@opencode/plugin/tui";
import { For, Show, createSignal } from "solid-js";
import { FlightDeckRpc } from "../server/rpc.js";
import { loadFlightDeckConfig } from "../config/discover.js";
import { contextPercent, formatFooter, formatSidebar, formatTasks, sidebarVisible, type UiStatus } from "./presentation.js";

function statusValue(value: unknown, expectedLocation: string): UiStatus | null {
  if (typeof value !== "object" || value === null) return null;
  const status = value as UiStatus;
  return status.location === undefined || status.location === expectedLocation ? status : null;
}

function currentSession(status: UiStatus | null, sessionId: string | undefined) {
  return status?.sessions?.find((session) => sessionId && session.sessionId === sessionId);
}

export default Plugin.define({
  id: "flight-deck-tui",
  async setup(context) {
    const [status, setStatus] = createSignal<UiStatus | null>(null);
    const location = context.location ?? context.data.location.default();
    const loaded = await loadFlightDeckConfig({ cwd: location.directory });
    const visibility = () => ({
      enabled: loaded.config.telemetry.enabled,
      tps: loaded.config.metrics.tps,
      ttft: loaded.config.metrics.ttft,
      cost: loaded.config.metrics.cost,
      context: loaded.config.metrics.context,
      compact: loaded.config.ui.compact,
    });
    const api = context.client.rpc(FlightDeckRpc);
    // Every RPC call must carry the active location explicitly, so refresh and
    // controls can never silently resolve against the server's default location.
    const callOptions = { location: { directory: location.directory, ...(location.workspaceID ? { workspace: location.workspaceID } : {}) } };
    let stopped = false;
    const refresh = async () => {
      try {
        const next = await api.status({}, callOptions);
        if (!stopped) setStatus(statusValue(next, location.directory));
      } catch {
        if (!stopped) setStatus(null);
      }
    };
    const contextFor = (sessionID: string | undefined): number | null => {
      if (!sessionID || !loaded.config.metrics.context) return null;
      const session = context.data.session.get(sessionID);
      const modelRef = session?.model;
      const model = modelRef ? (context.data.location.model.list(location) ?? []).find((candidate) => candidate.providerID === modelRef.providerID && candidate.id === modelRef.id) : undefined;
      return contextPercent(session?.tokens.input, model?.limit.context);
    };
    await refresh();
    const poll = setInterval(() => void refresh(), 2_000);
    const offUpdates = api.events.on("updated", () => void refresh());
    const offEvents = context.data.listen(({ details }) => {
      if (["session.status", "session.idle", "session.usage.updated", "session.execution.succeeded", "session.execution.failed"].includes(details.type)) void refresh();
    });

    const removeSidebar = context.ui.slot({
      append: "sidebar.content",
      render: () => (
        <Show when={sidebarVisible(status(), loaded.config.ui.sidebar)}>
          <box flexDirection="column" paddingLeft={1} paddingRight={1}>
            {formatSidebar(status(), visibility().compact).map((line) => <text fg={context.theme.text.default}>{line}</text>)}
          </box>
        </Show>
      ),
    });
    const removeFooter = context.ui.slot({
      append: "prompt.footer.status",
      render: ({ sessionID, mode }) => (
        <Show when={mode === "normal" && loaded.config.telemetry.enabled && loaded.config.ui.footer !== "hidden" && (loaded.config.ui.footer === "always" || currentSession(status(), sessionID) !== undefined)}>
          <text fg={context.theme.text.muted}>{formatFooter(currentSession(status(), sessionID), visibility(), contextFor(sessionID))}</text>
        </Show>
      ),
    });
    const removePanel = context.ui.slot({
      append: "session.panel",
      render: (panel) => (
        <Show when={panel.name === "flight-deck.board"}>
          <box flexDirection="column" padding={1}>
            <text fg={context.theme.text.default}>Flight Deck board — {status()?.autopilot ? "autopilot ON" : "autopilot off"}</text>
            <For each={formatTasks(status()?.tasks)}>{(line) => <text fg={context.theme.text.muted}>{line}</text>}</For>
            <text fg={context.theme.text.muted}>Press Esc to close. Use the command palette to toggle autopilot.</text>
          </box>
        </Show>
      ),
    });
    context.keymap.layer(() => ({
      mode: "global",
      priority: 20,
      commands: [
        {
          id: "flight-deck.open",
          title: "Open Flight Deck",
          group: "Flight Deck",
          bind: "ctrl+shift+f",
          palette: true,
          slash: { name: "flightdeck" },
          run: () => { context.ui.panel.open("flight-deck.board"); },
        },
        {
          id: "flight-deck.autopilot",
          title: "Toggle Flight Deck autopilot",
          group: "Flight Deck",
          palette: true,
          slash: { name: "flightdeck-autopilot" },
          run: async () => {
            const next = !(status()?.autopilot ?? false);
            await api.setAutopilot({ enabled: next }, callOptions);
            await refresh();
            context.ui.toast.show({ title: "Flight Deck", message: `Autopilot ${next ? "enabled" : "disabled"}`, variant: next ? "warning" : "success" });
          },
        },
        {
          id: "flight-deck.pause",
          title: "Toggle Flight Deck fleet pause",
          group: "Flight Deck",
          palette: true,
          slash: { name: "flightdeck-pause" },
          run: async () => {
            const next = !(status()?.paused ?? false);
            if (next) await api.pause({}, callOptions);
            else await api.resume({}, callOptions);
            await refresh();
            context.ui.toast.show({ title: "Flight Deck", message: next ? "Fleet paused" : "Fleet resumed", variant: next ? "warning" : "success" });
          },
        },
      ],
    }));

    return () => {
      stopped = true;
      clearInterval(poll);
      offUpdates();
      offEvents();
      removeSidebar();
      removeFooter();
      removePanel();
    };
  },
});
