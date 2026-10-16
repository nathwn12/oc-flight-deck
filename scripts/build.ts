// Build the shipped plugin entries to plain compiled JS in `dist/`.
//
// Why this exists: the host TUI loader rewrites explicit runtime specifiers
// for plugin files under `node_modules` only when the file receives a rewrite
// loader, and its Solid transform skips every `node_modules` path — so a raw
// `.tsx` entry falls back to Bun's native JSX transform, whose injected
// `jsx-dev-runtime` import bypasses the rewrite and fails to resolve
// (opencode v2.0.30). The shipped entry must therefore be plain compiled JS
// with explicit `jsx`/`jsxs` imports from `@opentui/solid/jsx-runtime`.
//
// `define` pins the production JSX runtime without minification: without it
// Bun emits the dev runtime (`jsx-dev-runtime`); `--production` would also
// work but forces minification. `minify: false` keeps the output readable.
// Everything host-served stays external — `@opentui/*`, `solid-js`, and the
// plugin SDK resolve from the host at load time, so nothing of theirs is
// bundled or copied into `dist/`.
//
// `dist/` is committed (force-added past `dist/` in `.gitignore`) because the
// git-ref install route clones the repo and loads the entry from the clone:
// an ignored `dist/` would ship a package with no entry.

import { rm } from "node:fs/promises";

const root = import.meta.dir.endsWith("scripts")
  ? `${import.meta.dir}/..`
  : import.meta.dir;

await rm(`${root}/dist`, { recursive: true, force: true });

const result = await Bun.build({
  entrypoints: [`${root}/src/index.ts`, `${root}/src/tui/index.tsx`],
  outdir: `${root}/dist`,
  root: `${root}/src`,
  format: "esm",
  target: "bun",
  minify: false,
  sourcemap: "none",
  external: ["@opentui/*", "solid-js", "solid-js/store", "@opencode/*"],
  // Production JSX runtime (`jsx`/`jsxs` from `jsx-runtime`), no minification.
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

console.log(result.outputs.map((output) => output.path).join("\n"));
