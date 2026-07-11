import {
  CLI_OUTPUT_SCHEMA_VERSION as CURRENT_CLI_OUTPUT_SCHEMA_VERSION,
  LEGACY_AGENT_EVENT_TYPES_V2,
  type AgentEventEnvelope
} from "agent-protocol";

export const CLI_OUTPUT_SCHEMA_VERSION = CURRENT_CLI_OUTPUT_SCHEMA_VERSION;

function outputEventV2(event: AgentEventEnvelope): unknown {
  const legacy = new Set<string>(LEGACY_AGENT_EVENT_TYPES_V2);
  if (legacy.has(event.type)) return { ...event, schemaVersion: 2 };
  return {
    ...event,
    schemaVersion: 2,
    type: "diagnostic",
    payload: { kind: "v3_event", originalType: event.type, payload: event.payload }
  };
}

export function outputEvent(event: AgentEventEnvelope, schema: 2 | 3): unknown {
  return schema === 2 ? outputEventV2(event) : { ...event, schemaVersion: CLI_OUTPUT_SCHEMA_VERSION, kind: "event", event };
}

export function outputResult(result: unknown, schema: 2 | 3): unknown {
  const flattened = result && typeof result === "object" && !Array.isArray(result) ? result : {};
  return schema === 2
    ? { type: "result", result }
    : { ...flattened, schemaVersion: CLI_OUTPUT_SCHEMA_VERSION, kind: "result", type: "result", result };
}

export function outputError(error: { code: string; message: string }, schema: 2 | 3): unknown {
  return schema === 2
    ? { type: "error", error }
    : { schemaVersion: CLI_OUTPUT_SCHEMA_VERSION, kind: "error", type: "error", error };
}
