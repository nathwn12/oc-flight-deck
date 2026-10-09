# Install — oc-flight-deck

Two routes. Both entries are bare strings in the `plugins` array of `opencode.jsonc`.

## NPM — stable, slow release

```jsonc
{ "plugins": ["oc-flight-deck@0.12.0"] }
```

Stable default. Use this unless you have a reason not to.

## GITHUB — bleeding edge, experimental

```jsonc
{ "plugins": ["oc-flight-deck@git+https://github.com/nathwn12/oc-flight-deck.git#5d9e0f4590c8a98f74df21b39d8de560b6b22579"] }
```

Experimental, unsupported, may be broken. Every commit is installable, so this route carries unreleased changes.

## NO-NPM (directory entry)

```jsonc
{ "plugins": ["<path to repo - a local clone of this repository>"] }
```

Point the plugin entry at a local clone of this repo. Once pushed, the non-local form is
`github:nathwn12/oc-flight-deck@bf7593f02536d6937b61b84e6e0670dd6623cf31` - pending live
verification, not yet verified.

This route needs the repo's `index.ts` and involves no npm install. It is the mechanism
superpowers uses.

## Notes

- Mounting by the git spec was MEASURED WORKING for the server half: the host provisions it through npm into `~/.cache/opencode/npm/git-<name>-<hash>/` and loads the entry resolved from `package.json` (`exports["."]`); the host log then records `msg="loading plugin" id=<spec> entrypoint=file:///… role=server`.
- The npm route is unaffected and remains the stable default.
- The TUI half has no direct observation surface in this build (`opencode plugin list` does not report TUI halves for the npm route either), so the TUI half is verified by its visible effect (the sidebar rendering), not by a command.
