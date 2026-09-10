# OC Flight Deck

Flight Deck is an OpenCode V2 plugin with three layers:

1. **Telemetry** — persistent TPS, TTFT, cost, context, and session health.
2. **Coordination** — task board, leases, artifact ownership, heartbeats, and
   agent-facing tools.
3. **Guarded autopilot** — opt-in lane recommendations, shared backoff, and
   stale-task recovery.

The CLI companion keeps a compact rail visible in the sidebar and prompt
footer. The server plugin is the control plane; the TUI is only the cockpit.

## Configuration

Flight Deck uses `ocfd.jsonc` instead of duplicating options in OpenCode's
server and CLI configuration:

```text
project ocfd.jsonc -> global ~/.config/opencode/ocfd.jsonc -> defaults
```

Copy `ocfd.example.jsonc` to a project or to
`~/.config/opencode/ocfd.jsonc`. The UI can patch supported settings through
the same file. `telemetry.enabled` is the master switch; individual metric
switches live under `metrics`. Autopilot defaults to `false`.

## Package entrypoints

| Entry | Purpose |
| --- | --- |
| `oc-flight-deck` | OpenCode server plugin |
| `oc-flight-deck/rpc` | Shared RPC contract |
| `oc-flight-deck/tui` | OpenCode CLI/TUI plugin |

For an installed or locally linked package, add the package name to the
OpenCode V2 server plugin list and to `~/.config/opencode/cli.json`:

```json
{ "plugins": ["oc-flight-deck"] }
```

For this private checkout, add the server entrypoint explicitly to the local
V2 server config (the repository's `opencode.jsonc` uses this form):

```json
{ "plugins": ["Q:\\PROJECTS\\PERSONAL\\oc-flight-deck\\src\\server"] }
```

For the CLI config, use an absolute Windows path to the checkout's `src`
directory. The host resolves the TUI entrypoint as `<path>\tui` inside that
directory, so `src` resolves to `src\tui\index.tsx`. Pointing at the repo root
or at `src\tui` itself will not resolve:

```json
{
  "plugins": [
    "Q:\\PROJECTS\\PERSONAL\\oc-flight-deck\\src"
  ]
}
```

Replace the example with the `src` directory of the checkout on your machine.
If the package is installed from a registry or linked locally, the package
name `oc-flight-deck` can be used instead. The exact server config location is
intentionally left to the host's current V2 configuration; no live user
configuration is modified by this repository.

## Development

```sh
bun install
bun run typecheck
bun test
bun run check
```

The package is pinned to `@opencode/plugin` beta `0.0.0-beta-19425`. The
installed host CLI may be a different beta; verify the host before enabling the
plugin globally.

## Safety boundary

- Telemetry is read-only.
- Coordination starts in one location and uses a serialized claim queue.
- Autopilot is disabled by default and every automatic action is visible in
  the board/RPC status.
- Flight Deck never auto-merges, force-removes worktrees, or prints secrets.
- Events are notifications; persisted state is authoritative.

## Official references

- https://opencode.ai/v2/docs/build/plugins
- https://opencode.ai/v2/docs/build/plugins/rpc
- https://opencode.ai/v2/docs/build/plugins/cli
