# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.19.0] - 2026-10-11

### Added

- `session` is accepted as an alias for the `ses` row in `sidebar.rows` and `style.rows`, normalized to `ses`. The row's rail label is now `session`: an 18-cell clipped preview of the id (never the full id), with the click still copying the full id to the terminal clipboard. The preview budget shrinks by however much the `session` label overflows `layout.labelWidth`, floored at 8 cells, so the row's total width is unchanged by the rename at every `layout.labelWidth` (at the default width 10 the budget is the full 18; at 6 it is 17).
- Zero skeletons for data-less rows under `sidebar.persist`: a row with no data draws a real-looking zero instead of the `—` placeholder — `$0.000` for `cost`/`total`/`project`, `0 in · 0 out` for `tokens`, `0 read` for `cache`, an empty bar plus `~0%` for `context`, `0 waiting` for `perms`, `0s` for `elapsed`, `0 tok/s` for `tps`, a flat `▁` bar for `spark`, `0` for `reasoning`, `0` for `turns`, `○ 0 ○ 0 ○ 0` for `go`, `○ idle` for `status`, `none` for `agent`/`model`/`ses`, `no branch` for `branch`, `unknown` for `guard`. `caution` is the one row that never draws a skeleton: the annunciator stays silent until there is something to announce. `sidebar.placeholder` is now only the fallback for a field with no skeleton, so the dash is unreachable in practice.

### Changed

- `tokens`, `cache` and `reasoning` read the same family scope as `cost`: this conversation plus its subagent sessions when any exist, the session alone when there are none.
- `elapsed` is recomputed from the assistant-turn spans the host itself recorded for this session and its subagents, a turn still in flight ending at "now". A restart comes back with the same value instead of resetting, it cannot step backwards while the host still reports those turns, it freezes the instant everything settles, and it is NOT wall-clock since the session began.
- `tps` is directly per-session — subagents excluded: the displayed session's own generation tokens (output + reasoning) over its own generating time. It shows `0 tok/s` whenever the session is not generating (idle, between turns, or before the first sample), and it never seeds itself from a lifetime average.
- The `cost` row documents its limit plainly: the rollup follows the host's `parentID` link only (`family()`), so a session spawned as an independent top-level session — a `commander` spawning captains — carries no `parentID`, and the host returned no `metadata` field for the sessions probed during this work, so there is no automatic creator link today. A creator-supplied attribution link is a possible future extension, not a shipped feature. The `project` row is the surface that covers every session in the project, spawned sessions included.

### Fixed

- The `tps` row no longer claims subagents are included: the figure never covered them, and the docs said it did.

## [0.17.0] - 2026-10-10

### Added

- `sidebar.footer.go` accepts `align` (`left`, `right`, `center`, default `right`): where each trailing value sits inside its own fixed-width percent (4) and reset (6) cell. `right` pins the value to the cell's right edge, so the digits stay put as values change length; `left` hugs the bar with the padding trailing; `center` splits the padding. Both trailing cells use the same setting, and the cell widths never move.

### Removed

- The `OPENCODE_GO_API_KEY` environment fallback is gone: the `go` row and the footer Go panel resolve the Zen Go key only from OpenCode's own credential sources (the credential store, then the provider catalog's resolved `settings.apiKey`). With no usable entry the bridge stores null and reports the `no-key` reason without making a request.

## [0.15.0] - 2026-10-11

### Changed

- The footer Go panel draws three strict fixed-width columns - label (6, `ROLL`/`WEEK`/`MONTH`), meter (14), right-aligned percent (4) and right-aligned reset (6) with one space between columns - so the percent and the countdown share one axis and the bar starts and ends on the same columns on every row. The longest line stays within the sidebar width and never wraps.
- The `◈ OPENCODE GO` header no longer draws by default; the panel is three lines unless `header: true` opts it back in.
- `sidebar.footer.go` accepts `true`/`false` or a look object (`header`, `barWidth`, `labelWidth`, `percent`, `reset`, `sweep`, each falling back to its default). `true` keeps the default look (no header, 14-cell bar, 6-wide labels, both columns, static meter). The meter is static by default and changes only when the percentage itself changes; `sweep: true` opts the travelling highlight back in.

## [0.14.0] - 2026-10-11

### Changed

- The `go` row and the footer Go panel now resolve the Zen Go key from OpenCode's own credential store. The pinned `@opencode/plugin` client declares `credential.list()`, so the bridge calls it directly on every poll and uses the `key`-type entry for the `opencode-go` integration, preferring the `active` one. `OPENCODE_GO_API_KEY` becomes an optional fallback, read only when the store holds no usable entry. A host whose client predates `credential.list`, a rejected call, or a malformed payload degrades to the env var and then to the row's "no key" dash without making a request. The key is never logged and never leaves the Authorization header.

## [0.13.0] - 2026-10-11

### Added

- A live Go usage panel in the sidebar footer slot, enabled with `sidebar.footer.go`. It draws three lines - `Rolling` (`5h`), `Weekly` (`1w`), `Monthly` (`1m`) - each with a ten-cell bar, a whole-number percent and a reset countdown, using the `context` row's bar glyphs and the `go` row's error tone (90% or more, or a non-`ok` window status). It is off by default, claims the footer slot even when `sidebar.footer.lines` is empty, and shares the `go` row's single account-wide poll of `OPENCODE_GO_API_KEY` rather than starting a second one. With no data yet it draws three dim resting lines, never a blank slot.

## [0.12.0] - 2026-10-09

### Changed

- The `tps` numerator now counts generation tokens - output plus reasoning - over the same streaming-span union, so a thinking-heavy turn reads as speed instead of idle time with no output yet. Tool settlement is still excluded, the denominator still ends at `streamed`, and the `reasoning` row itself is unchanged.

## [0.11.0] - 2026-10-08

### Changed

- TPS now reports a delta-based instantaneous rate instead of the session-lifetime average. The display is an integer, smoothed with an EWMA, with hysteresis so the last digit does not flicker, a minimum token sample before the rate is trusted, and an idle freeze that holds the last value when no new tokens arrive.
- The `context` row now reads as an estimate (`~`), reflecting that the underlying usage figure is approximate.
- The cache hit-rate denominator is now documented as deliberate in code and docs.

### Fixed

- `treeTotals` now wraps each per-id lookup in its own `try/catch`, so one bad id no longer blanks the cost/total rollup.
- Width-aware clipping keeps rows inside the rail instead of overflowing it.
- Per-session maps are now LRU-capped, closing a slow leak across long sessions.
- The `ses` row documents that the display is a pruned preview while click-to-copy still copies the full id.

## [0.10.4] - 2026-10-06

### Fixed

- The default `caution.exemptTools` list now carries the `tools.`-prefixed aliases (`tools.delegate`, `tools.delegate_many`, `tools.subagent`, `tools.task`) alongside the bare names it already exempted. Matching is by exact name, and the host reaches these delegated-work tools under both spellings, so a fresh install lit the row on ordinary delegation the bare names were meant to cover. The schema default and `flight-deck.example.jsonc` carry the same eleven names.
- The `caution` rail row draws a single-cell severity mark (`●` caution, `▲` watch) instead of `:warning:`. The bundled `string-width` tests emoji-regex before East-Asian width and charges `⚠` two cells — and Windows Terminal draws it that way — so the annunciator ran a column wider than every other row. Severity now rides a coloured run on the mark itself (`error` for a caution, `warning` for a watch) while the words keep the row's colour, and a test measures the drawn row in cells at the rail's real width.

## [0.10.3] - 2026-10-02

### Changed

- The `ses` row no longer bleeds past the rail. It again draws a short-pruned preview of the session id - width-aware, with an ellipsis, so it reads as a preview of a longer value - instead of the full 30-character id wrapping out of bounds. The click still copies the **full** id; only the display is pruned.
- A successful copy is now silent. The success toast is gone, since the copied value is already on the clipboard when the gesture works. A copy that could **not** be confirmed still shows its failure toast - a silent no-op must never masquerade as a success.

## [0.10.2] - 2026-10-02

### Fixed

- The `ses` row's click-to-copy now actually copies. It previously treated the renderer's OSC52 `attempted` status as success and reported "Sent the full session id ... to the clipboard" - but `attempted` only proves a local dispatch was issued, and the terminal may never act on it (verified: the bytes are emitted and the clipboard is left unchanged). The copy now prefers the host clipboard backend and reports success only when that write is confirmed (`written`); the OSC52 path is a best-effort dispatch that is never reported as a copy. Every non-confirmed outcome states plainly that the id was not copied.

## [0.10.1] - 2026-10-02

### Fixed

- The opt-in `ses` row is now usable as an identifier. It draws the full session id (the rail wraps it) instead of only its first 8 characters, and a click reports the outcome instead of copying silently: a confirmation naming the id when the copy was sent, and a distinct failure message when the terminal cannot take it.

## [0.10.0] - 2026-10-02

### Added

- Opt-in `ses` sidebar row: shows the full session id (the rail wraps it), and a mouse click copies that same full id and reports the outcome - a confirmation naming the id when the copy was sent, a distinct failure message when the terminal cannot take it. Off by default, and degrades gracefully when the terminal cannot copy.

[0.15.0]: https://github.com/nathwn12/oc-flight-deck/compare/v0.14.0...v0.15.0
[0.14.0]: https://github.com/nathwn12/oc-flight-deck/compare/v0.13.0...v0.14.0
[0.13.0]: https://github.com/nathwn12/oc-flight-deck/compare/v0.12.0...v0.13.0
[0.12.0]: https://github.com/nathwn12/oc-flight-deck/compare/v0.11.0...v0.12.0
[0.11.0]: https://github.com/nathwn12/oc-flight-deck/compare/v0.10.4...v0.11.0
[0.10.4]: https://github.com/nathwn12/oc-flight-deck/compare/v0.10.3...v0.10.4
[0.10.3]: https://github.com/nathwn12/oc-flight-deck/compare/v0.10.2...v0.10.3
[0.10.2]: https://github.com/nathwn12/oc-flight-deck/compare/v0.10.1...v0.10.2
[0.10.1]: https://github.com/nathwn12/oc-flight-deck/compare/v0.10.0...v0.10.1
[0.10.0]: https://github.com/nathwn12/oc-flight-deck/compare/v0.9.0...v0.10.0
