import {
  KERNEL_STATE_VERSION,
  createBudgetLedger,
  createEmptyPlan,
  isBudgetLedgerState,
  isCheckpointRef,
  isContextArchiveV1,
  isEvidenceRecord,
  isMutationFrontier,
  isPlanGraph,
  isUsageRecord,
  type BudgetLedgerState,
  type CheckpointRef,
  type ContextArchiveV1,
  type EvidenceRecord,
  type FrozenArtifactRef,
  type FrozenCustomizationRef,
  type ModelFinishReason,
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
  /** Durable completion state used to recover bounded output truncation. */
  lastModelFinishReason?: ModelFinishReason;
  consecutiveLengthFinishes: number;
  consecutiveLengthNoAction: number;
  lastModelHadToolCalls: boolean;
  messages: ModelMessage[];
  pendingTools: PendingTool[];
  toolCallIds: string[];
  receipts: ToolReceipt[];
  /** Session-scoped mutation evidence retained across follow-up runs so
   * validation and review status remains bound to the actual frontier. */
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
  /** Durable semantic projection of an omitted stable history prefix. */
  contextArchive?: ContextArchiveV1;
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
    consecutiveLengthFinishes: 0,
    consecutiveLengthNoAction: 0,
    lastModelHadToolCalls: false,
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
    childIds: []
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function validDeadlineState(state: Record<string, unknown>): boolean {
  return typeof state.deadlineAt === "string" && (state.deadlineRemainingMs === undefined
    || (Number.isSafeInteger(state.deadlineRemainingMs) && Number(state.deadlineRemainingMs) >= 1));
}

function validKernelIdentity(state: Record<string, unknown>): boolean {
  return typeof state.sessionId === "string" && state.sessionId.length > 0
    && typeof state.runId === "string" && state.runId.length > 0
    && (state.mode === "analyze" || state.mode === "change")
    && typeof state.phase === "string"
    && Number.isSafeInteger(state.revision) && Number(state.revision) >= 0
    && Number.isSafeInteger(state.lastSeq) && Number(state.lastSeq) >= 0
    && typeof state.startedAt === "string"
    && validDeadlineState(state);
}

function validKernelCollections(state: Record<string, unknown>): boolean {
  return Array.isArray(state.messages)
    && Array.isArray(state.pendingTools)
    && Array.isArray(state.toolCallIds)
    && Array.isArray(state.receipts)
    && Array.isArray(state.mutationEvidence) && state.mutationEvidence.every(isEvidenceRecord)
    && Array.isArray(state.evidence) && state.evidence.every(isEvidenceRecord)
    && Array.isArray(state.usage) && state.usage.every(isUsageRecord)
    && Array.isArray(state.activeProcessIds)
    && state.activeProcessIds.every((item) => typeof item === "string" && item.length > 0)
    && Array.isArray(state.childIds);
}

function validModelCompletionState(state: Record<string, unknown>): boolean {
  const finishReason = state.lastModelFinishReason;
  return (finishReason === undefined
      || ["stop", "length", "tool_calls", "content_filter", "protocol_error"]
        .includes(String(finishReason)))
    && Number.isSafeInteger(state.consecutiveLengthFinishes)
    && Number(state.consecutiveLengthFinishes) >= 0
    && Number.isSafeInteger(state.consecutiveLengthNoAction)
    && Number(state.consecutiveLengthNoAction) >= 0
    && typeof state.lastModelHadToolCalls === "boolean";
}

function validKernelDomainState(state: Record<string, unknown>): boolean {
  return isMutationFrontier(state.mutationFrontier)
    && isPlanGraph(state.plan)
    && isBudgetLedgerState(state.budget)
    && (state.checkpointHead === undefined || isCheckpointRef(state.checkpointHead))
    && validFrozenState(state)
    && (state.contextArchive === undefined || isContextArchiveV1(state.contextArchive))
    && (state.activeModelSemanticDelta === undefined
      || typeof state.activeModelSemanticDelta === "boolean")
    && validModelCompletionState(state);
}

export function isKernelState(value: unknown): value is KernelState {
  const state = record(value);
  if (!state || state.schemaVersion !== KERNEL_STATE_VERSION
    || Object.hasOwn(state, "taskControl")) return false;
  return validKernelIdentity(state)
    && validKernelCollections(state)
    && validKernelDomainState(state);
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
  if (!isKernelState(value)) throw new Error("Invalid KernelState V7.");
}

export function isTerminal(state: KernelState): boolean {
  return state.phase === "terminal";
}
