import { Plugin } from "@opencode/plugin";
import { FlightDeckRpc } from "./rpc.js";
import { FlightDeckState, type StorageLike } from "./state.js";
import { loadFlightDeckConfig } from "../config/discover.js";

interface RecordValue {
  readonly [key: string]: unknown;
}

function record(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function modelParts(value: unknown): { provider?: string; model?: string } {
  if (!record(value)) return {};
  return { provider: stringValue(value.providerID), model: stringValue(value.id) };
}

function inputRecord(value: unknown): RecordValue {
  return record(value) ? value : {};
}

function stringInput(value: unknown, key: string): string | undefined {
  return stringValue(inputRecord(value)[key]);
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

interface EventContextLike {
  readonly event: { subscribe(options: { signal: AbortSignal }): AsyncIterable<unknown> };
}

async function consumeEvents(ctx: EventContextLike, state: FlightDeckState, signal: AbortSignal, location: string): Promise<void> {
  for await (const event of ctx.event.subscribe({ signal })) {
    const raw = event as { type?: unknown; created?: unknown; data?: unknown; location?: { directory?: unknown } };
    if (typeof raw.location?.directory === "string" && raw.location.directory !== location) continue;
    const data = inputRecord(raw.data);
    const sessionId = stringValue(data.sessionID);
    const at = numberValue(raw.created) ?? Date.now();
    if (!sessionId) continue;

    if (raw.type === "session.step.started") {
      const model = modelParts(data.model);
      state.recordStepStart({ sessionId, messageId: stringValue(data.assistantMessageID), at, provider: model.provider, model: model.model });
      continue;
    }
    if (raw.type === "session.text.delta" || raw.type === "session.reasoning.delta") {
      state.recordTextDelta(sessionId, at, stringValue(data.assistantMessageID));
      continue;
    }
    if (raw.type === "session.usage.updated") {
      const tokens = inputRecord(data.tokens);
      const outputTokens = numberValue(tokens.output);
      if (outputTokens !== undefined) state.recordUsage({ sessionId, at, outputTokens, inputTokens: numberValue(tokens.input), costUsd: numberValue(data.cost) });
      continue;
    }
    if (raw.type === "session.status") {
      const status = inputRecord(data.status);
      const type = stringValue(status.type);
      state.recordStatus(sessionId, type === "busy" ? "busy" : type === "retry" ? "retry" : type === "idle" ? "idle" : "unknown", at, numberValue(status.attempt) ?? 0);
      continue;
    }
    if (raw.type === "session.execution.failed" || raw.type === "session.step.failed") {
      state.recordFailure(sessionId, at);
      continue;
    }
    if (raw.type === "session.idle" || raw.type === "session.execution.succeeded" || raw.type === "session.execution.interrupted" || raw.type === "session.step.ended") {
      state.recordStatus(sessionId, "idle", at);
    }
  }
}

export default Plugin.define({
  id: "flight-deck",
  async setup(ctx) {
    const loaded = await loadFlightDeckConfig({ cwd: ctx.location.directory });
    const storage = ctx.storage as unknown as StorageLike;
    let rpcRegistration: { events: { emit(name: "updated", data: Record<string, unknown>): Promise<void> }; dispose(): Promise<void> } | undefined;
    const state = new FlightDeckState({
      storage,
      config: loaded.config,
      location: ctx.location.directory,
      configPath: loaded.sources.projectPath ?? loaded.sources.globalPath,
      onUpdate: (event) => {
      if (rpcRegistration) {
        const data: Record<string, unknown> = { event: event.event };
        if (event.taskId) data.taskId = event.taskId;
        if (event.sessionId) data.sessionId = event.sessionId;
        void rpcRegistration.events.emit("updated", data);
      }
      },
    });
    await state.hydrate();

    rpcRegistration = await ctx.rpc.register(FlightDeckRpc, {
      status: async () => state.status(),
      create: async (input) => {
        const value = inputRecord(input);
        return state.createTask({
          id: stringValue(value.id),
          title: stringValue(value.title) ?? "Untitled task",
          artifact: stringValue(value.artifact),
          priority: value.priority === "low" || value.priority === "high" ? value.priority : "normal",
          contextTokens: numberValue(value.contextTokens),
        });
      },
      claim: async (input) => state.claim(stringInput(input, "taskId") ?? "", stringInput(input, "holder") ?? ""),
      heartbeat: async (input) => state.heartbeat(stringInput(input, "taskId") ?? "", stringInput(input, "holder") ?? ""),
      report: async (input) => {
        const value = inputRecord(input);
        const outcome = value.outcome;
        if (outcome !== "start" && outcome !== "review" && outcome !== "block" && outcome !== "pause" && outcome !== "resume" && outcome !== "complete" && outcome !== "fail" && outcome !== "release") return { ok: false, reason: "invalid-outcome" };
        return state.report(stringInput(input, "taskId") ?? "", stringInput(input, "holder") ?? "", outcome, stringValue(value.note));
      },
      pause: async () => state.setPaused(true),
      resume: async () => state.setPaused(false),
      setAutopilot: async (input) => state.setAutopilot(inputRecord(input).enabled === true),
    });

    const toolRegistration = await ctx.tool.transform((editor) => {
      editor.namespace({ name: "flightdeck", description: "Flight Deck swarm coordination and telemetry" });
      const taskInput = { type: "object", properties: { taskId: { type: "string" }, holder: { type: "string" } }, required: ["taskId"], additionalProperties: false } as const;
      if (loaded.config.coordination.enabled) editor.add({
        name: "claim",
        description: "Claim a Flight Deck task for this session. Include a holder only when acting for another session.",
        input: taskInput,
        options: { namespace: "flightdeck", codemode: true },
        execute: async (input, tool) => {
          const result = await state.claim(inputRecord(input).taskId as string, stringValue(inputRecord(input).holder) ?? tool.sessionID);
          return { content: json(result) };
        },
      });
      if (loaded.config.coordination.enabled) editor.add({
        name: "heartbeat",
        description: "Renew a claimed Flight Deck task lease.",
        input: taskInput,
        options: { namespace: "flightdeck", codemode: true },
        execute: async (input, tool) => {
          const result = await state.heartbeat(inputRecord(input).taskId as string, stringValue(inputRecord(input).holder) ?? tool.sessionID);
          return { content: json(result) };
        },
      });
      if (loaded.config.coordination.enabled) editor.add({
        name: "report",
        description: "Report progress or an outcome for a claimed Flight Deck task.",
        input: { type: "object", properties: { taskId: { type: "string" }, outcome: { type: "string" }, note: { type: "string" } }, required: ["taskId", "outcome"], additionalProperties: false } as const,
        options: { namespace: "flightdeck", codemode: true },
        execute: async (input, tool) => {
          const value = inputRecord(input);
          const outcomes = ["start", "review", "block", "pause", "resume", "complete", "fail", "release"] as const;
          const outcome = outcomes.find((candidate) => candidate === value.outcome);
          if (!outcome) return { content: json({ ok: false, reason: "invalid-outcome" }) };
          const result = await state.report(value.taskId as string, tool.sessionID, outcome, stringValue(value.note));
          return { content: json(result) };
        },
      });
      editor.add({
        name: "status",
        description: "Read Flight Deck telemetry, task, worker, and autopilot status.",
        input: { type: "object", properties: {}, additionalProperties: false } as const,
        options: { namespace: "flightdeck", codemode: true },
        execute: async () => ({ content: json(await state.status()) }),
      });
    });

    const controller = new AbortController();
    void consumeEvents(ctx, state, controller.signal, ctx.location.directory).catch(() => {
      if (!controller.signal.aborted) console.error("Flight Deck event collector stopped");
    });
    const retryRegistration = await ctx.session.hook("retry", (event) => {
      const provider = event.model.providerID;
      const status = event.error.status;
      const delay = state.onRetry(provider, event.decision.retry ? event.decision.delay : 0, status);
      if (event.decision.retry && delay > event.decision.delay) event.decision = { retry: true, delay };
    });
    const sweep = setInterval(() => void state.expireLeases(), Math.max(1_000, loaded.config.coordination.heartbeatMs));

    return async () => {
      controller.abort();
      clearInterval(sweep);
      await state.flush();
      await retryRegistration.dispose();
      await toolRegistration.dispose();
      await rpcRegistration?.dispose();
    };
  },
});

export { FlightDeckRpc } from "./rpc.js";
export { FlightDeckState } from "./state.js";
export type { FlightDeckStatus } from "./state.js";
