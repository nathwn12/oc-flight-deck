# Install - oc-flight-deck

Three routes. Plugin entries are bare strings in the `plugins` array of `opencode.jsonc`.

## NPM - stable, slow release (MEASURED: WORKS)

```jsonc
{ "plugins": ["oc-flight-deck@0.12.0"] }
```

Stable default. Use this unless you have a reason not to. Measured working as npm version spec `"oc-flight-deck@0.12.0"`.

## GITHUB - bleeding edge, experimental (MEASURED: WORKS as package spec)

```jsonc
{ "plugins": ["oc-flight-deck@git+https://github.com/nathwn12/oc-flight-deck.git#c5ee57c269fcd1db164a95bb7676e43e08298001"] }
```

Experimental, unsupported, may be broken. Every commit is installable, so this route carries unreleased changes. Measured working as github PACKAGE spec `"oc-flight-deck@git+https://github.com/nathwn12/oc-flight-deck.git#<full sha>"` (host log shows it loading).

## NO-NPM (directory entry - local path MEASURED: WORKS; bare `github:` form MEASURED: DOES NOT WORK)

```jsonc
{ "plugins": ["<path to repo - a local clone of this repository>"] }
```

Point the plugin entry at a local clone of this repo (MEASURED: WORKS - host log for the equivalent oc-todo path: `msg="loading plugin" id=Q:/PROJECTS/PERSONAL/oc-todo entrypoint=file:///Q:/PROJECTS/PERSONAL/oc-todo/index.ts role=server`).

The bare `github:nathwn12/oc-flight-deck@<full sha>` directory form with no `#path` DOES NOT LOAD - measured result, not pending: it produced no load, only `NpmInstallFailedError (cause: Error: An unknown git error occurred)`. Same for the `#` and `#index.ts` variants. Do not use it.

This route needs the repo's `index.ts` and involves no npm install. It is the mechanism
superpowers uses.

## Notes

- Mounting by the git spec was MEASURED WORKING for the server half: the host provisions it through npm into `~/.cache/opencode/npm/git-<name>-<hash>/` and loads the entry resolved from `package.json` (`exports["."]`); the host log then records `msg="loading plugin" id=<spec> entrypoint=file:///… role=server`.
- The npm route is unaffected and remains the stable default.
- The TUI half has no direct observation surface in this build (`opencode plugin list` does not report TUI halves for the npm route either), so the TUI half is verified by its visible effect (the sidebar rendering), not by a command.
