import { Rpc } from "@opencode/plugin/rpc";
export type { FlightDeckStatus } from "./state.js";

const object = (properties: Record<string, unknown> = {}) => ({
  type: "object",
  properties,
  additionalProperties: true,
} as const);

const empty = object({});

export const FlightDeckRpc = Rpc.define({
  id: "flightdeck",
  methods: {
    status: { input: empty, output: object() },
    create: { input: object({ title: { type: "string" }, id: { type: "string" }, artifact: { type: "string" }, priority: { type: "string" } }), output: object() },
    claim: { input: object({ taskId: { type: "string" }, holder: { type: "string" } }), output: object() },
    heartbeat: { input: object({ taskId: { type: "string" }, holder: { type: "string" } }), output: object() },
    report: { input: object({ taskId: { type: "string" }, holder: { type: "string" }, outcome: { type: "string" }, note: { type: "string" } }), output: object() },
    pause: { input: empty, output: object() },
    resume: { input: empty, output: object() },
    setAutopilot: { input: object({ enabled: { type: "boolean" } }), output: object() },
  },
  events: {
    updated: { schema: object({ event: { type: "string" }, taskId: { type: "string" }, sessionId: { type: "string" } }) },
  },
});
