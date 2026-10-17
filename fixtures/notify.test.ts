import { describe, expect, test } from "bun:test";
import { DEFAULT_NOTIFICATIONS } from "../src/tui/config.js";
import { shouldNotify, type NotifyKind } from "../src/tui/notify.js";

// The silencing layer over every toast the plugin can raise: the
// invalid-config warning, the copy outcome, and the opt-in caution toast.
// These pin that the gate is pure silencing - `enabled` is the master switch,
// each per-kind flag quiets only its own kind, and the defaults leave every
// toast on, so quiet is always an explicit edit.

const KINDS: readonly NotifyKind[] = ["config", "copy", "caution"];

describe("the notification silencing layer", () => {
  test("every toast is on by default", () => {
    for (const kind of KINDS) {
      expect(shouldNotify(DEFAULT_NOTIFICATIONS, kind)).toBe(true);
    }
  });

  test("the master switch silences all three kinds", () => {
    const off = { ...DEFAULT_NOTIFICATIONS, enabled: false };
    for (const kind of KINDS) {
      expect(shouldNotify(off, kind)).toBe(false);
    }
  });

  test("each per-kind flag silences only its own kind", () => {
    for (const kind of KINDS) {
      const config = { ...DEFAULT_NOTIFICATIONS, [kind]: false };
      expect(shouldNotify(config, kind)).toBe(false);
      for (const other of KINDS) {
        if (other !== kind) expect(shouldNotify(config, other)).toBe(true);
      }
    }
  });
});
