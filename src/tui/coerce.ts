// Coercion guards for untrusted host values.
//
// Everything the host hands the rail — session records, message lists, model
// catalog entries — is `unknown` and read defensively. These four guards are
// the only place the plugin turns a raw value into something the rail can use;
// every other module coerces through them rather than re-checking shapes.
// `SessionLike` is the minimal session shape the reads understand.

export type SessionLike = { cost?: unknown; model?: unknown; time?: unknown; tokens?: unknown };

export function asCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function asText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text.length === 0 ? undefined : text;
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}