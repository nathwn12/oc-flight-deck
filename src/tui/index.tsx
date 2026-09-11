/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui";
import { mergeOptions, resolveConfig } from "./config.js";
import { loadConfigFile } from "./file-config.js";
import { footerLine, sidebarLines } from "./presentation.js";

// Flight Deck as a purely cosmetic OpenCode V2 CLI/TUI plugin: two static
// branded rails and nothing else. It uses only the official CLI plugin
// boundary — `@opencode/plugin/tui`, `context.ui.slot`, and theme tokens.
//
// Appearance comes from, in order of precedence:
//   1. `context.options` — the host's plugin options, when the host forwards them
//   2. `flight-deck.jsonc` (or `.opencode/flight-deck.jsonc`) in the project
//   3. the sane defaults in ./config.ts
// See flight-deck.example.jsonc for the commented template.
//
// There is no RPC, server behavior, storage, events, tools, hooks, keymap,
// telemetry, or coordination here.
// Reference: https://opencode.ai/v2/docs/build/plugins/cli
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

    const lines = sidebarLines(config);
    const footer = footerLine(config);
    const releases: Array<() => void> = [];

    if (lines.length > 0) {
      releases.push(
        context.ui.slot({
          append: "sidebar.content",
          render: () => (
            <box flexDirection="column" paddingLeft={1} paddingRight={1}>
              {lines.map((line, index) => (
                <text fg={index === 0 ? context.theme.text.default : context.theme.text.subdued}>{line}</text>
              ))}
            </box>
          ),
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
      for (const release of releases) release();
    };
  },
});
