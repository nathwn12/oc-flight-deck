# ✈ Flight Deck

**Live session telemetry for your OpenCode terminal.**

Your agent is spending money right now. Most of the time you find out afterwards.

Flight Deck puts the numbers where you're already looking — a quiet sidebar that
shows which model is running, what it's costing, how full the context is, and
whether your caching is actually working.

```
✈ FLIGHT DECK
─────────────────
status     ⠹ running
agent      orchestrator
model      deepseek-v4.1-flash · high
branch     main
cost       $0.226
total      $0.247 · 2 subagents
project    $1.48 · 12 sessions
tokens     533k in · 91k out
cache      98% hit · 32M read
context    ██░░░░░░░░ 18%
elapsed    2h 14m
tps        106 tok/s
spark      ▁▃▂▅█▄▃▂
```

## Install

```jsonc
// opencode.jsonc
{
  "plugins": ["oc-flight-deck"]
}
```

Restart OpenCode. That's the whole setup — no config file, no options, nothing to
learn. The panel appears beside an open session and starts reading.

## What you're looking at

| Row | Why it's there |
| --- | --- |
| `status` | A spinner while it works, a circle while it's waiting on you. |
| `agent` | Which agent you're actually talking to. |
| `model` | The model *and its variant* — `high` behaves differently. |
| `branch` | Which branch you're about to commit to. |
| `cost` | This session, so far. |
| `total` | **This session plus every subagent it spawned.** |
| `project` | Every session in this repo. |
| `tokens` | Input and output, cumulative. |
| `cache` | Hit rate first, because that's the number that explains the bill. |
| `context` | A gauge of how full the window is. |
| `perms` | Appears only when approvals are waiting on you. |
| `elapsed` | How long you've been at it. |
| `tps` | Output tokens per second, measured from the last completed turn. |
| `spark` | Recent turn sizes as a shape — you can see the expensive one. |

### `total` is the row that matters

Subagents run as **separate sessions**, and a session's own cost does not include
them. On the session this was built against, the parent reported `$0.2246` while
the true spend was `$0.2447` — **9% low on money, and 54% low on input tokens**.
If you swarm, `total` is the number you actually spent.

### `cache` is the row that surprises people

A 98% hit rate is why millions of tokens can cost cents. The moment that number
drops, your bill doesn't.

## Configuration

**You don't need any.** Install it and the panel works. But every knob is
available in a commented JSONC file.

Copy [`flight-deck.example.jsonc`](./flight-deck.example.jsonc) to
`flight-deck.jsonc` at your project root, or to `.opencode/flight-deck.jsonc`,
then edit. Comments and trailing commas are fine.

```jsonc
{
  // Tick rate in ms. The spinner has ten frames, so 100 turns it once a
  // second. 0 turns the timer off entirely.
  "refresh": 100,

  "sidebar": {
    "enabled": true,
    "lines": ["✈ FLIGHT DECK", "─────────────────"],
    // Any rows, any order. Delete whatever you don't want.
    "rows": [
      "status", "agent", "model", "branch", "cost", "total", "project",
      "tokens", "cache", "context", "perms", "elapsed", "tps", "spark"
    ]
  },

  "footer": {
    // Off by default — the sidebar already carries the data.
    "enabled": false,
    "text": "Flight Deck"
  }
}
```

The example file documents every row and every option inline. A typo is never
fatal: the bad value is ignored, the default comes back, and you get a one-time
toast naming the key to fix.

## It reads. It writes one number.

Flight Deck shows what OpenCode already knows.

- **No network calls.** Nothing is fetched, nothing is sent.
- **No telemetry.** Nothing is collected or phoned home.
- **Nothing on disk.** The one thing it writes is an animation counter in the
  host's in-memory plugin state, so the spinner and `elapsed` keep moving
  between turns. It is scoped to this plugin and dies with the TUI; it is never
  persisted, and `"refresh": 0` removes even that.
- **No polling of your session** — cost, tokens, and permissions update from the
  host's own events.
- **Theme-native.** Every line uses your active theme's text tokens, so it blends
  with whatever look you already run.

Delete the plugin and the stock sidebar is back, exactly as it was.

## Uninstall

Remove the entry from `opencode.jsonc`, restart, done. Delete your
`flight-deck.jsonc` too if you made one.

## Development

```sh
bun install
bun run check
```

`bun run check` typechecks and runs the suite, including headless OpenTUI render
tests that mount the panel in a real renderer and assert the exact characters
that come out. A guard test parses the shipped example config and asserts it
still matches the real defaults, so the documentation can't drift from the code.

To load the plugin **from this checkout** while working on it, add it to the
config of the directory you run OpenCode in:

```jsonc
{
  "plugins": ["."]
}
```

That file is deliberately **not** committed. If the plugin is also installed
globally, declaring it in both places registers the same plugin id twice and the
host's plugin list shows one of them as failed.

Built on the official
[OpenCode V2 CLI plugin API](https://opencode.ai/v2/docs/build/plugins/cli).

## Compatibility

The OpenCode plugin API is still in beta. This release targets
`@opencode/plugin` beta `0.0.0-beta-19425`; pin a host version you've tested.

Requires OpenCode V2 (`opencode2`). Building from source needs Bun 1.4+ or
Node 22+.

## License

MIT © 2026 nathwn12 — free to use, modify, and share.
