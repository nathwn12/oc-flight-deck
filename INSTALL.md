# Install - oc-flight-deck

Compatible with opencode 2.0.30.

Two routes. Plugin entries are bare strings in the `plugins` array of `opencode.jsonc`. The package is published to npm as `oc-flight-deck@x.y.z`.

## GIT - remote install (MEASURED: WORKS as package spec)

```jsonc
{ "plugins": ["oc-flight-deck@git+https://github.com/nathwn12/oc-flight-deck.git#<full sha>"] }
```

The default route. Pin a full commit sha, not a branch name, so the install stays put. Every commit is installable, so an unpinned entry carries unreleased changes. Measured working as github PACKAGE spec `"oc-flight-deck@git+https://github.com/nathwn12/oc-flight-deck.git#<full sha>"` (host log shows it loading).

## NO-NPM (directory entry - local path MEASURED: WORKS; bare `github:` form MEASURED: DOES NOT WORK)

```jsonc
{ "plugins": ["<path to repo - a local clone of this repository>"] }
```

Point the plugin entry at a local clone of this repo (MEASURED: WORKS - host log for the equivalent oc-todo path: `msg="loading plugin" id=<local-clone-path> entrypoint=file:///<local-clone-path>/index.ts role=server`).

The bare `github:nathwn12/oc-flight-deck@<full sha>` directory form with no `#path` DOES NOT LOAD - measured result, not pending: it produced no load, only `NpmInstallFailedError (cause: Error: An unknown git error occurred)`. Same for the `#` and `#index.ts` variants. Do not use it.

This route needs the repo's `index.ts` and involves no npm install. It is the mechanism
superpowers uses.

## Notes

- Mounting by the git spec was MEASURED WORKING for the server half: the host provisions it through npm into `~/.cache/opencode/npm/git-<name>-<hash>/` and loads the entry resolved from `package.json` (`exports["."]`); the host log then records `msg="loading plugin" id=<spec> entrypoint=file:///… role=server`. The shipped entries are the compiled `dist/` files (committed so a clone — and the git-install route — works; rebuilt by the `release` workflow before publishing), not raw source.
- The TUI half has no direct observation surface in this build (`opencode plugin list` does not report TUI halves for the git route either), so the TUI half is verified by its visible effect (the sidebar rendering), not by a command.
