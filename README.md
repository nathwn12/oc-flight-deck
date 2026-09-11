# ✈ Flight Deck

**A tiny cosmetic plugin for the OpenCode V2 terminal.**

It puts a branded rail in your session sidebar and a one-line signature under
your prompt, so your terminal feels a little more like a cockpit. That's the
whole feature.

No commands to learn. No data collected. No config required. Install it, enjoy
it, and delete it whenever you like — the stock UI comes straight back.

## What you get

```
✈ FLIGHT DECK
─────────────
visual rail
cosmetic build
```

…and under the prompt:

```
Flight Deck · cosmetic rail
```

- **Sidebar rail** — shown beside an open session.
- **Prompt footer** — one quiet line under the composer.
- **Theme-native** — colors come from your active OpenCode theme, so it blends
  with whatever look you're already running.
- **Static and small** — fixed text only. Nothing is read, tracked, or sent.

## Requirements

- OpenCode V2 (`opencode2`)
- Only if you build from source: Bun 1.4+ or Node 22+

## Install

Clone the repo somewhere handy, then point OpenCode at the folder. In
`opencode.jsonc` (or `cli.json` for CLI-only use):

```jsonc
{
  "plugins": ["./plugins/oc-flight-deck"]
}
```

Restart OpenCode and you're done. Flight Deck shows up with its default look —
no configuration required.

## Configuration

Flight Deck reads a small JSONC file, so you can leave comments next to the
values you change. To customize it, copy `flight-deck.example.jsonc` to one of:

- `flight-deck.jsonc` at your project root, or
- `.opencode/flight-deck.jsonc`

Flight Deck uses the first one it finds, in this order:

```
.opencode/flight-deck.jsonc
.opencode/flight-deck.json
flight-deck.jsonc
flight-deck.json
```

Every key is optional. Delete anything you don't want to change and the default
comes back — the values below *are* the defaults:

```jsonc
{
  "sidebar": {
    // false hides the sidebar rail entirely.
    "enabled": true,
    // Top to bottom beside an open session. The first line uses your theme's
    // primary text color; the rest use the subdued color.
    "lines": [
      "✈ FLIGHT DECK",
      "─────────────",
      "visual rail",
      "cosmetic build"
    ]
  },
  "footer": {
    // false hides the prompt-footer line entirely.
    "enabled": true,
    // Any single line. Empty text is ignored.
    "text": "Flight Deck · cosmetic rail"
  }
}
```

| Option | Type | Default | Notes |
| --- | --- | --- | --- |
| `sidebar.enabled` | boolean | `true` | Set `false` to hide the sidebar rail. |
| `sidebar.lines` | string[] | see above | Lines top to bottom. The first uses your theme's primary text color, the rest the subdued color. |
| `footer.enabled` | boolean | `true` | Set `false` to hide the prompt-footer line. |
| `footer.text` | string | `Flight Deck · cosmetic rail` | Any single line. |

A few things worth knowing:

- **Mistakes are harmless.** A bad value is ignored rather than fatal: Flight
  Deck falls back to the default and shows a one-time warning toast naming the
  key to fix.
- **Layout is guarded.** `sidebar.lines` is capped at 24 lines of 120 characters
  each, so a stray edit can't wreck your terminal.
- **Forward compatible.** Unknown keys are ignored, so a config written for a
  newer version still loads cleanly.
- **Host options also work.** The same values can be passed as plugin options in
  `opencode.jsonc` / `cli.json`, and they take precedence over the file on hosts
  that forward them.

## Uninstall

Remove the plugin entry (or the folder), delete your Flight Deck config file,
restart OpenCode, and the stock sidebar and footer are back.

## Development

```sh
bun install
bun run check
```

`bun run check` runs the type checker and the test suite, including a headless
render test that mounts both rails in a real OpenTUI renderer and asserts the
characters that come out.

Built on the official
[OpenCode V2 CLI plugin API](https://opencode.ai/v2/docs/build/plugins/cli).

## Compatibility

The OpenCode plugin API is still in beta. This release targets
`@opencode/plugin` beta `0.0.0-beta-19425`; pin a host version you've tested.

## License

MIT © 2026 nathwn12 — free to use, modify, and share.
