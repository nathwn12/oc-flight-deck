# oc-flight-deck

An OpenCode plugin that renders live session telemetry — agent, model, cost, tokens, cache, context and more — as a panel in the sidebar. It is for anyone running agent sessions who wants the numbers where they are already looking, and it fits the OpenCode plugin ecosystem as a sidebar-panel plugin loaded through the host's plugin array.

## Quick start

To use it, add the plugin to the `plugins` array in `opencode.jsonc` (pin a full commit sha, not a branch name, so the install stays put), restart the OpenCode host, and check that the panel appears beside an open session. See `INSTALL.md` for the two install routes and `flight-deck.example.jsonc` for every option.

To work on it:

```sh
bun install
bun run check
```

`bun run check` typechecks and runs the suite. `bun run compile` emits the shipped entries to `dist/`.

## Layout

- `index.ts` — package root, re-exports the server entrypoint.
- `src/index.ts` — server-side entrypoint (deliberately inert; visible behavior lives in `src/tui`).
- `src/tui/index.tsx` — sidebar panel entrypoint.
- `src/tui/` — one module per concern (rows, config, stats, formatting, caution, go usage).
- `scripts/build.ts` — compile script behind `bun run compile`.
- `fixtures/` — test suite (`*.test.ts`).
- `flight-deck.example.jsonc` — every option, documented inline; copy to the host config path to configure.
- `flight-deck.schema.json` — types, defaults and allowed values.
- `INSTALL.md` — the two install routes.
- `CHANGELOG.md` — release history.
- `.github/workflows/check.yml` — typecheck plus tests on `main` pushes and pull requests.
- `.github/workflows/ci.yml` — compile plus tests on push and pull requests.
- `.github/workflows/release.yml` — publish job on version tags.
- `assets/` — repo images (icon, signature).

## Conventions

- Commit subjects follow Conventional Commits (`<type>: <subject>`).
- Branches are named `<type>/<slug>`.
- Land only through a pull request, squash-merged, then delete the branch.
- Keep `CHANGELOG.md` and the docs current with every user-visible change.
- `README.md` follows the house skeleton (badges, What it is, Why, Features, Install, Usage, Build from source, Docs, Status, License, house footer); do not reshape it.

## Host contract

- Targets the OpenCode host (compatible with opencode 2.0.30) through the official CLI plugin API.
- The host provides the renderer: `@opentui/core`, `@opentui/solid` and `solid-js` are peer dependencies, supplied by the host and never bundled.
- The repo ships `@opencode/plugin` as its only runtime dependency, plus the compiled entries in `dist/` that the host actually loads — never raw source.

## Release

- Releases are cut by pushing an annotated tag `v<version>`; the `release` workflow then compiles and publishes to the public registry.
- This workflow has no tag-versus-manifest guard, so make sure the tag and the manifest version agree before pushing.
- `dist/` is gitignored and built at publish time — the workflow compiles before publishing.
- The changelog lives in `CHANGELOG.md` (Keep a Changelog, Semantic Versioning).
- Two tracks: the registry is the slow/stable track (tagged releases only); a git install spec at any commit is the fast/experimental track (every commit installable).

## Guardrails

- Never add an npm script named `install`, `postinstall`, `preinstall`, `build`, `prepare`, or `prepack`: a git install would then re-trigger a dependency-preparation step that is not needed here.
- `dist/` is gitignored, so it must be built (`bun run compile`) before any package is published — never publish from a stale or missing `dist/`.
- Keep the docs' publication claims true: if the install, build, or publish story changes, update `README.md`, `INSTALL.md` and this guide together.
- Do not hand-edit `dist/`: it is generated output; change the source and recompile.
