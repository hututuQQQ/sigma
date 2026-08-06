import { randomUUID } from "node:crypto";
import {
  KERNEL_STATE_VERSION,
  SNAPSHOT_SCHEMA_VERSION,
  createBudgetLedger,
  type AgentEventEnvelope,
  type AssuranceResourcePolicy,
  type BudgetLimits,
  type ContextItem,
  type JsonValue,
  type ModelImage,
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
  isKernelState,
  type KernelState
} from "agent-kernel";
import { jsonValue } from "./json.js";
import {
  createdSessionMetadata,
  type RestoredSessionMetadata
} from "./restore-session-metadata.js";
import {
  createApprovalBinding,
  parseToolCallPlan,
  parseToolEffects,
  type ApprovalBinding,
  type RecoveredApprovalMetadata
} from "./approval-binding.js";
import { assurancePolicyFromState } from "./assurance-policy.js";
import { configuredRunDeadlineAt } from "./run-deadline.js";

export interface RestoredSessionData {
  workspacePath: string;
  parentSessionId?: string;
  mode: RunMode;
  state: KernelState;
  modelTurn: number;
  lastSeq: number;
  followUps: Array<{ id: string; text: string; images?: ModelImage[] }>;
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
  runDeadlineMs: number | undefined,
  budgetLimits?: BudgetLimits,
  assurancePolicy?: AssuranceResourcePolicy
): KernelState {
  const state = createKernelState({
    sessionId,
    runId: event.runId || randomUUID(),
    mode,
    startedAt: event.occurredAt,
    deadlineAt: configuredRunDeadlineAt(runDeadlineMs),
    ...(assurancePolicy ? { assurancePolicy } : {})
  });
  if (budgetLimits) state.budget = createBudgetLedger(budgetLimits);
  return state;
}

function eventRunMode(event: AgentEventEnvelope, fallback: RunMode): RunMode {
  if (event.type !== "run.started" || !event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) return fallback;
  const mode = (event.payload as Record<string, JsonValue>).mode;
  return mode === "analyze" || mode === "change" ? mode : fallback;
}

function nextRun(state: KernelState, event: AgentEventEnvelope, runDeadlineMs: number | undefined): KernelState {
  if (event.runId === state.runId || event.type !== "run.started") return state;
  return {
    ...freshState(
      state.sessionId,
      event,
      eventRunMode(event, state.mode),
      runDeadlineMs,
      undefined,
      assurancePolicyFromState(state)
    ),
    messages: state.messages,
    lastSeq: state.lastSeq,
    plan: state.plan,
    budget: state.budget,
    frozenProfile: state.frozenProfile,
    frozenCustomization: state.frozenCustomization,
    harnessRequired: state.harnessRequired,
    frozenHarness: state.frozenHarness,
    loadedToolBundles: state.loadedToolBundles,
    frozenSkills: state.frozenSkills,
    activeProcessIds: state.activeProcessIds,
    mutationEvidence: state.mutationEvidence,
    usage: state.usage,
    contextArchive: state.contextArchive
  };
}

interface RestoreAccumulator {
  metadata: RestoredSessionMetadata | null;
  state: KernelState | undefined;
  modelTurn: number;
  lastSeq: number;
  followUps: Map<string, { text: string; images?: ModelImage[] }>;
  contextItems: Map<string, ContextItem>;
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
): ApprovalBinding {
  return createApprovalBinding(event.sessionId, event.runId, {
    id: callId,
    name: toolName,
    arguments: argumentsValue
  }, plan, effects);
}

function trackApprovalAuthority(accumulator: RestoreAccumulator, event: AgentEventEnvelope): void {
  if (event.authority !== "runtime") return;
  const payload = payloadRecord(event);
  if (!payload) return;
  if (event.type !== "tool.approval_requested" || payload.delegated === true) return;
  const callId = typeof payload.callId === "string" ? payload.callId : undefined;
  const plan = parseToolCallPlan(payload.plan);
  const effects = parseToolEffects(payload.effects);
  if (!callId || !plan || !effects || typeof payload.toolName !== "string"
    || !Object.prototype.hasOwnProperty.call(payload, "arguments")) {
    throw Object.assign(new Error(
      `Session '${event.sessionId}' contains an incomplete schema 1 approval event at seq ${event.seq}.`
    ), { code: "unsupported_schema_version" });
  }
  const key = approvalKey(event.runId, callId);
  accumulator.pendingApprovals.set(key, {
    effects,
    binding: recoveredBinding(
      event, callId, payload.toolName, payload.arguments as JsonValue, plan, effects
    )
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
  const images = Array.isArray(payload.images)
    ? payload.images.flatMap((raw): ModelImage[] => {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
        const image = raw as Record<string, JsonValue>;
        return typeof image.data === "string" && typeof image.mimeType === "string"
          ? [{ data: image.data, mimeType: image.mimeType }]
          : [];
      })
    : [];
  if (payload.status === "queued") {
    accumulator.followUps.set(payload.queueId, {
      text: payload.text,
      ...(images.length > 0 ? { images } : {})
    });
  }
  if (payload.status === "delivered") accumulator.followUps.delete(payload.queueId);
}

function validSnapshotShape(state: KernelState, sessionId: string): boolean {
  return isKernelState(state) && state.sessionId === sessionId;
}

function validatedSnapshotState(
  state: KernelState,
  sessionId: string
): KernelState | undefined {
  if (!validSnapshotShape(state, sessionId)) return undefined;
  try {
    assertKernelInvariants(state);
    return state;
  } catch {
    return undefined;
  }
}

function snapshotState(snapshot: Awaited<ReturnType<RunStore["latestSnapshot"]>>, sessionId: string): KernelState | undefined {
  if (!snapshot?.state || typeof snapshot.state !== "object" || Array.isArray(snapshot.state)) return undefined;
  const raw = snapshot.state as unknown as Record<string, unknown>;
  if (raw.schemaVersion !== KERNEL_STATE_VERSION) {
    throw Object.assign(
      new Error(
        `unsupported_schema_version: kernel state expected ${KERNEL_STATE_VERSION}, received ${String(raw.schemaVersion)}; existing data was not modified`
      ),
      {
        code: "unsupported_schema_version",
        expected: KERNEL_STATE_VERSION,
        actual: raw.schemaVersion
      }
    );
  }
  const validated = validatedSnapshotState(raw as unknown as KernelState, sessionId);
  if (!validated) {
    throw new Error(`Current kernel snapshot is invalid for session '${sessionId}'.`);
  }
  return validated;
}

function initializeFromCreated(
  accumulator: RestoreAccumulator,
  event: AgentEventEnvelope,
  sessionId: string,
  runDeadlineMs: number | undefined
): void {
  if (accumulator.metadata || event.type !== "session.created") return;
  accumulator.metadata = createdSessionMetadata(event);
  if (!accumulator.state && accumulator.metadata) {
    accumulator.state = freshState(
      sessionId,
      event,
      accumulator.metadata.mode,
      runDeadlineMs,
      accumulator.metadata.budgetLimits,
      accumulator.metadata.assurancePolicy
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
  runDeadlineMs: number | undefined
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
    pendingApprovals: new Map()
  };
}

export interface SnapshotRebuildInput {
  sessionId: string;
  lastSeq: number;
  events(): AsyncIterable<AgentEventEnvelope>;
}

/** Replays the durable event log through the kernel to rebuild a current snapshot. */
export async function rebuildSnapshotFromEvents(
  input: SnapshotRebuildInput,
  runDeadlineMs?: number
): Promise<SnapshotEnvelope> {
  const accumulator = emptyAccumulator();
  for await (const event of input.events()) replayEvent(accumulator, event, 0, runDeadlineMs);
  if (!accumulator.metadata || !accumulator.state || accumulator.lastSeq !== input.lastSeq) {
    throw new Error(`Session '${input.sessionId}' did not replay to seq ${input.lastSeq}.`);
  }
  assertKernelInvariants(accumulator.state);
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    sessionId: input.sessionId,
    seq: input.lastSeq,
    createdAt: new Date().toISOString(),
    state: jsonValue({ ...accumulator.state, lastSeq: input.lastSeq })
  };
}

export async function restoreStoredSession(store: RunStore, sessionId: string, runDeadlineMs?: number): Promise<RestoredSessionData> {
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
      if (!recovered) {
        throw Object.assign(new Error(
          `Session '${sessionId}' is missing schema 1 approval authority for call '${item.request.callId}'.`
        ), { code: "unsupported_schema_version" });
      }
      return {
        callId: item.request.callId,
        effects: recovered.effects,
        binding: recovered.binding
      };
    });
  return {
    ...accumulator.metadata,
    mode: accumulator.state.mode,
    state: accumulator.state,
    modelTurn: accumulator.modelTurn,
    lastSeq: accumulator.lastSeq,
    followUps: [...accumulator.followUps].map(([id, followUp]) => ({ id, ...followUp })),
    contextItems: [...accumulator.contextItems.values()],
    pendingApprovals
  };
}
