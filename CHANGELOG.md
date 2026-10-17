# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.20.0] - 2026-10-17

### Added

- `notifications` section (`enabled`, `config`, `copy`, `caution`, all default `true`): the silencing layer over every toast the plugin can raise — the invalid-config warning, the copy outcome, and the opt-in caution toast. `"notifications": { "enabled": false }` is the one-line silence switch; each per-kind flag silences only its kind. `caution.toast` stays the feature opt-in (default `false`); the new section only ever silences, never enables.

- `sidebar.tps.display` (`"avg"`, `"live"` or `"both"`, default `"avg"`): which figure the `tps` row draws. `avg` is the settled-turn average — generation tokens (output plus reasoning) over assistant turns that recorded `streamed`, divided by the union of their `streamed − created` spans — so an idle gap reads as a steady figure instead of zero and in-flight turns never dilute it (on hosts without turn timestamps the average is generation tokens over the borrowed active clock instead). `live` is the near-instantaneous EWMA rate, reading zero while nothing generates. `both` draws both on one line (`106 live · 41 avg`), degrading to the live half alone when nothing settled yet. An unknown value falls back to `"avg"` and is reported.

### Changed

- The `tps` row now defaults to the settled-turn average (`sidebar.tps.display: "avg"`) instead of the near-instantaneous rate: the row holds steady through idle gaps between turns and draws on the first poll with no baselines to set. `live` keeps the previous per-poll behaviour byte-identically.

### Fixed

- The session-id copy is now really verified: the plugin uses the host-served clipboard (`createHostClipboard` from `@opentui/core`, resolved to the host's own core instance) instead of no backend, and an OSC52 dispatch is confirmed by reading the OS clipboard back (up to 5 attempts, 60ms apart) before it counts — `osc52-confirmed` stays silent like every verified copy, while an unconfirmed dispatch keeps its advisory warning.
- The `0.19.2` tag shipped a stale `dist/`: `src/tui/clipboard.ts` changed without a rebuild, so installs still showed the old toast. `dist/` is rebuilt in this commit, and the new `bun run check:dist` gate (wired into `check.yml`) fails when `dist/` drifts from source again.
- The `ses` row's unconfirmed OSC52 dispatch reports as an advisory `warning` ("paste to verify") instead of an error: the bytes were sent but no backend can confirm the terminal acted on them. The five genuine failures stay `error`, and only a verified copy ever reports success.

## [0.19.2] - 2026-10-16

### Fixed

- The README and INSTALL no longer claim the package is unpublished: the `0.19.1` tarball shipped that stale text (corrected in docs after the tag), so this release ships the corrected wording.

## [0.19.1] - 2026-10-16

### Changed

- The TUI entrypoint now consumes the host renderer instead of shipping its own `@opentui/*` copy: `@opentui/core` and `@opentui/solid` moved from `dependencies` to `peerDependencies`-only (`>=0.5.17`, matching the host), per the official CLI plugin contract. Opencode v2.0.30 refuses to load a plugin that ships and value-imports its own `@opentui/core`, so the vendored value imports are gone: the OSC52 fallback calls the host renderer's `copyToClipboardOSC52` structurally (same capability gating as before), and the text-attribute bits are pinned as local literals asserted against the vendored enum in tests. There is no sanctioned host clipboard surface, so without a renderer fallback the copy path reports `no-backend` instead of throwing. `@opencode/plugin` is pinned to the current host version `2.0.30`.

### Added

- `layout.labels`: rename any rail row's label, keyed by the row name exactly as `sidebar.rows` spells it (`session` is folded to `ses`). `{ "cost": "session", "total": "lifetime" }` draws the session's own cost under `session` and the family total under `lifetime`; every row left out keeps its built-in label, so an install that never sets the key renders byte-identically to before. An unknown row name, a non-string value, or an empty label is reported as a config issue naming its path (`layout.labels.<name>`) and that row falls back to its default label. Both renderers resolve a row's label from the same map, so the plain-string view and the segmented (`style.rows`) view never disagree.
- `sidebar.tps.scope` (`"family"` or `"session"`, default `"family"`): which sessions the `tps` row paces. `family` sums generation tokens (output plus reasoning) across the open session and its subagent sessions over the union of all their streaming spans — concurrent decoders share wall clock, so overlapping spans merge instead of adding, and a root that is idle while its child decodes still reads live. `session` restores the previous per-session figure: the open session's own tokens over its own spans. An unknown value falls back to `"family"` and is reported.

### Changed

- The `total` row draws the real family figure for a childless session: its own cost with `0 subagents`, instead of the persist layer's live-shaped `$0.000`. `treeTotals` now records a family of one as the session's own cost against a count of zero rather than returning nothing, and the row renders whenever a family figure exists — so a session that spawned no subagents still reads its lifetime figure under that row. `total` stays absent, and the unchanged skeleton draws, only when there is genuinely no tree or cost data at all (a session with no record yet), and a child session still has no `total` of its own. A session with subagents sums them exactly as before.

### Fixed

- Opencode 2.0.30 compatibility: the shipped entries are now plain compiled JS in `dist/` (`bun run compile`), not raw source. A raw `.tsx` entry under `node_modules` falls back to Bun's native JSX transform on this host, whose injected `jsx-dev-runtime` import bypasses the rewrite loader and fails to resolve — so the TUI entry ships with explicit `jsx`/`jsxs` imports from `@opentui/solid/jsx-runtime` and no raw JSX. `package.json` `exports` (`"."` and `"./tui"`) and `files` point at `dist/` (`src` stays for types and dev), `@opentui/*` and `solid-js`/`solid-js/store` stay external with nothing bundled or copied.

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
