import { createHash, type Hash } from "node:crypto";
import type {
  AgentEventEnvelope,
  JsonValue,
  LegacyAgentEventEnvelopeV2,
  SnapshotEnvelope
} from "agent-protocol";

type MigratableEvent = AgentEventEnvelope | LegacyAgentEventEnvelopeV2;

export interface MigrationPendingApproval {
  requestId: string;
  callId: string;
  toolName: string;
  reason: string;
  effects: string[];
  argumentsDigest: string;
}

export interface MigrationSemanticProjection {
  schemaVersion: 1;
  sessionId: string;
  eventCount: number;
  lastSeq: number;
  phase: "idle" | "running" | "needs_input" | "terminal";
  outcome: JsonValue;
  transcriptEntries: number;
  transcriptDigest: string;
  pendingApprovals: MigrationPendingApproval[];
  runBoundaryCount: number;
  runBoundariesDigest: string;
  semanticDigest: string;
}

interface ActiveAssistant {
  key: string;
  hash: Hash;
  length: number;
}

interface SemanticAccumulator {
  sessionId: string;
  eventCount: number;
  lastSeq: number;
  phase: MigrationSemanticProjection["phase"];
  outcome: JsonValue;
  transcript: Hash;
  transcriptEntries: number;
  activeAssistant?: ActiveAssistant;
  pendingApprovals: Map<string, MigrationPendingApproval>;
  runBoundaries: Hash;
  runBoundaryCount: number;
}

function text(value: JsonValue | undefined): string {
  return typeof value === "string" ? value : "";
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function payload(event: MigratableEvent): Record<string, JsonValue> {
  return event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
    ? event.payload as Record<string, JsonValue> : {};
}

function canonical(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const fields = Object.entries(value).sort(([left], [right]) => compareText(left, right));
  return `{${fields.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function appendHashedRecord(hash: Hash, value: JsonValue): void {
  hash.update(canonical(value));
  hash.update("\n");
}

function assistantKey(event: MigratableEvent, data: Record<string, JsonValue>): string {
  const turn = typeof data.turnId === "number" || typeof data.turnId === "string" ? String(data.turnId) : "default";
  return `${event.runId}\0${turn}`;
}

function flushAssistant(state: SemanticAccumulator): boolean {
  const active = state.activeAssistant;
  if (!active) return false;
  appendHashedRecord(state.transcript, {
    role: "assistant",
    textDigest: active.hash.digest("hex"),
    textLength: active.length
  });
  state.transcriptEntries += 1;
  state.activeAssistant = undefined;
  return true;
}

function appendTranscript(state: SemanticAccumulator, role: "user" | "assistant", value: string, delivery?: string): void {
  flushAssistant(state);
  appendHashedRecord(state.transcript, {
    role,
    ...(delivery ? { delivery } : {}),
    textDigest: digest(value),
    textLength: value.length
  });
  state.transcriptEntries += 1;
}

function completionText(data: Record<string, JsonValue>): string {
  if (typeof data.text === "string") return data.text;
  const message = data.message;
  if (!message || typeof message !== "object" || Array.isArray(message)) return "";
  return text((message as Record<string, JsonValue>).content);
}

function projectUserTranscript(
  state: SemanticAccumulator,
  event: MigratableEvent,
  data: Record<string, JsonValue>
): boolean {
  if (event.type === "user.message" || event.type === "user.steer") {
    appendTranscript(state, "user", text(data.text), event.type === "user.steer" ? "steer" : "submit");
    return true;
  }
  if (event.type === "user.follow_up" && data.status !== "queued") {
    appendTranscript(state, "user", text(data.text), "follow_up");
    return true;
  }
  return false;
}

function projectTranscript(state: SemanticAccumulator, event: MigratableEvent, data: Record<string, JsonValue>): void {
  if (projectUserTranscript(state, event, data)) return;
  if (event.type === "model.delta") {
    const key = assistantKey(event, data);
    if (state.activeAssistant?.key !== key) {
      flushAssistant(state);
      state.activeAssistant = { key, hash: createHash("sha256"), length: 0 };
    }
    const delta = text(data.delta);
    state.activeAssistant!.hash.update(delta);
    state.activeAssistant!.length += delta.length;
    return;
  }
  if (event.type === "model.completed") {
    const streamed = state.activeAssistant?.key === assistantKey(event, data) && flushAssistant(state);
    const completed = completionText(data);
    if (!streamed && completed) appendTranscript(state, "assistant", completed);
    return;
  }
  if (event.type === "run.suspended" && text(data.message).trim()) {
    appendTranscript(state, "assistant", text(data.message));
  }
}

function approvalKey(event: MigratableEvent, data: Record<string, JsonValue>): string {
  return text(data.requestId) || text(data.callId) || `$event:${event.eventId}`;
}

function projectApproval(state: SemanticAccumulator, event: MigratableEvent, data: Record<string, JsonValue>): void {
  if (event.type === "tool.approval_requested") {
    const requestId = approvalKey(event, data);
    state.pendingApprovals.set(requestId, {
      requestId,
      callId: text(data.callId) || requestId,
      toolName: text(data.toolName),
      reason: text(data.reason),
      effects: Array.isArray(data.effects)
        ? data.effects.filter((item): item is string => typeof item === "string").sort() : [],
      argumentsDigest: digest(canonical(data.arguments ?? null))
    });
    state.phase = "needs_input";
  }
  if (event.type === "tool.approval_resolved") {
    state.pendingApprovals.delete(approvalKey(event, data));
    state.phase = state.pendingApprovals.size > 0 ? "needs_input" : "running";
    if (state.phase === "running" && state.outcome && typeof state.outcome === "object") state.outcome = null;
  }
}

function completedOutcome(data: Record<string, JsonValue>): JsonValue {
  return { kind: "completed", message: text(data.message) };
}

function failedOutcome(data: Record<string, JsonValue>): JsonValue {
  return {
    kind: data.kind === "recoverable_failure" ? "recoverable_failure" : "fatal",
    code: text(data.code) || "runtime_error",
    message: text(data.message),
    ...(typeof data.resumeToken === "string" ? { resumeToken: data.resumeToken } : {})
  };
}

function boundaryOutcome(event: MigratableEvent, data: Record<string, JsonValue>): JsonValue {
  if (event.type === "run.suspended") {
    return { kind: "needs_input", requestId: text(data.requestId), message: text(data.message) };
  }
  if (event.type === "run.completed") return completedOutcome(data);
  if (event.type === "run.cancelled") return { kind: "cancelled", reason: text(data.reason) || "cancelled" };
  if (event.type === "run.failed") return failedOutcome(data);
  return null;
}

function projectBoundary(state: SemanticAccumulator, event: MigratableEvent, data: Record<string, JsonValue>): void {
  const boundary = event.type === "run.started" || event.type === "run.suspended" || event.type === "run.completed"
    || event.type === "run.cancelled" || event.type === "run.failed";
  if (!boundary) return;
  const outcome = boundaryOutcome(event, data);
  appendHashedRecord(state.runBoundaries, {
    runId: event.runId,
    type: event.type,
    ...(event.type === "run.started" ? { mode: text(data.mode) } : {}),
    ...(outcome === null ? {} : { outcome })
  });
  state.runBoundaryCount += 1;
  if (event.type === "run.started") {
    state.phase = "running";
    state.outcome = null;
    state.pendingApprovals.clear();
  } else if (event.type === "run.suspended") {
    state.phase = "needs_input";
    state.outcome = outcome;
  } else {
    state.phase = "terminal";
    state.outcome = outcome;
    state.pendingApprovals.clear();
  }
}

function projectEvent(state: SemanticAccumulator, event: MigratableEvent): void {
  if (event.sessionId !== state.sessionId) throw new Error(`Migration replay session mismatch at seq ${event.seq}.`);
  if (event.seq !== state.lastSeq + 1) {
    throw new Error(`Migration replay sequence discontinuity: expected ${state.lastSeq + 1}, actual ${event.seq}.`);
  }
  state.eventCount += 1;
  state.lastSeq = event.seq;
  const data = payload(event);
  projectTranscript(state, event, data);
  projectApproval(state, event, data);
  projectBoundary(state, event, data);
  if (event.type === "user.message" || event.type === "user.steer"
    || (event.type === "user.follow_up" && data.status !== "queued")) {
    state.phase = "running";
    state.outcome = null;
  }
}

/** A bounded, stream-derived projection of the V2/V3 semantics migration must preserve. */
export async function projectMigrationSemantics(
  sessionId: string,
  events: AsyncIterable<MigratableEvent>
): Promise<MigrationSemanticProjection> {
  const state: SemanticAccumulator = {
    sessionId,
    eventCount: 0,
    lastSeq: 0,
    phase: "idle",
    outcome: null,
    transcript: createHash("sha256"),
    transcriptEntries: 0,
    pendingApprovals: new Map(),
    runBoundaries: createHash("sha256"),
    runBoundaryCount: 0
  };
  for await (const event of events) projectEvent(state, event);
  flushAssistant(state);
  const projected = {
    schemaVersion: 1 as const,
    sessionId,
    eventCount: state.eventCount,
    lastSeq: state.lastSeq,
    phase: state.phase,
    outcome: state.outcome,
    transcriptEntries: state.transcriptEntries,
    transcriptDigest: state.transcript.digest("hex"),
    pendingApprovals: [...state.pendingApprovals.values()].sort((left, right) => compareText(left.requestId, right.requestId)),
    runBoundaryCount: state.runBoundaryCount,
    runBoundariesDigest: state.runBoundaries.digest("hex")
  };
  return { ...projected, semanticDigest: digest(canonical(projected)) };
}

export function assertMigrationSemanticEquivalence(
  source: MigrationSemanticProjection,
  target: MigrationSemanticProjection
): void {
  const fields: Array<keyof MigrationSemanticProjection> = [
    "sessionId", "eventCount", "lastSeq", "phase", "outcome", "transcriptEntries", "transcriptDigest",
    "pendingApprovals", "runBoundaryCount", "runBoundariesDigest", "semanticDigest"
  ];
  const mismatch = fields.find((field) => canonical(source[field] as JsonValue) !== canonical(target[field] as JsonValue));
  if (mismatch) throw new Error(`V2/V3 migration semantic mismatch in '${mismatch}'.`);
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function replayPhase(value: string): MigrationSemanticProjection["phase"] {
  if (value === "terminal" || value === "needs_input" || value === "idle") return value;
  return "running";
}

function replayOutcome(value: unknown): JsonValue {
  const item = record(value);
  if (!item || typeof item.kind !== "string") return null;
  if (item.kind === "completed") {
    return { kind: "completed", message: typeof item.message === "string" ? item.message : "" };
  }
  if (item.kind === "needs_input") {
    return {
      kind: "needs_input",
      requestId: typeof item.requestId === "string" ? item.requestId : "",
      message: typeof item.message === "string" ? item.message : ""
    };
  }
  if (item.kind === "cancelled") {
    return { kind: "cancelled", reason: typeof item.reason === "string" ? item.reason : "cancelled" };
  }
  return {
    kind: item.kind === "recoverable_failure" ? "recoverable_failure" : "fatal",
    code: typeof item.code === "string" ? item.code : "runtime_error",
    message: typeof item.message === "string" ? item.message : "",
    ...(typeof item.resumeToken === "string" ? { resumeToken: item.resumeToken } : {})
  };
}

function replayPendingApprovals(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.flatMap((candidate) => {
    const item = record(candidate);
    const request = record(item?.request);
    return item?.approval === "pending" && typeof request?.callId === "string" ? [request.callId] : [];
  }).sort(compareText);
}

/** Cross-check a kernel-aware replay snapshot when the supplied replayer exposes kernel state. */
export function assertMigrationReplaySnapshot(
  projection: MigrationSemanticProjection,
  snapshot: SnapshotEnvelope
): void {
  const state = record(snapshot.state);
  if (!state || typeof state.phase !== "string") return;
  if (replayPhase(state.phase) !== projection.phase) {
    throw new Error("V2/V3 migration semantic mismatch in replayed 'phase'.");
  }
  if (canonical(replayOutcome(state.outcome)) !== canonical(projection.outcome)) {
    throw new Error("V2/V3 migration semantic mismatch in replayed 'outcome'.");
  }
  const pending = replayPendingApprovals(state.pendingTools);
  if (pending && canonical(pending) !== canonical(projection.pendingApprovals.map((item) => item.requestId).sort(compareText))) {
    throw new Error("V2/V3 migration semantic mismatch in replayed 'pendingApprovals'.");
  }
}
