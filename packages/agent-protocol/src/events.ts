import {
  isEvidenceRecord,
  type BudgetLedgerState,
  type CheckpointRef,
  type EvidenceRecord,
  type PlanGraph,
  type ReviewEvidence,
  type UsageRecord
} from "./domain.js";
import { isJsonValue, type JsonValue } from "./json.js";
import { EVENT_SCHEMA_VERSION, LEGACY_EVENT_SCHEMA_VERSION_V2 } from "./versions.js";
import { validV3Payload } from "./event-payload-validation.js";

export type ContextAuthority =
  | "system"
  | "developer"
  | "user"
  | "project"
  | "runtime"
  | "tool"
  | "external_verifier";

export const LEGACY_AGENT_EVENT_TYPES_V2 = [
  "session.created",
  "run.started",
  "run.suspended",
  "run.completed",
  "run.cancelled",
  "run.failed",
  "user.message",
  "user.steer",
  "user.follow_up",
  "model.started",
  "model.delta",
  "model.reasoning_delta",
  "model.completed",
  "model.failed",
  "tool.requested",
  "tool.approval_requested",
  "tool.approval_resolved",
  "tool.started",
  "tool.progress",
  "tool.completed",
  "tool.failed",
  "context.compacted",
  "child.spawned",
  "child.message",
  "child.completed",
  "diagnostic"
] as const;

export type LegacyAgentEventTypeV2 = typeof LEGACY_AGENT_EVENT_TYPES_V2[number];

export const AGENT_EVENT_TYPES = [
  ...LEGACY_AGENT_EVENT_TYPES_V2,
  "execution.planned",
  "execution.started",
  "execution.completed",
  "execution.failed",
  "process.spawned",
  "process.output",
  "process.exited",
  "process.lost",
  "evidence.recorded",
  "usage.recorded",
  "model.route_resolved",
  "model.route_failed",
  "profile.resolved",
  "customization.frozen",
  "skill.loaded",
  "hook.started",
  "hook.completed",
  "hook.failed",
  "plan.updated",
  "budget.reserved",
  "budget.reservation_bound",
  "budget.committed",
  "budget.released",
  "budget.exhausted",
  "budget.limit_increased",
  "checkpoint.created",
  "checkpoint.sealed",
  "checkpoint.restored",
  "checkpoint.recovery_resolved",
  "review.started",
  "review.completed",
  "review.waived"
] as const;

export type AgentEventType = typeof AGENT_EVENT_TYPES[number];

// Serialization is enforced at the event-log boundary and again while reading
// the store. Using `object` here lets domain interfaces participate without an
// artificial string index signature while required V3 fields remain checked.
type JsonPayload = Record<string, unknown>;

/**
 * Compile-time payload association for every durable event. Existing V2 event
 * payloads remain deliberately permissive while their producers migrate; all
 * newly introduced V3 authorities have explicit payload contracts.
 */
export interface AgentEventPayloadMap {
  "session.created": JsonPayload;
  "run.started": JsonPayload & { mode?: "analyze" | "change"; deadlineAt?: string };
  "run.suspended": JsonPayload & { requestId?: string; message?: string };
  "run.completed": JsonPayload & { message?: string; evidence?: EvidenceRecord[]; outcomeRevision?: number };
  "run.cancelled": JsonPayload & { reason?: string };
  "run.failed": JsonPayload & { kind?: string; code?: string; message?: string; resumeToken?: string };
  "user.message": JsonPayload & { text?: string };
  "user.steer": JsonPayload & { text?: string };
  "user.follow_up": JsonPayload & { text?: string; queueId?: string; status?: "queued" | "delivered" };
  "model.started": JsonPayload;
  "model.delta": JsonPayload & { delta?: string };
  "model.reasoning_delta": JsonPayload & { delta?: string };
  "model.completed": JsonPayload;
  "model.failed": JsonPayload & { code?: string; message?: string };
  "tool.requested": JsonPayload;
  "tool.approval_requested": JsonPayload;
  "tool.approval_resolved": JsonPayload;
  "tool.started": JsonPayload;
  "tool.progress": JsonPayload;
  "tool.completed": JsonPayload;
  "tool.failed": JsonPayload;
  "context.compacted": JsonPayload;
  "child.spawned": JsonPayload;
  "child.message": JsonPayload;
  "child.completed": JsonPayload;
  diagnostic: JsonPayload;
  "execution.planned": JsonPayload & { executionId: string; toolCallId: string; plan: unknown };
  "execution.started": JsonPayload & { executionId: string };
  "execution.completed": JsonPayload & { executionId: string; evidenceIds: string[] };
  "execution.failed": JsonPayload & { executionId: string; code: string; message: string };
  "process.spawned": JsonPayload & { processId: string; executionId: string; mode: "pipe" | "pty" | "background" };
  "process.output": JsonPayload & { processId: string; stream: "stdout" | "stderr"; chunk: string };
  "process.exited": JsonPayload & { processId: string; exitCode: number | null; signal?: string };
  "process.lost": JsonPayload & { processId: string; reason: string };
  "evidence.recorded": EvidenceRecord;
  "usage.recorded": UsageRecord;
  "model.route_resolved": JsonPayload & {
    role: string;
    routeId: string;
    modelSpecId: string;
    attempt: number;
    tokenizerAssetDigest?: string;
  };
  "model.route_failed": JsonPayload & {
    role: string;
    routeId: string;
    modelSpecId: string;
    attempt: number;
    category: string;
    semanticDelta: boolean;
  };
  "profile.resolved": JsonPayload & {
    profileId: string;
    digest: string;
    artifactId: string;
    source: "home" | "workspace" | "builtin";
  };
  "customization.frozen": JsonPayload & {
    digest: string;
    artifactId: string;
    skillCount: number;
    hookCount: number;
    profileCount?: number;
  };
  "skill.loaded": JsonPayload & {
    qualifiedName: string;
    digest: string;
    artifactId: string;
    source: "home" | "workspace" | "builtin";
    executionManifestArtifactId?: string;
    executionManifestDigest?: string;
  };
  "hook.started": JsonPayload & { hookId: string; event: string; required: boolean };
  "hook.completed": JsonPayload & {
    hookId: string;
    event: string;
    required: boolean;
    durationMs: number;
    outcome: unknown;
  };
  "hook.failed": JsonPayload & {
    hookId: string;
    event: string;
    required: boolean;
    durationMs: number;
    outcome: unknown;
  };
  "plan.updated": { plan: PlanGraph; previousRevision: number };
  "budget.reserved": { ledger: BudgetLedgerState; reservationId: string };
  "budget.reservation_bound": { ledger: BudgetLedgerState; reservationId: string; ownerId: string };
  "budget.committed": { ledger: BudgetLedgerState; reservationId: string };
  "budget.released": { ledger: BudgetLedgerState; reservationId: string };
  "budget.exhausted": JsonPayload & { dimension: string; requested: number; available: number };
  "budget.limit_increased": JsonPayload & { ledger: BudgetLedgerState };
  "checkpoint.created": CheckpointRef;
  "checkpoint.sealed": CheckpointRef;
  "checkpoint.restored": CheckpointRef;
  "checkpoint.recovery_resolved": JsonPayload & {
    checkpointId: string;
    decision: "restore" | "keep";
    sourceSessionId?: string;
    childId?: string;
  };
  "review.started": JsonPayload & { reviewerId: string; workspaceDeltaEvidenceIds: string[] };
  "review.completed": ReviewEvidence;
  "review.waived": EvidenceRecord;
}

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

export interface LegacyAgentEventEnvelopeV2<TPayload extends JsonValue = JsonValue> {
  schemaVersion: typeof LEGACY_EVENT_SCHEMA_VERSION_V2;
  seq: number;
  eventId: string;
  sessionId: string;
  runId: string;
  occurredAt: string;
  type: LegacyAgentEventTypeV2;
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

const SOLVER_AUTHORITIES: ReadonlyArray<Exclude<ContextAuthority, "external_verifier">> = [
  "system", "developer", "user", "project", "runtime", "tool"
];

function validMetadata(event: Record<string, unknown>, types: readonly string[]): boolean {
  const validDate = typeof event.occurredAt === "string" && Number.isFinite(Date.parse(event.occurredAt));
  return validDate && typeof event.type === "string" && types.includes(event.type)
    && typeof event.authority === "string" && SOLVER_AUTHORITIES.includes(event.authority as Exclude<ContextAuthority, "external_verifier">);
}

function eventRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

const TOOL_EVIDENCE_KINDS: ReadonlySet<EvidenceRecord["kind"]> = new Set([
  "workspace_delta", "command", "validation", "diagnostic"
]);

function validReviewEvent(event: Record<string, unknown>, evidence: EvidenceRecord): boolean {
  return event.authority === "runtime" && evidence.kind === "review" && evidence.producer.authority === "runtime";
}

function validWaiverEvent(event: Record<string, unknown>, evidence: EvidenceRecord): boolean {
  return event.authority === "user" && evidence.kind === "user_waiver" && evidence.producer.authority === "user";
}

function validRecordedEvidence(event: Record<string, unknown>, evidence: EvidenceRecord): boolean {
  if (event.authority === "tool") {
    return evidence.producer.authority === "tool" && TOOL_EVIDENCE_KINDS.has(evidence.kind);
  }
  return event.authority === "runtime" && evidence.producer.authority === "runtime"
    && evidence.kind !== "review" && evidence.kind !== "user_waiver";
}

const EVIDENCE_EVENT_VALIDATORS: Record<string, (event: Record<string, unknown>, evidence: EvidenceRecord) => boolean> = {
  "evidence.recorded": validRecordedEvidence,
  "review.completed": validReviewEvent,
  "review.waived": validWaiverEvent
};

function validEvidenceEventScope(event: Record<string, unknown>): boolean {
  if (event.type === "checkpoint.recovery_resolved") return event.authority === "user";
  if (event.type === "budget.limit_increased") return event.authority === "user";
  const validator = EVIDENCE_EVENT_VALIDATORS[String(event.type)];
  if (!validator) return true;
  if (!isEvidenceRecord(event.payload)) return false;
  const evidence = event.payload;
  const scoped = evidence.sessionId === event.sessionId && evidence.runId === event.runId;
  return scoped && validator(event, evidence);
}

export function isAgentEventEnvelope(value: unknown): value is AnyTypedAgentEvent {
  const event = eventRecord(value);
  if (!event || event.schemaVersion !== EVENT_SCHEMA_VERSION || !Number.isInteger(event.seq) || Number(event.seq) < 1
    || !validIdentity(event) || !validMetadata(event, AGENT_EVENT_TYPES)) return false;
  return validV3Payload(event.type as AgentEventType, event.payload) && validEvidenceEventScope(event);
}

export function assertAgentEventEnvelope(value: unknown): asserts value is AnyTypedAgentEvent {
  if (!isAgentEventEnvelope(value)) throw new Error("Invalid AgentEventEnvelope V3.");
}

export function isLegacyAgentEventEnvelopeV2(value: unknown): value is LegacyAgentEventEnvelopeV2 {
  const event = eventRecord(value);
  return Boolean(event && event.schemaVersion === LEGACY_EVENT_SCHEMA_VERSION_V2
    && Number.isInteger(event.seq) && Number(event.seq) >= 1
    && validIdentity(event) && validMetadata(event, LEGACY_AGENT_EVENT_TYPES_V2) && isJsonValue(event.payload));
}

export function assertLegacyAgentEventEnvelopeV2(value: unknown): asserts value is LegacyAgentEventEnvelopeV2 {
  if (!isLegacyAgentEventEnvelopeV2(value)) throw new Error("Invalid AgentEventEnvelope V2.");
}

export function upcastAgentEventV2(event: LegacyAgentEventEnvelopeV2): AnyTypedAgentEvent {
  assertLegacyAgentEventEnvelopeV2(event);
  if (event.type !== "run.completed") {
    return { ...event, schemaVersion: EVENT_SCHEMA_VERSION } as AnyTypedAgentEvent;
  }
  const payload = event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
    ? event.payload : {};
  return {
    ...event,
    schemaVersion: EVENT_SCHEMA_VERSION,
    payload: { ...payload, evidence: [], outcomeRevision: event.seq - 1, migratedFromV2: true }
  } as AgentEventOf<"run.completed">;
}

export function isAgentEventOf<TType extends AgentEventType>(
  event: AgentEventEnvelope<unknown>,
  type: TType
): event is AgentEventOf<TType> {
  return event.type === type && validV3Payload(type, event.payload);
}
