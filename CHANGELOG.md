# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.10.0] - 2026-10-02

### Added

- Opt-in `ses` sidebar row: shows the session id shortened to its first 8 characters, and a mouse click copies the full id via the renderer's OSC52 clipboard path. Off by default, and degrades gracefully when the terminal cannot copy.

[0.10.0]: https://github.com/nathwn12/oc-flight-deck/compare/v0.9.0...v0.10.0
