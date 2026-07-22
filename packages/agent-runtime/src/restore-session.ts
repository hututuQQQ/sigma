import { randomUUID } from "node:crypto";
import {
  SNAPSHOT_SCHEMA_VERSION,
  STORE_LAYOUT_VERSION,
  createBudgetLedger,
  type AgentEventEnvelope,
  type BudgetLimits,
  type ContextItem,
  type JsonValue,
  type ModelExecutionRole,
  type RunMode,
  type RunStore,
  type SnapshotEnvelope,
  type ToolCallPlan,
  type ToolEffect
} from "agent-protocol";
import {
  assertKernelInvariants,
  createKernelState,
  evolve,
  isCompletionRepairState,
  isKernelState,
  isSemanticFailureCluster,
  isSemanticProgressWatermark,
  type KernelState
} from "agent-kernel";
import { jsonValue } from "./json.js";
import {
  createdSessionMetadata,
  type RestoredSessionMetadata
} from "./restore-session-metadata.js";
import {
  approvalEffectsForPlan,
  createApprovalBinding,
  parseToolCallPlan,
  parseToolEffects,
  type ApprovalBinding,
  type RecoveredApprovalMetadata
} from "./approval-binding.js";

export interface RestoredSessionData {
  workspacePath: string;
  parentSessionId?: string;
  mode: RunMode;
  state: KernelState;
  modelTurn: number;
  lastSeq: number;
  followUps: Array<{ id: string; text: string }>;
  writeScope: string[];
  strictWriteScope: boolean;
  modelRole: ModelExecutionRole;
  contextItems: ContextItem[];
  pendingApprovals: Array<RecoveredApprovalMetadata & { callId: string }>;
}

function freshState(
  sessionId: string,
  event: AgentEventEnvelope,
  mode: RunMode,
  runDeadlineMs: number,
  budgetLimits?: BudgetLimits
): KernelState {
  const state = createKernelState({
    sessionId,
    runId: event.runId || randomUUID(),
    mode,
    startedAt: event.occurredAt,
    deadlineAt: new Date(Date.now() + runDeadlineMs).toISOString()
  });
  if (budgetLimits) state.budget = createBudgetLedger(budgetLimits);
  return state;
}

function eventRunMode(event: AgentEventEnvelope, fallback: RunMode): RunMode {
  if (event.type !== "run.started" || !event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) return fallback;
  const mode = (event.payload as Record<string, JsonValue>).mode;
  return mode === "analyze" || mode === "change" ? mode : fallback;
}

function nextRun(state: KernelState, event: AgentEventEnvelope, runDeadlineMs: number): KernelState {
  if (event.runId === state.runId || state.phase !== "terminal" || event.type !== "run.started") return state;
  return {
    ...freshState(state.sessionId, event, eventRunMode(event, state.mode), runDeadlineMs),
    messages: state.messages,
    lastSeq: state.lastSeq,
    plan: state.plan,
    budget: state.budget,
    frozenProfile: state.frozenProfile,
    frozenCustomization: state.frozenCustomization,
    frozenSkills: state.frozenSkills,
    activeProcessIds: state.activeProcessIds,
    mutationEvidence: state.mutationEvidence,
    usage: state.usage
  };
}

interface RestoreAccumulator {
  metadata: RestoredSessionMetadata | null;
  state: KernelState | undefined;
  modelTurn: number;
  lastSeq: number;
  followUps: Map<string, string>;
  contextItems: Map<string, ContextItem>;
  executionPlans: Map<string, ToolCallPlan>;
  pendingApprovals: Map<string, RecoveredApprovalMetadata>;
}

function approvalKey(runId: string, callId: string): string {
  return `${runId}\0${callId}`;
}

function payloadRecord(event: AgentEventEnvelope): Record<string, unknown> | null {
  return event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
    ? event.payload as Record<string, unknown>
    : null;
}

function recoveredBinding(
  event: AgentEventEnvelope,
  callId: string,
  toolName: string,
  argumentsValue: JsonValue,
  plan: ToolCallPlan,
  effects: ToolEffect[]
): ApprovalBinding | undefined {
  try {
    return createApprovalBinding(event.sessionId, event.runId, {
      id: callId,
      name: toolName,
      arguments: argumentsValue
    }, plan, effects);
  } catch {
    return undefined;
  }
}

function recoveredBindingFromPayload(
  event: AgentEventEnvelope,
  payload: Record<string, unknown>,
  callId: string,
  plan: ToolCallPlan | undefined,
  effects: ToolEffect[]
): ApprovalBinding | undefined {
  if (!plan || typeof payload.toolName !== "string"
    || !Object.prototype.hasOwnProperty.call(payload, "arguments")) return undefined;
  return recoveredBinding(
    event, callId, payload.toolName, payload.arguments as JsonValue, plan, effects
  );
}

function trackApprovalAuthority(accumulator: RestoreAccumulator, event: AgentEventEnvelope): void {
  if (event.authority !== "runtime") return;
  const payload = payloadRecord(event);
  if (!payload) return;
  if (event.type === "execution.planned") {
    if (typeof payload.toolCallId !== "string") return;
    const plan = parseToolCallPlan(payload.plan);
    if (plan) accumulator.executionPlans.set(approvalKey(event.runId, payload.toolCallId), plan);
    return;
  }
  if (event.type !== "tool.approval_requested" || payload.delegated === true) return;
  const callId = typeof payload.callId === "string"
    ? payload.callId
    : typeof payload.requestId === "string" ? payload.requestId : undefined;
  if (!callId) return;
  const key = approvalKey(event.runId, callId);
  const plan = parseToolCallPlan(payload.plan) ?? accumulator.executionPlans.get(key);
  const effects = parseToolEffects(payload.effects) ?? (plan ? approvalEffectsForPlan(plan) : []);
  const binding = recoveredBindingFromPayload(event, payload, callId, plan, effects);
  accumulator.pendingApprovals.set(key, {
    effects,
    ...(binding ? { binding } : {})
  });
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

function validSnapshotShape(state: KernelState, sessionId: string): boolean {
  return isKernelState(state) && state.sessionId === sessionId;
}

function restoredSemanticState(stored: Partial<KernelState>): Pick<
  KernelState,
  "semanticProgress" | "semanticFailureCluster"
> {
  return {
    semanticProgress: isSemanticProgressWatermark(stored.semanticProgress)
      ? stored.semanticProgress
      : { workspaceChanges: 0, durableEvidence: 0, revision: 0 },
    semanticFailureCluster: isSemanticFailureCluster(stored.semanticFailureCluster)
      ? stored.semanticFailureCluster : undefined
  };
}

function restoredCompletionRepairState(stored: Partial<KernelState>): Pick<
  KernelState,
  "completionRepairAttempts" | "completionRepair"
> | null {
  const completionRepairAttempts = Number.isInteger(stored.completionRepairAttempts)
    ? Number(stored.completionRepairAttempts)
    : 0;
  const repair = stored.completionRepair;
  if (repair !== undefined && !isCompletionRepairState(repair)) return null;
  if (completionRepairAttempts > 0 && !isCompletionRepairState(repair)) return null;
  return {
    completionRepairAttempts,
    completionRepair: isCompletionRepairState(repair) ? repair : undefined
  };
}

function snapshotState(snapshot: Awaited<ReturnType<RunStore["latestSnapshot"]>>, sessionId: string): KernelState | undefined {
  if (!snapshot?.state || typeof snapshot.state !== "object" || Array.isArray(snapshot.state)) return undefined;
  const stored = snapshot.state as unknown as Partial<KernelState>;
  const completionRepair = restoredCompletionRepairState(stored);
  if (!completionRepair) return undefined;
  const state = {
    ...stored,
    toolCallIds: Array.isArray(stored.toolCallIds)
      ? stored.toolCallIds
      : [...new Set([...(stored.receipts ?? []).map((receipt) => receipt.callId),
        ...(stored.pendingTools ?? []).map((pending) => pending.request.callId)])],
    activeProcessIds: Array.isArray(stored.activeProcessIds) ? stored.activeProcessIds : [],
    ...restoredSemanticState(stored),
    ...completionRepair,
    continuationAttempts: Number.isInteger(stored.continuationAttempts) ? stored.continuationAttempts : 0,
    repeatedToolBatchCount: Number.isInteger(stored.repeatedToolBatchCount) ? stored.repeatedToolBatchCount : 0,
    receiptCountAtLastUserInput: Number.isInteger(stored.receiptCountAtLastUserInput)
      ? stored.receiptCountAtLastUserInput : 0
  } as KernelState;
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
  accumulator.metadata = createdSessionMetadata(event);
  if (!accumulator.state && accumulator.metadata) {
    accumulator.state = freshState(
      sessionId,
      event,
      accumulator.metadata.mode,
      runDeadlineMs,
      accumulator.metadata.budgetLimits
    );
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
  trackApprovalAuthority(accumulator, event);
  initializeFromCreated(accumulator, event, event.sessionId, runDeadlineMs);
  if (!accumulator.state || !accumulator.metadata || event.seq <= snapshotSeq) {
    countModelTurn(accumulator, event);
    return;
  }
  const previousRunId = accumulator.state.runId;
  accumulator.state = nextRun(accumulator.state, event, runDeadlineMs);
  if (accumulator.state.runId !== previousRunId) accumulator.modelTurn = 0;
  countModelTurn(accumulator, event);
  accumulator.state = evolve(accumulator.state, event);
}

function emptyAccumulator(state?: KernelState): RestoreAccumulator {
  return {
    metadata: null,
    state,
    modelTurn: 0,
    lastSeq: 0,
    followUps: new Map(),
    contextItems: new Map(),
    executionPlans: new Map(),
    pendingApprovals: new Map()
  };
}

export interface SnapshotRebuildInput {
  sessionId: string;
  lastSeq: number;
  events(): AsyncIterable<AgentEventEnvelope>;
}

/** Replays the durable event log through the kernel to rebuild a V5 snapshot. */
export async function rebuildSnapshotFromEvents(
  input: SnapshotRebuildInput,
  runDeadlineMs = 30 * 60 * 1_000
): Promise<SnapshotEnvelope> {
  const accumulator = emptyAccumulator();
  for await (const event of input.events()) replayEvent(accumulator, event, 0, runDeadlineMs);
  if (!accumulator.metadata || !accumulator.state || accumulator.lastSeq !== input.lastSeq) {
    throw new Error(`Session '${input.sessionId}' did not replay to seq ${input.lastSeq}.`);
  }
  assertKernelInvariants(accumulator.state);
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    storeLayoutVersion: STORE_LAYOUT_VERSION,
    sessionId: input.sessionId,
    seq: input.lastSeq,
    createdAt: new Date().toISOString(),
    state: jsonValue({ ...accumulator.state, lastSeq: input.lastSeq })
  };
}

export async function restoreStoredSession(store: RunStore, sessionId: string, runDeadlineMs: number): Promise<RestoredSessionData> {
  const snapshot = await store.latestSnapshot(sessionId);
  const restoredSnapshot = snapshotState(snapshot, sessionId);
  const accumulator = emptyAccumulator(restoredSnapshot);
  for await (const event of store.events(sessionId)) {
    replayEvent(accumulator, event, restoredSnapshot ? snapshot?.seq ?? 0 : 0, runDeadlineMs);
  }
  if (!accumulator.metadata || !accumulator.state) throw new Error(`Session '${sessionId}' was not found.`);
  const pendingApprovals = accumulator.state.pendingTools
    .filter((item) => item.approval === "pending")
    .map((item) => {
      const recovered = accumulator.pendingApprovals.get(
        approvalKey(accumulator.state!.runId, item.request.callId)
      );
      return {
        callId: item.request.callId,
        effects: recovered?.effects ?? [],
        ...(recovered?.binding ? { binding: recovered.binding } : {})
      };
    });
  return {
    ...accumulator.metadata,
    mode: accumulator.state.mode,
    state: accumulator.state,
    modelTurn: accumulator.modelTurn,
    lastSeq: accumulator.lastSeq,
    followUps: [...accumulator.followUps].map(([id, text]) => ({ id, text })),
    contextItems: [...accumulator.contextItems.values()],
    pendingApprovals
  };
}
