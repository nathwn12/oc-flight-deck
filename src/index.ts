import { Plugin } from "@opencode/plugin";

// OpenCode loads the package root from opencode.jsonc and discovers the
// separate ./tui export for the terminal UI. This server-side compatibility
// entrypoint is deliberately inert: all visible behavior lives in src/tui.
export default Plugin.define({
  id: "flight-deck.host",
  setup() {},
});
