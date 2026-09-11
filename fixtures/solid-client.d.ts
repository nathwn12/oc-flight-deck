// `bun` and `node` resolve the bare "solid-js" specifier to its SSR build, which
// has no reactive graph — effects never run. The one test that needs a live
// reactive graph imports the client build by path, and that deep path ships no
// declarations of its own, so it borrows the package's public types.
declare module "solid-js/dist/solid.js" {
  export * from "solid-js";
}
