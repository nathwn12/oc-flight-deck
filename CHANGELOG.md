# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.13.0]: https://github.com/nathwn12/oc-flight-deck/compare/v0.12.0...v0.13.0
[0.12.0]: https://github.com/nathwn12/oc-flight-deck/compare/v0.11.0...v0.12.0
[0.11.0]: https://github.com/nathwn12/oc-flight-deck/compare/v0.10.4...v0.11.0
[0.10.4]: https://github.com/nathwn12/oc-flight-deck/compare/v0.10.3...v0.10.4
[0.10.3]: https://github.com/nathwn12/oc-flight-deck/compare/v0.10.2...v0.10.3
[0.10.2]: https://github.com/nathwn12/oc-flight-deck/compare/v0.10.1...v0.10.2
[0.10.1]: https://github.com/nathwn12/oc-flight-deck/compare/v0.10.0...v0.10.1
[0.10.0]: https://github.com/nathwn12/oc-flight-deck/compare/v0.9.0...v0.10.0
