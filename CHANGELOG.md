# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.10.3]: https://github.com/nathwn12/oc-flight-deck/compare/v0.10.2...v0.10.3
[0.10.2]: https://github.com/nathwn12/oc-flight-deck/compare/v0.10.1...v0.10.2
[0.10.1]: https://github.com/nathwn12/oc-flight-deck/compare/v0.10.0...v0.10.1
[0.10.0]: https://github.com/nathwn12/oc-flight-deck/compare/v0.9.0...v0.10.0
