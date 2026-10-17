// The notification silencing layer: one pure predicate over the
// `notifications` config section.
//
// The plugin raises three kinds of toast - an invalid-config warning, a copy
// outcome, and the opt-in caution toast - and every one of them is gated here.
// `enabled` is the master switch; each per-kind flag silences only its kind.
// `caution.toast` stays the feature opt-in (default off); this section only
// ever silences, never enables.

import type { NotificationsConfig } from "./config.js";

/** The toast kinds the plugin can raise. */
export type NotifyKind = "config" | "copy" | "caution";

/**
 * Whether a toast of `kind` may be shown under `config`. Pure: no reads, no
 * writes, never throws.
 */
export function shouldNotify(config: NotificationsConfig, kind: NotifyKind): boolean {
  return config.enabled && config[kind];
}
