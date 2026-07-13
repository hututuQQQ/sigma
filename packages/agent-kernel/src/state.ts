import {
  KERNEL_STATE_VERSION,
  createBudgetLedger,
  createEmptyPlan,
  isBudgetLedgerState,
  isCheckpointRef,
  isEvidenceRecord,
  isPlanGraph,
  isUsageRecord,
  type BudgetLedgerState,
  type CheckpointRef,
  type EvidenceRecord,
  type FrozenArtifactRef,
  type FrozenCustomizationRef,
  type ModelMessage,
  type PlanGraph,
  type RunMode,
  type RunOutcome,
  type ToolRequest,
  type ToolReceipt,
  type UsageRecord
} from "agent-protocol";

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

export interface SemanticProgressWatermark {
  /** Number of concrete changed paths (plus explicit checkpoint restores) observed in this run. */
  workspaceChanges: number;
  /** Number of accepted, non-failed durable evidence records observed in this run. */
  durableEvidence: number;
  /** Kernel revision at which either progress dimension last advanced. */
  revision: number;
}

export interface SemanticFailureCluster {
  /** Stable execution diagnostic family; deliberately independent of command text and tool arguments. */
  family: string;
  attempts: number;
  firstRevision: number;
  lastRevision: number;
  diagnosticCodes: string[];
  /** Latest global progress watermark. Execution clusters are rebased across
   * unrelated evidence or workspace progress until a process launch succeeds. */
  progress: SemanticProgressWatermark;
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
  completionRepairAttempts: number;
  continuationAttempts: number;
  repeatedToolBatchCount: number;
  receiptCountAtLastUserInput: number;
  semanticProgress: SemanticProgressWatermark;
  semanticFailureCluster?: SemanticFailureCluster;
  lastToolBatchSignature?: string;
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
    evidence: [],
    usage: [],
    plan: createEmptyPlan(),
    budget: createBudgetLedger(),
    frozenSkills: [],
    activeProcessIds: [],
    childIds: [],
    completionRepairAttempts: 0,
    continuationAttempts: 0,
    repeatedToolBatchCount: 0,
    receiptCountAtLastUserInput: 0,
    semanticProgress: { workspaceChanges: 0, durableEvidence: 0, revision: 0 }
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function validDeadlineState(state: Record<string, unknown>): boolean {
  return typeof state.deadlineAt === "string" && (state.deadlineRemainingMs === undefined
    || (Number.isSafeInteger(state.deadlineRemainingMs) && Number(state.deadlineRemainingMs) >= 1));
}

function nonNegativeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

export function isSemanticProgressWatermark(value: unknown): value is SemanticProgressWatermark {
  const progress = record(value);
  return Boolean(progress && [progress.workspaceChanges, progress.durableEvidence, progress.revision]
    .every(nonNegativeInteger));
}

export function isSemanticFailureCluster(value: unknown): value is SemanticFailureCluster {
  const cluster = record(value);
  return Boolean(cluster
    && typeof cluster.family === "string" && cluster.family.length > 0
    && Number.isSafeInteger(cluster.attempts) && Number(cluster.attempts) >= 1
    && [cluster.firstRevision, cluster.lastRevision].every(nonNegativeInteger)
    && Array.isArray(cluster.diagnosticCodes)
    && cluster.diagnosticCodes.every((item) => typeof item === "string" && item.length > 0)
    && isSemanticProgressWatermark(cluster.progress));
}

function validSemanticState(state: Record<string, unknown>): boolean {
  if (!isSemanticProgressWatermark(state.semanticProgress)) return false;
  const revision = Number(state.revision);
  if (state.semanticProgress.revision > revision) return false;
  if (state.semanticFailureCluster === undefined) return true;
  if (!isSemanticFailureCluster(state.semanticFailureCluster)) return false;
  return state.semanticFailureCluster.firstRevision <= state.semanticFailureCluster.lastRevision
    && state.semanticFailureCluster.lastRevision <= revision;
}

export function isKernelState(value: unknown): value is KernelState {
  const state = record(value);
  if (!state || state.schemaVersion !== KERNEL_STATE_VERSION) return false;
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
    Array.isArray(state.evidence) && state.evidence.every(isEvidenceRecord),
    Array.isArray(state.usage) && state.usage.every(isUsageRecord),
    isPlanGraph(state.plan),
    isBudgetLedgerState(state.budget),
    state.checkpointHead === undefined || isCheckpointRef(state.checkpointHead),
    validFrozenState(state),
    Array.isArray(state.activeProcessIds) && state.activeProcessIds.every((item) => typeof item === "string" && item.length > 0),
    Array.isArray(state.childIds),
    validSemanticState(state),
    [state.completionRepairAttempts, state.continuationAttempts, state.repeatedToolBatchCount,
      state.receiptCountAtLastUserInput].every((item) => Number.isSafeInteger(item) && Number(item) >= 0)
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
  if (!isKernelState(value)) throw new Error("Invalid KernelState V4.");
}

export function isTerminal(state: KernelState): boolean {
  return state.phase === "terminal";
}
