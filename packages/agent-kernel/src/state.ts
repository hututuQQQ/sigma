import {
  KERNEL_STATE_VERSION,
  createBudgetLedger,
  createEmptyPlan,
  isBudgetLedgerState,
  isCheckpointRef,
  isEvidenceRecord,
  isMutationFrontier,
  isPlanGraph,
  isUsageRecord,
  type BudgetLedgerState,
  type CheckpointRef,
  type EvidenceRecord,
  type FrozenArtifactRef,
  type FrozenCustomizationRef,
  type ModelMessage,
  type MutationFrontier,
  type PlanGraph,
  type RunMode,
  type RunOutcome,
  type ToolRequest,
  type ToolReceipt,
  type UsageRecord
} from "agent-protocol";
import { emptyMutationFrontier } from "./mutation-frontier.js";
import { createTaskControlState, hasPublishedTaskControlLegacyFields } from "./task-control.js";
import { isTaskControlStateV1, type TaskControlStateV1 } from "./task-control-state.js";

export type KernelPhase =
  | "idle"
  | "ready_model"
  | "model_in_flight"
  | "tool_pending"
  | "tool_in_flight"
  | "needs_input"
  | "outcome_pending"
  | "terminal";

export interface ActiveModelTurn {
  turnId: number;
  effectRevision: number;
}

export interface PendingTool {
  request: ToolRequest;
  modelTurn: ActiveModelTurn;
  approval: "not_required" | "pending" | "allowed" | "denied";
  started: boolean;
}

export interface KernelState {
  schemaVersion: typeof KERNEL_STATE_VERSION;
  sessionId: string;
  runId: string;
  mode: RunMode;
  phase: KernelPhase;
  revision: number;
  lastSeq: number;
  startedAt: string;
  deadlineAt: string;
  /** Active runtime milliseconds preserved while waiting for explicit user approval. */
  deadlineRemainingMs?: number;
  activeModelTurn?: ActiveModelTurn;
  /** True once any content or reasoning from the active provider attempt is durable. */
  activeModelSemanticDelta?: boolean;
  messages: ModelMessage[];
  pendingTools: PendingTool[];
  toolCallIds: string[];
  receipts: ToolReceipt[];
  /** Session-scoped mutation evidence retained across follow-up runs so
   * validation/review obligations cannot be erased by a run boundary. */
  mutationEvidence: EvidenceRecord[];
  /** Runtime-owned identity of the unresolved baseline-to-current mutation. */
  mutationFrontier: MutationFrontier;
  evidence: EvidenceRecord[];
  usage: UsageRecord[];
  plan: PlanGraph;
  budget: BudgetLedgerState;
  checkpointHead?: CheckpointRef;
  frozenProfile?: FrozenArtifactRef;
  frozenCustomization?: FrozenCustomizationRef;
  frozenSkills: FrozenArtifactRef[];
  activeProcessIds: string[];
  childIds: string[];
  /** The sole authority for task obligations, action convergence, protocol
   * correction, and completion delivery. Execution lifecycle remains in phase. */
  taskControl: TaskControlStateV1;
  proposedOutcome?: RunOutcome;
  outcome?: RunOutcome;
}

export interface CreateKernelStateOptions {
  sessionId: string;
  runId: string;
  mode: RunMode;
  startedAt: string;
  deadlineAt: string;
}

export function createKernelState(options: CreateKernelStateOptions): KernelState {
  return {
    schemaVersion: KERNEL_STATE_VERSION,
    sessionId: options.sessionId,
    runId: options.runId,
    mode: options.mode,
    phase: "idle",
    revision: 0,
    lastSeq: 0,
    startedAt: options.startedAt,
    deadlineAt: options.deadlineAt,
    messages: [],
    pendingTools: [],
    toolCallIds: [],
    receipts: [],
    mutationEvidence: [],
    mutationFrontier: emptyMutationFrontier(),
    evidence: [],
    usage: [],
    plan: createEmptyPlan(),
    budget: createBudgetLedger(),
    frozenSkills: [],
    activeProcessIds: [],
    childIds: [],
    taskControl: createTaskControlState()
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function validDeadlineState(state: Record<string, unknown>): boolean {
  return typeof state.deadlineAt === "string" && (state.deadlineRemainingMs === undefined
    || (Number.isSafeInteger(state.deadlineRemainingMs) && Number(state.deadlineRemainingMs) >= 1));
}

export function isKernelState(value: unknown): value is KernelState {
  const state = record(value);
  if (!state || state.schemaVersion !== KERNEL_STATE_VERSION
    || hasPublishedTaskControlLegacyFields(state)) return false;
  return [
    typeof state.sessionId === "string" && state.sessionId.length > 0,
    typeof state.runId === "string" && state.runId.length > 0,
    state.mode === "analyze" || state.mode === "change",
    typeof state.phase === "string",
    Number.isSafeInteger(state.revision) && Number(state.revision) >= 0,
    Number.isSafeInteger(state.lastSeq) && Number(state.lastSeq) >= 0,
    typeof state.startedAt === "string",
    validDeadlineState(state),
    state.activeModelSemanticDelta === undefined || typeof state.activeModelSemanticDelta === "boolean",
    Array.isArray(state.messages),
    Array.isArray(state.pendingTools),
    Array.isArray(state.toolCallIds),
    Array.isArray(state.receipts),
    Array.isArray(state.mutationEvidence) && state.mutationEvidence.every(isEvidenceRecord),
    isMutationFrontier(state.mutationFrontier),
    Array.isArray(state.evidence) && state.evidence.every(isEvidenceRecord),
    Array.isArray(state.usage) && state.usage.every(isUsageRecord),
    isPlanGraph(state.plan),
    isBudgetLedgerState(state.budget),
    state.checkpointHead === undefined || isCheckpointRef(state.checkpointHead),
    validFrozenState(state),
    Array.isArray(state.activeProcessIds) && state.activeProcessIds.every((item) => typeof item === "string" && item.length > 0),
    Array.isArray(state.childIds),
    isTaskControlStateV1(state.taskControl)
  ].every(Boolean);
}

function validFrozenState(state: Record<string, unknown>): boolean {
  return [
    state.frozenProfile === undefined || isFrozenArtifactRef(state.frozenProfile),
    state.frozenCustomization === undefined || isFrozenCustomizationRef(state.frozenCustomization),
    Array.isArray(state.frozenSkills) && state.frozenSkills.every(isFrozenArtifactRef)
  ].every(Boolean);
}

function isFrozenArtifactRef(value: unknown): value is FrozenArtifactRef {
  const item = record(value);
  if (!item) return false;
  const manifestAbsent = item?.executionManifestArtifactId === undefined
    && item?.executionManifestDigest === undefined;
  const manifestPresent = [
    typeof item.executionManifestArtifactId === "string",
    typeof item.executionManifestArtifactId === "string"
      && /^[a-f0-9]{64}$/u.test(item.executionManifestArtifactId),
    typeof item.executionManifestDigest === "string",
    typeof item.executionManifestDigest === "string"
      && /^[a-f0-9]{64}$/u.test(item.executionManifestDigest)
  ].every(Boolean);
  return [
    typeof item.artifactId === "string" && item.artifactId.length > 0,
    typeof item.digest === "string" && item.digest.length > 0,
    ["home", "workspace", "builtin"].includes(String(item.source)),
    typeof item.qualifiedName === "string" && item.qualifiedName.length > 0,
    manifestAbsent || manifestPresent
  ].every(Boolean);
}

function isFrozenCustomizationRef(value: unknown): value is FrozenCustomizationRef {
  const item = record(value);
  return Boolean(item && typeof item.artifactId === "string" && /^[a-f0-9]{64}$/u.test(item.artifactId)
    && typeof item.digest === "string" && /^[a-f0-9]{64}$/u.test(item.digest));
}

export function assertKernelState(value: unknown): asserts value is KernelState {
  if (!isKernelState(value)) throw new Error("Invalid KernelState V5.");
}

export function isTerminal(state: KernelState): boolean {
  return state.phase === "terminal";
}
