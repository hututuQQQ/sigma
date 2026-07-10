import { isJsonValue, type JsonValue } from "./json.js";

export const AGENT_EVENT_SCHEMA_VERSION = 2 as const;

export type ContextAuthority =
  | "system"
  | "developer"
  | "user"
  | "project"
  | "runtime"
  | "tool"
  | "external_verifier";

export type AgentEventType =
  | "session.created"
  | "run.started"
  | "run.suspended"
  | "run.completed"
  | "run.cancelled"
  | "run.failed"
  | "user.message"
  | "user.steer"
  | "user.follow_up"
  | "model.started"
  | "model.delta"
  | "model.reasoning_delta"
  | "model.completed"
  | "model.failed"
  | "tool.requested"
  | "tool.approval_requested"
  | "tool.approval_resolved"
  | "tool.started"
  | "tool.progress"
  | "tool.completed"
  | "tool.failed"
  | "context.compacted"
  | "child.spawned"
  | "child.message"
  | "child.completed"
  | "diagnostic";

export const AGENT_EVENT_TYPES: readonly AgentEventType[] = [
  "session.created", "run.started", "run.suspended", "run.completed", "run.cancelled", "run.failed",
  "user.message", "user.steer", "user.follow_up", "model.started", "model.delta", "model.reasoning_delta",
  "model.completed", "model.failed", "tool.requested", "tool.approval_requested", "tool.approval_resolved",
  "tool.started", "tool.progress", "tool.completed", "tool.failed", "context.compacted", "child.spawned",
  "child.message", "child.completed", "diagnostic"
];

export interface AgentEventEnvelope<TPayload extends JsonValue = JsonValue> {
  schemaVersion: typeof AGENT_EVENT_SCHEMA_VERSION;
  seq: number;
  eventId: string;
  sessionId: string;
  runId: string;
  occurredAt: string;
  type: AgentEventType;
  authority: Exclude<ContextAuthority, "external_verifier">;
  payload: TPayload;
}

export interface ExternalEvaluationReport {
  schemaVersion: 1;
  reportId: string;
  sessionId?: string;
  occurredAt: string;
  evaluator: string;
  payload: JsonValue;
}

export function isSolverVisibleAuthority(authority: ContextAuthority): boolean {
  return authority !== "external_verifier";
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function validIdentity(event: Record<string, unknown>): boolean {
  return [event.eventId, event.sessionId, event.runId].every(nonEmptyString);
}

function validMetadata(event: Record<string, unknown>): boolean {
  const validDate = typeof event.occurredAt === "string" && Number.isFinite(Date.parse(event.occurredAt));
  const validType = typeof event.type === "string" && AGENT_EVENT_TYPES.includes(event.type as AgentEventType);
  const authorities = ["system", "developer", "user", "project", "runtime", "tool"];
  return validDate && validType && typeof event.authority === "string" && authorities.includes(event.authority);
}

export function isAgentEventEnvelope(value: unknown): value is AgentEventEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  return event.schemaVersion === AGENT_EVENT_SCHEMA_VERSION
    && Number.isInteger(event.seq) && Number(event.seq) >= 1
    && validIdentity(event)
    && validMetadata(event)
    && isJsonValue(event.payload);
}

export function assertAgentEventEnvelope(value: unknown): asserts value is AgentEventEnvelope {
  if (!isAgentEventEnvelope(value)) throw new Error("Invalid AgentEventEnvelope.");
}
