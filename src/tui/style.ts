// Per-line appearance for the rail: colour roles and text attributes.
//
// A config file names a role, not a raw theme token: `default`, `subdued`,
// `warning`, `error`, `success`, `info`. This module maps a role onto the host
// theme at render time. The host renamed its text tokens in 2.0.16
// (`default` -> `base`, `subdued` -> `muted`, feedback `default` -> `base`), so
// each role prefers the name this plugin has always read and falls back to the
// renamed one. On a host that provides neither, the colour stays `undefined`
// and the renderer's own default stands — which is exactly what an absent
// token has always done.
//
// Everything is a table lookup, so the config surface is trivial to test.
// `attributeMask` is the one place that reads @opentui/core, because the bits
// must be the vendored renderer's own constants — never re-derived, never ANSI.

import { TextAttributes } from "@opentui/core";

/** Colours a config may name. Roles, not raw theme tokens. */
export const STYLE_COLORS = ["default", "subdued", "warning", "error", "success", "info"] as const;

export type StyleColor = (typeof STYLE_COLORS)[number];

/**
 * Text attributes a config may name, exactly the vendored renderer's enum
 * minus `NONE` (an empty list is how "no attributes" is written).
 */
export const STYLE_ATTRIBUTES = [
  "bold",
  "dim",
  "italic",
  "underline",
  "blink",
  "inverse",
  "hidden",
  "strikethrough",
] as const;

export type StyleAttribute = (typeof STYLE_ATTRIBUTES)[number];

/** One line's look: a named colour plus zero or more attributes. */
export interface LineStyle {
  readonly color: StyleColor;
  readonly attributes: readonly StyleAttribute[];
}

/** The `style` config section, resolved. */
export interface StyleConfig {
  /** The fixed branding/separator lines above the live rows. */
  readonly lines: LineStyle;
  readonly rows: {
    /** Every live row inherits this unless it has its own entry. */
    readonly wildcard: LineStyle;
    /** Per-row entries, only for known row names. */
    readonly overrides: Readonly<Partial<Record<string, LineStyle>>>;
  };
}

/**
 * The shipped look: fixed lines in the theme's primary text colour, live rows
 * subdued, no attributes. This is what an absent `style` section must keep.
 */
export const DEFAULT_STYLE: StyleConfig = {
  lines: { color: "default", attributes: [] },
  rows: { wildcard: { color: "subdued", attributes: [] }, overrides: {} },
};

/** The style for one live row: its own entry when it has one, else the wildcard. */
export function rowStyle(style: StyleConfig, field: string): LineStyle {
  return style.rows.overrides[field] ?? style.rows.wildcard;
}

/**
 * The host theme surface the rail reads. Structural on purpose: ./config.ts
 * must not import a renderer, and tests can pass plain values.
 *
 * Both naming generations are declared because the host renamed the text tokens
 * in 2.0.16; a host provides one or the other.
 */
export interface ThemeLike {
  readonly text?: {
    readonly default?: unknown;
    readonly subdued?: unknown;
    readonly base?: unknown;
    readonly muted?: unknown;
    readonly feedback?: Readonly<
      Partial<Record<"error" | "warning" | "success" | "info", { readonly default?: unknown; readonly base?: unknown }>>
    >;
  };
}

/**
 * The theme colour for a named role, or `undefined` when the host provides
 * neither the current nor the renamed token.
 */
export function themeColor(color: StyleColor, theme: ThemeLike): unknown {
  const text = theme.text;
  if (text === undefined) return undefined;
  switch (color) {
    case "default":
      return text.default ?? text.base;
    case "subdued":
      return text.subdued ?? text.muted;
    default: {
      const feedback = text.feedback?.[color];
      return feedback?.default ?? feedback?.base;
    }
  }
}

/**
 * Renderer bits for each name, read from the vendored enum rather than
 * re-derived, so a renderer change cannot silently desync the config surface.
 */
const ATTRIBUTE_BITS: Readonly<Record<StyleAttribute, number>> = {
  bold: TextAttributes.BOLD,
  dim: TextAttributes.DIM,
  italic: TextAttributes.ITALIC,
  underline: TextAttributes.UNDERLINE,
  blink: TextAttributes.BLINK,
  inverse: TextAttributes.INVERSE,
  hidden: TextAttributes.HIDDEN,
  strikethrough: TextAttributes.STRIKETHROUGH,
};

/** The renderer bitmask for a list of attributes, or `undefined` when there are none. */
export function attributeMask(attributes: readonly StyleAttribute[]): number | undefined {
  let mask = 0;
  for (const attribute of attributes) mask |= ATTRIBUTE_BITS[attribute];
  return mask === 0 ? undefined : mask;
}
