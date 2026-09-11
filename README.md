# ✈ Flight Deck

**A read-only instrument panel for the OpenCode V2 terminal.**

Flight Deck shows the open session's live numbers in your sidebar — agent, model,
branch, cost, tokens, cache hit rate, context occupancy — so you can see what your
session is actually doing and what it's costing before the bill tells you.

No commands to learn. No telemetry, no network calls, nothing written. It only
reads state OpenCode already holds, and deleting it leaves the stock UI behind.

## What you get

```
✈ FLIGHT DECK
─────────────────
agent      orchestrator
model      deepseek-v4.1-flash · high
branch     main
cost       $0.225
total      $0.245 · 2 subagents
tokens     533k in · 91k out
cache      98% hit · 32M read
context    218k / 1M · 22%
```

Rows appear as the data does — nothing is shown until it's real, so a fresh
session starts with the header alone and fills in as you work.

- **Whole-session totals.** Cost and tokens are cumulative for the session.
- **`total` includes subagents.** Subagent sessions are separate sessions, so the
  parent's own cost understates a swarm. `total` sums the tree.
- **`cache` is the value signal.** A 98% hit rate is what makes millions of
  tokens cost cents; it's also the first thing to break.
- **`context` is real occupancy.** Taken from the last request's prompt size, not
  a running total, so you can see the window filling up.
- **Theme-native.** Every line uses your active theme's text tokens, so it blends
  with whatever look you already run.

## Requirements

- OpenCode V2 (`opencode2`)
- Only if you build from source: Bun 1.4+ or Node 22+

## Install

From a published package, add it to `opencode.jsonc`:

```jsonc
{
  "plugins": ["oc-flight-deck"]
}
```

From a local checkout, OpenCode discovers plugins under its config directory.
Create two one-line bridges so the plugin code stays in your checkout:

```
~/.config/opencode/plugins/flight-deck/index.ts
~/.config/opencode/plugins/flight-deck/tui.ts
```

```ts
// index.ts — the registerable entrypoint
export { default } from "file:///path/to/oc-flight-deck/src/index.ts";
```

```ts
// tui.ts — the terminal UI entrypoint
export { default } from "file:///path/to/oc-flight-deck/src/tui/index.tsx";
```

Restart OpenCode. The panel appears beside an open session — the sidebar only
exists inside a session, so the home screen stays untouched.

## Configuration

**Nothing is required.** Install it and the panel works. The file below exists
only to change the defaults.

Copy `flight-deck.example.jsonc` to one of these; Flight Deck uses the first it
finds, in order:

```
.opencode/flight-deck.jsonc
.opencode/flight-deck.json
flight-deck.jsonc
flight-deck.json
```

```jsonc
{
  "refresh": 1000,
  "sidebar": {
    // false hides the panel entirely.
    "enabled": true,
    // Fixed lines above the live rows. Your own words, or a rule.
    "lines": ["✈ FLIGHT DECK", "─────────────────"],
    // The live rows, top to bottom. Delete any you don't want.
    "rows": [
      "status", "agent", "model", "branch", "cost", "total", "project",
      "tokens", "cache", "context", "perms", "elapsed", "tps", "spark"
    ]
  },
  "footer": {
    // Off by default: the sidebar already carries the data, and the prompt
    // footer is high-traffic space. Turn it on for a short custom label.
    "enabled": false,
    "text": "Flight Deck"
  }
}
```

### Rows

Every row is read from the open session. You never type these values in.

| Row | Shows | Notes |
| --- | --- | --- |
| `status` | `running` or `idle` | The glyph animates while it works. |
| `agent` | Which agent is running | `orchestrator`, `build`, `plan`, … |
| `model` | Model id and variant | Variant matters: `high` behaves differently. |
| `branch` | Current git branch | From the location's VCS info. |
| `cost` | What this session has cost | Cumulative across every turn. |
| `total` | This session **plus its subagents** | Hidden until a subagent has run. |
| `project` | Every session in this repo | Not just the one on screen. |
| `tokens` | Input and output tokens | Cumulative for the session. |
| `cache` | Cache hit rate, then cache reads | Falls back to reads if the rate is underivable. |
| `context` | A gauge of the context window | From the last request's prompt size, not a running total. |
| `perms` | Approval requests waiting | Only shown when there are some. |
| `elapsed` | Time since the session started | Needs `refresh` above `0` to tick. |
| `tps` | Output tokens/second | Measured from the last completed turn's timing. |
| `spark` | Recent turn sizes as a sparkline | Scaled to the largest turn in the window. |
| `reasoning` | Reasoning tokens | Hidden when the model emits none. |
| `turns` | Number of messages | |

### Options

| Option | Type | Default | Notes |
| --- | --- | --- | --- |
| `refresh` | number | `1000` | Milliseconds between ticks. `0` disables the timer entirely. Only clock-derived rows need it. |
| `sidebar.enabled` | boolean | `true` | Set `false` to hide the panel. |
| `sidebar.lines` | string[] | `["✈ FLIGHT DECK", "─────────────────"]` | Fixed text above the rows. The first line uses your theme's primary text color, the rest the subdued color. |
| `sidebar.rows` | string[] | all fourteen above | Any row from the table, in any order. |
| `footer.enabled` | boolean | `false` | The prompt footer is off unless you configure it. |
| `footer.text` | string | `"Flight Deck"` | Any single line. |

A few things worth knowing:

- **Writing a footer setting turns the footer on.** Set `footer.enabled: false`
  explicitly to keep it hidden.
- **Mistakes are harmless.** A bad value is ignored rather than fatal: Flight Deck
  falls back to the default and shows a one-time warning toast naming the key —
  including an unrecognised row name.
- **Layout is guarded.** The panel is capped at 24 lines of 120 characters, so a
  stray edit can't wreck your terminal.
- **Forward compatible.** Unknown keys are ignored, so a config written for a
  newer version still loads cleanly.
- **Host options also work.** The same values can be passed as plugin options in
  `opencode.jsonc` / `cli.json`, and they take precedence over the file on hosts
  that forward them.

## Uninstall

Remove the plugin entry (or the bridge folder), delete your Flight Deck config
file, restart OpenCode, and the stock sidebar is back.

## Development

```sh
bun install
bun run check
```

`bun run check` runs the type checker and the test suite, including headless
render tests that mount the panel in a real OpenTUI renderer and assert the exact
characters that come out.

Built on the official
[OpenCode V2 CLI plugin API](https://opencode.ai/v2/docs/build/plugins/cli).

## Compatibility

The OpenCode plugin API is still in beta. This release targets
`@opencode/plugin` beta `0.0.0-beta-19425`; pin a host version you've tested.

## License

MIT © 2026 nathwn12 — free to use, modify, and share.
