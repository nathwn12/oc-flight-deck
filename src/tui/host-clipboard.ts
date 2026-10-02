// The host-clipboard seam, split from `./clipboard.ts` for one reason: the
// render tests mount the real JSX in a real headless renderer, where mocking
// all of `@opentui/core` would break the renderer itself. This module is the
// only thing those tests replace, so they can stand in a fake host write while
// the renderer and the OSC52 adapter stay real.
//
// Production always resolves to the real process host clipboard.

export { createHostClipboard } from "@opentui/core";
