import { randomUUID } from "node:crypto";
import type { AgentEventEnvelope, ContextItem, JsonValue, RunMode, RunStore } from "agent-protocol";
import { assertKernelInvariants, createKernelState, evolve, type KernelState } from "agent-kernel";

export interface RestoredSessionData {
  workspacePath: string;
  mode: RunMode;
  state: KernelState;
  modelTurn: number;
  lastSeq: number;
  followUps: Array<{ id: string; text: string }>;
  writeScope: string[];
  strictWriteScope: boolean;
  contextItems: ContextItem[];
}

function createdData(event: AgentEventEnvelope | undefined): {
  workspacePath: string;
  mode: RunMode;
  writeScope: string[];
  strictWriteScope: boolean;
} | null {
  if (!event || event.type !== "session.created" || !event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) return null;
  const value = event.payload as Record<string, JsonValue>;
  return {
    workspacePath: typeof value.workspacePath === "string" ? value.workspacePath : ".",
    mode: value.mode === "analyze" ? "analyze" : "change",
    writeScope: Array.isArray(value.writeScope)
      ? value.writeScope.filter((item): item is string => typeof item === "string") : [],
    strictWriteScope: value.strictWriteScope === true
  };
}

function freshState(sessionId: string, event: AgentEventEnvelope, mode: RunMode, runDeadlineMs: number): KernelState {
  return createKernelState({
    sessionId,
    runId: event.runId || randomUUID(),
    mode,
    startedAt: event.occurredAt,
    deadlineAt: new Date(Date.now() + runDeadlineMs).toISOString()
  });
}

function nextRun(state: KernelState, event: AgentEventEnvelope, mode: RunMode, runDeadlineMs: number): KernelState {
  if (event.runId === state.runId || state.phase !== "terminal") return state;
  return {
    ...freshState(state.sessionId, event, mode, runDeadlineMs),
    messages: state.messages,
    lastSeq: state.lastSeq
  };
}

interface RestoreAccumulator {
  metadata: ReturnType<typeof createdData>;
  state: KernelState | undefined;
  modelTurn: number;
  lastSeq: number;
  followUps: Map<string, string>;
  contextItems: Map<string, ContextItem>;
}

function contextItem(value: JsonValue): ContextItem | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, JsonValue>;
  const authorities = ["system", "developer", "user", "project", "runtime", "tool"];
  if (typeof item.id !== "string" || typeof item.authority !== "string" || !authorities.includes(item.authority)
    || typeof item.provenance !== "string" || typeof item.content !== "string"
    || typeof item.tokenCount !== "number" || typeof item.priority !== "number") return null;
  return {
    id: item.id,
    authority: item.authority as ContextItem["authority"],
    provenance: item.provenance,
    content: item.content,
    tokenCount: item.tokenCount,
    priority: item.priority,
    ...(typeof item.cacheKey === "string" ? { cacheKey: item.cacheKey } : {})
  };
}

function trackContext(accumulator: RestoreAccumulator, event: AgentEventEnvelope): void {
  if (event.type !== "diagnostic" || !event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) return;
  const payload = event.payload as Record<string, JsonValue>;
  if (payload.kind !== "nested_instructions_loaded" || !Array.isArray(payload.items)) return;
  for (const value of payload.items) {
    const item = contextItem(value);
    if (item) accumulator.contextItems.set(item.id, item);
  }
}

function trackFollowUp(accumulator: RestoreAccumulator, event: AgentEventEnvelope): void {
  if (event.type !== "user.follow_up" || !event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) return;
  const payload = event.payload as Record<string, JsonValue>;
  if (typeof payload.queueId !== "string" || typeof payload.text !== "string") return;
  if (payload.status === "queued") accumulator.followUps.set(payload.queueId, payload.text);
  if (payload.status === "delivered") accumulator.followUps.delete(payload.queueId);
}

function validMessage(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const message = value as { role?: unknown; content?: unknown };
  return typeof message.content === "string"
    && typeof message.role === "string"
    && ["system", "developer", "user", "assistant", "tool"].includes(message.role);
}

function validPendingTool(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const pending = value as KernelState["pendingTools"][number];
  return Boolean(pending.request) && typeof pending.request.callId === "string"
    && typeof pending.request.name === "string" && typeof pending.started === "boolean"
    && ["not_required", "pending", "allowed", "denied"].includes(pending.approval);
}

function validSnapshotShape(state: KernelState, sessionId: string): boolean {
  const phases = ["idle", "ready_model", "model_in_flight", "tool_pending", "tool_in_flight", "needs_input", "outcome_pending", "terminal"];
  return [
    state.schemaVersion === 2, state.sessionId === sessionId, typeof state.runId === "string",
    state.mode === "analyze" || state.mode === "change", phases.includes(state.phase),
    Number.isInteger(state.revision), Number.isInteger(state.lastSeq), typeof state.deadlineAt === "string",
    Array.isArray(state.messages) && state.messages.every(validMessage),
    Array.isArray(state.pendingTools) && state.pendingTools.every(validPendingTool),
    Array.isArray(state.receipts), Array.isArray(state.evidence), Array.isArray(state.childIds)
  ].every(Boolean);
}

function snapshotState(snapshot: Awaited<ReturnType<RunStore["latestSnapshot"]>>, sessionId: string): KernelState | undefined {
  if (!snapshot?.state || typeof snapshot.state !== "object" || Array.isArray(snapshot.state)) return undefined;
  const state = snapshot.state as unknown as KernelState;
  if (!validSnapshotShape(state, sessionId)) return undefined;
  try {
    assertKernelInvariants(state);
    return state;
  } catch {
    return undefined;
  }
}

function initializeFromCreated(
  accumulator: RestoreAccumulator,
  event: AgentEventEnvelope,
  sessionId: string,
  runDeadlineMs: number
): void {
  if (accumulator.metadata || event.type !== "session.created") return;
  accumulator.metadata = createdData(event);
  if (!accumulator.state && accumulator.metadata) {
    accumulator.state = freshState(sessionId, event, accumulator.metadata.mode, runDeadlineMs);
  }
}

function countModelTurn(accumulator: RestoreAccumulator, event: AgentEventEnvelope): void {
  if (event.runId === accumulator.state?.runId && event.type === "model.started") accumulator.modelTurn += 1;
}

function replayEvent(
  accumulator: RestoreAccumulator,
  event: AgentEventEnvelope,
  snapshotSeq: number,
  runDeadlineMs: number
): void {
  accumulator.lastSeq = event.seq;
  trackFollowUp(accumulator, event);
  trackContext(accumulator, event);
  initializeFromCreated(accumulator, event, event.sessionId, runDeadlineMs);
  if (!accumulator.state || !accumulator.metadata || event.seq <= snapshotSeq) {
    countModelTurn(accumulator, event);
    return;
  }
  const previousRunId = accumulator.state.runId;
  accumulator.state = nextRun(accumulator.state, event, accumulator.metadata.mode, runDeadlineMs);
  if (accumulator.state.runId !== previousRunId) accumulator.modelTurn = 0;
  countModelTurn(accumulator, event);
  accumulator.state = evolve(accumulator.state, event);
}

export async function restoreStoredSession(store: RunStore, sessionId: string, runDeadlineMs: number): Promise<RestoredSessionData> {
  const snapshot = await store.latestSnapshot(sessionId);
  const restoredSnapshot = snapshotState(snapshot, sessionId);
  const accumulator: RestoreAccumulator = {
    metadata: null,
    state: restoredSnapshot,
    modelTurn: 0,
    lastSeq: 0,
    followUps: new Map(),
    contextItems: new Map()
  };
  for await (const event of store.events(sessionId)) {
    replayEvent(accumulator, event, restoredSnapshot ? snapshot?.seq ?? 0 : 0, runDeadlineMs);
  }
  if (!accumulator.metadata || !accumulator.state) throw new Error(`Session '${sessionId}' was not found.`);
  return {
    ...accumulator.metadata,
    state: accumulator.state,
    modelTurn: accumulator.modelTurn,
    lastSeq: accumulator.lastSeq,
    followUps: [...accumulator.followUps].map(([id, text]) => ({ id, text })),
    contextItems: [...accumulator.contextItems.values()]
  };
}
