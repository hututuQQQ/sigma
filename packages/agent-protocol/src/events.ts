import { z } from "zod";
import { isEvidenceRecord, type EvidenceRecord } from "./domain.js";
import {
  AGENT_EVENT_TYPES,
  agentEventPayloadSchemas,
  isAgentEventPayload,
  parseAgentEventPayload,
  type AgentEventPayloadMap,
  type AgentEventType
} from "./event-payload-schemas.js";
import { type JsonValue } from "./json.js";
import {
  EVENT_SCHEMA_VERSION,
  LEGACY_EVENT_SCHEMA_VERSION_V5
} from "./versions.js";

export { AGENT_EVENT_TYPES, parseAgentEventPayload, type AgentEventPayloadMap, type AgentEventType };

export type ContextAuthority =
  | "system"
  | "developer"
  | "user"
  | "project"
  | "runtime"
  | "tool"
  | "external_verifier";

export interface AgentEventEnvelope<
  TPayload = unknown,
  TType extends AgentEventType = AgentEventType
> {
  schemaVersion: typeof EVENT_SCHEMA_VERSION;
  seq: number;
  eventId: string;
  sessionId: string;
  runId: string;
  occurredAt: string;
  type: TType;
  authority: Exclude<ContextAuthority, "external_verifier">;
  payload: TPayload;
}

export type AgentEventOf<TType extends AgentEventType> =
  AgentEventEnvelope<AgentEventPayloadMap[TType], TType>;

export type AnyTypedAgentEvent = {
  [TType in AgentEventType]: AgentEventOf<TType>
}[AgentEventType];

export interface ExternalEvaluationReport {
  schemaVersion: 1;
  reportId: string;
  sessionId?: string;
  occurredAt: string;
  evaluator: string;
  payload: JsonValue;
}

export interface ProtocolValidationIssue {
  path: ReadonlyArray<string | number>;
  code: string;
  message: string;
}

export class AgentEventValidationError extends Error {
  readonly code = "invalid_agent_event_envelope";

  constructor(readonly issues: readonly ProtocolValidationIssue[]) {
    const details = issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`).join("; ");
    super(`Invalid AgentEventEnvelope V${EVENT_SCHEMA_VERSION}: ${details}`);
    this.name = "AgentEventValidationError";
  }
}

export function isSolverVisibleAuthority(authority: ContextAuthority): boolean {
  return authority !== "external_verifier";
}

const eventMetadataSchema = z.object({
  schemaVersion: z.union([
    z.literal(LEGACY_EVENT_SCHEMA_VERSION_V5),
    z.literal(EVENT_SCHEMA_VERSION)
  ]),
  seq: z.number().int().positive(),
  eventId: z.string().min(1),
  sessionId: z.string().min(1),
  runId: z.string().min(1),
  occurredAt: z.string().refine((value) => Number.isFinite(Date.parse(value)), "Invalid date-time"),
  type: z.string().refine((value): value is AgentEventType => Object.hasOwn(agentEventPayloadSchemas, value), "Unknown event type"),
  authority: z.enum(["system", "developer", "user", "project", "runtime", "tool"]),
  payload: z.unknown()
}).strict();

const TOOL_EVIDENCE_KINDS: ReadonlySet<EvidenceRecord["kind"]> = new Set([
  "workspace_delta", "repository_delta", "command", "validation", "diagnostic", "input_access"
]);

function validEvidenceAuthority(event: AgentEventEnvelope, evidence: EvidenceRecord): boolean {
  if (event.type === "review.completed") {
    return event.authority === "runtime" && evidence.kind === "review"
      && evidence.producer.authority === "runtime";
  }
  if (event.type === "review.waived") {
    return event.authority === "user" && evidence.kind === "user_waiver"
      && evidence.producer.authority === "user";
  }
  if (event.type !== "evidence.recorded") return true;
  if (event.authority === "tool") {
    return evidence.producer.authority === "tool" && TOOL_EVIDENCE_KINDS.has(evidence.kind);
  }
  return event.authority === "runtime" && evidence.producer.authority === "runtime"
    && evidence.kind !== "review" && evidence.kind !== "user_waiver";
}

function accountingScopeIssue(event: AgentEventEnvelope): ProtocolValidationIssue | undefined {
  if (event.type === "session.created" && event.authority !== "runtime") {
    return {
      path: ["authority"],
      code: "invalid_authority",
      message: "Session creation requires runtime authority"
    };
  }
  if (event.type === "budget.limit_increased" && event.authority !== "user") {
    return { path: ["authority"], code: "invalid_authority", message: "Budget increases require user authority" };
  }
  if (["budget.reserved", "budget.reservation_bound", "budget.committed", "budget.released"].includes(event.type)
    && event.authority !== "runtime") {
    return { path: ["authority"], code: "invalid_authority", message: "Budget accounting requires runtime authority" };
  }
  return undefined;
}

function scopeIssues(event: AgentEventEnvelope): ProtocolValidationIssue[] {
  if (Number(event.schemaVersion) === LEGACY_EVENT_SCHEMA_VERSION_V5
    && event.type === "model.prompt_materialized") {
    return [{
      path: ["schemaVersion"],
      code: "invalid_schema_version",
      message: "model.prompt_materialized requires event schema V6"
    }];
  }
  const accountingIssue = accountingScopeIssue(event);
  if (accountingIssue) return [accountingIssue];
  if (event.type === "checkpoint.recovery_resolved" && event.authority !== "user") {
    return [{ path: ["authority"], code: "invalid_authority", message: "Checkpoint recovery requires user authority" }];
  }
  if (!["evidence.recorded", "review.completed", "review.waived"].includes(event.type)
    || !isEvidenceRecord(event.payload)) return [];
  if (event.payload.sessionId !== event.sessionId || event.payload.runId !== event.runId) {
    return [{ path: ["payload"], code: "invalid_scope", message: "Evidence scope must match its event envelope" }];
  }
  return validEvidenceAuthority(event, event.payload) ? [] : [{
    path: ["payload", "producer", "authority"],
    code: "invalid_authority",
    message: "Evidence authority is incompatible with this event"
  }];
}

export function validateAgentEventEnvelope(value: unknown): readonly ProtocolValidationIssue[] {
  const metadata = eventMetadataSchema.safeParse(value);
  if (!metadata.success) {
    return metadata.error.issues.map((issue) => ({
      path: issue.path.map((part) => typeof part === "symbol" ? String(part) : part),
      code: issue.code,
      message: issue.message
    }));
  }
  const event = metadata.data;
  const payload = agentEventPayloadSchemas[event.type].safeParse(event.payload);
  if (!payload.success) {
    return payload.error.issues.map((issue) => ({
      path: ["payload", ...issue.path.map((part) => typeof part === "symbol" ? String(part) : part)],
      code: issue.code,
      message: issue.message
    }));
  }
  return scopeIssues(event as AgentEventEnvelope);
}

export function isAgentEventEnvelope(value: unknown): value is AnyTypedAgentEvent {
  return validateAgentEventEnvelope(value).length === 0;
}

export function assertAgentEventEnvelope(value: unknown): asserts value is AnyTypedAgentEvent {
  const issues = validateAgentEventEnvelope(value);
  if (issues.length > 0) throw new AgentEventValidationError(issues);
}

export function isAgentEventOf<TType extends AgentEventType>(
  event: AgentEventEnvelope<unknown>,
  type: TType
): event is AgentEventOf<TType> {
  return event.type === type && isAgentEventPayload(type, event.payload);
}
