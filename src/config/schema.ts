export type DisplayMode = "always" | "auto" | "hidden";

export interface FlightDeckConfig {
  readonly telemetry: {
    readonly enabled: boolean;
  };
  readonly metrics: {
    readonly tps: boolean;
    readonly ttft: boolean;
    readonly cost: boolean;
    readonly context: boolean;
  };
  readonly ui: {
    readonly sidebar: DisplayMode;
    readonly footer: DisplayMode;
    readonly compact: boolean;
  };
  readonly coordination: {
    readonly enabled: boolean;
    readonly leaseTtlMs: number;
    readonly heartbeatMs: number;
  };
  readonly autopilot: {
    readonly enabled: boolean;
    readonly recommendations: boolean;
    readonly backoff: boolean;
    readonly requeue: boolean;
  };
  readonly history: {
    readonly maxItems: number;
  };
}

export type FlightDeckConfigPatch = {
  readonly telemetry?: { -readonly [K in keyof FlightDeckConfig["telemetry"]]?: FlightDeckConfig["telemetry"][K] };
  readonly metrics?: { -readonly [K in keyof FlightDeckConfig["metrics"]]?: FlightDeckConfig["metrics"][K] };
  readonly ui?: { -readonly [K in keyof FlightDeckConfig["ui"]]?: FlightDeckConfig["ui"][K] };
  readonly coordination?: { -readonly [K in keyof FlightDeckConfig["coordination"]]?: FlightDeckConfig["coordination"][K] };
  readonly autopilot?: { -readonly [K in keyof FlightDeckConfig["autopilot"]]?: FlightDeckConfig["autopilot"][K] };
  readonly history?: { -readonly [K in keyof FlightDeckConfig["history"]]?: FlightDeckConfig["history"][K] };
};

export const DEFAULT_FLIGHT_DECK_CONFIG: FlightDeckConfig = {
  telemetry: { enabled: true },
  metrics: { tps: true, ttft: true, cost: true, context: true },
  ui: { sidebar: "always", footer: "always", compact: true },
  coordination: { enabled: true, leaseTtlMs: 120_000, heartbeatMs: 30_000 },
  autopilot: { enabled: false, recommendations: true, backoff: true, requeue: true },
  history: { maxItems: 200 },
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bool(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function positiveInt(value: unknown, minimum: number, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum;
}

function mode(value: unknown): value is DisplayMode {
  return value === "always" || value === "auto" || value === "hidden";
}

/** Keep only recognized, valid keys. Sparse output lets global and project files merge safely. */
export function sanitizeFlightDeckConfig(value: unknown): FlightDeckConfigPatch {
  if (!record(value)) return {};
  const out: {
    telemetry?: Partial<FlightDeckConfig["telemetry"]>;
    metrics?: Partial<FlightDeckConfig["metrics"]>;
    ui?: Partial<FlightDeckConfig["ui"]>;
    coordination?: Partial<FlightDeckConfig["coordination"]>;
    autopilot?: Partial<FlightDeckConfig["autopilot"]>;
    history?: Partial<FlightDeckConfig["history"]>;
  } = {};

  if (record(value.telemetry)) {
    const telemetry: FlightDeckConfigPatch["telemetry"] = {};
    for (const key of ["enabled"] as const) {
      if (bool(value.telemetry[key])) telemetry[key] = value.telemetry[key];
    }
    if (Object.keys(telemetry).length) out.telemetry = telemetry;
  }
  if (record(value.metrics)) {
    const metrics: FlightDeckConfigPatch["metrics"] = {};
    for (const key of ["tps", "ttft", "cost", "context"] as const) {
      if (bool(value.metrics[key])) metrics[key] = value.metrics[key];
    }
    if (Object.keys(metrics).length) out.metrics = metrics;
  }
  if (record(value.ui)) {
    const ui: FlightDeckConfigPatch["ui"] = {};
    if (mode(value.ui.sidebar)) ui.sidebar = value.ui.sidebar;
    if (mode(value.ui.footer)) ui.footer = value.ui.footer;
    if (bool(value.ui.compact)) ui.compact = value.ui.compact;
    if (Object.keys(ui).length) out.ui = ui;
  }
  if (record(value.coordination)) {
    const coordination: FlightDeckConfigPatch["coordination"] = {};
    if (bool(value.coordination.enabled)) coordination.enabled = value.coordination.enabled;
    if (positiveInt(value.coordination.leaseTtlMs, 1_000)) coordination.leaseTtlMs = value.coordination.leaseTtlMs;
    if (positiveInt(value.coordination.heartbeatMs, 100)) coordination.heartbeatMs = value.coordination.heartbeatMs;
    if (Object.keys(coordination).length) out.coordination = coordination;
  }
  if (record(value.autopilot)) {
    const autopilot: FlightDeckConfigPatch["autopilot"] = {};
    if (bool(value.autopilot.enabled)) autopilot.enabled = value.autopilot.enabled;
    if (bool(value.autopilot.recommendations)) autopilot.recommendations = value.autopilot.recommendations;
    if (bool(value.autopilot.backoff)) autopilot.backoff = value.autopilot.backoff;
    if (bool(value.autopilot.requeue)) autopilot.requeue = value.autopilot.requeue;
    if (Object.keys(autopilot).length) out.autopilot = autopilot;
  }
  if (record(value.history) && positiveInt(value.history.maxItems, 1, 5_000)) out.history = { maxItems: value.history.maxItems };
  return out;
}

export function mergeFlightDeckConfig(...patches: readonly FlightDeckConfigPatch[]): FlightDeckConfig {
  const result: {
    telemetry: FlightDeckConfig["telemetry"];
    metrics: FlightDeckConfig["metrics"];
    ui: FlightDeckConfig["ui"];
    coordination: FlightDeckConfig["coordination"];
    autopilot: FlightDeckConfig["autopilot"];
    history: FlightDeckConfig["history"];
  } = {
    telemetry: { ...DEFAULT_FLIGHT_DECK_CONFIG.telemetry },
    metrics: { ...DEFAULT_FLIGHT_DECK_CONFIG.metrics },
    ui: { ...DEFAULT_FLIGHT_DECK_CONFIG.ui },
    coordination: { ...DEFAULT_FLIGHT_DECK_CONFIG.coordination },
    autopilot: { ...DEFAULT_FLIGHT_DECK_CONFIG.autopilot },
    history: { ...DEFAULT_FLIGHT_DECK_CONFIG.history },
  };
  for (const patch of patches) {
    if (patch.telemetry) result.telemetry = { ...result.telemetry, ...patch.telemetry };
    if (patch.metrics) result.metrics = { ...result.metrics, ...patch.metrics };
    if (patch.ui) result.ui = { ...result.ui, ...patch.ui };
    if (patch.coordination) result.coordination = { ...result.coordination, ...patch.coordination };
    if (patch.autopilot) result.autopilot = { ...result.autopilot, ...patch.autopilot };
    if (patch.history) result.history = { ...result.history, ...patch.history };
  }
  return result;
}
