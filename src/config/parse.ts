import { parse, type ParseError } from "jsonc-parser";
import { sanitizeFlightDeckConfig, type FlightDeckConfigPatch } from "./schema.js";

export interface ParsedConfig {
  readonly patch: FlightDeckConfigPatch;
  readonly errors: readonly string[];
}

export function parseFlightDeckConfig(text: string): ParsedConfig {
  const errors: ParseError[] = [];
  const value = parse(text, errors, { allowTrailingComma: true, disallowComments: false });
  return {
    patch: sanitizeFlightDeckConfig(value),
    errors: errors.map((error) => `${error.error}@${error.offset}:${error.length}`),
  };
}
