import type { JsonValue } from "./json.js";
import type { ModelToolCall, ModelToolPresentation } from "./model.js";
import type {
  ArtifactRef,
  BudgetLedgerState,
  CheckpointRef,
  EvidenceRecord,
  BudgetAmounts,
  BudgetLimits,
  PlanGraph,
  WorkspaceRestorationEvidence
} from "./domain.js";
import type { RunMode } from "./outcomes.js";
import type { ExecutionIntent, ResolvedExecutionCapability } from "./execution.js";

export type ToolEffect =
  | "filesystem.read"
  | "filesystem.read.external"
  | "filesystem.write"
  | "repository.write"
  | "process.spawn"
  | "process.spawn.readonly"
  | "process.handoff"
  | "agent.spawn"
  | "network"
  | "validation"
  | "outcome.propose"
  | "outcome.report_blocked"
  | "outcome.request_input"
  | "runtime.control"
  | "checkpoint.restore"
  | "destructive"
  | "open_world";

export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: { [key: string]: JsonValue };
  /** Stable model-facing exposure. Direct tools form the small universal
   * harness core; omitted tools are eligible for deferred discovery when the
   * active gateway supports it. This never changes execution authority. */
  modelPresentation?: Partial<ModelToolPresentation>;
  possibleEffects: ToolEffect[];
  /** Modes in which this tool may be planned, independent of maximum effects. */
  availableModes?: RunMode[];
  /** Conservative presentation boundary; per-call policy uses ToolCallPlan.exactEffects. */
  maximumEffects?: ToolEffect[];
  executionMode: "parallel" | "sequential" | "exclusive";
  resourceKeys: string[];
  contextPathArguments?: string[];
  writePathArguments?: string[];
  approval: "auto" | "prompt" | "deny";
  /** Ephemeral, tool-scoped grant installed only for the current runtime session. */
  sessionApprovalGrant?: "web.read";
  idempotent: boolean;
  timeoutMs: number;
  idleTimeoutMs?: number;
  /** Trusted built-in declaration permitting broker-owned mutation journals. */
  brokerMutationAuthority?: "repository_transaction" | "disposable_enclosing_container";
  /** Trusted runtime-owned structured writer whose receipt reports its exact
   * workspace delta. The runtime still verifies the declared checkpoint scope
   * before sealing; this only suppresses the generic whole-worktree observer
   * used for open-world executors. */
  workspaceDeltaAuthority?: "structured_tool_receipt";
  prepare?(argumentsValue: JsonValue, context: ToolPreparationContext): Promise<ToolCallPlan> | ToolCallPlan;
}

export interface ToolPreparationContext {
  sessionId: string;
  runId: string;
  workspacePath: string;
  runMode: RunMode;
  goalEpoch?: number;
  mutationFrontierRevision?: number;
  mutationFrontierStateDigest?: string;
  /** Read-only session authority used while dynamically planning resources
   * whose paths are intentionally not model-addressable. */
  runtimeControl?: RuntimeControlPort;
}

export interface ToolCallPlan {
  exactEffects: ToolEffect[];
  readPaths: string[];
  /** Paths whose contents are approved to change. A directory entry approves
   * changes below it; process tools may use a broader checkpointScope to make
   * every sandbox-authorized write recoverable. */
  writePaths: string[];
  network: "none" | "loopback" | "full";
  /** Canonical network authority bound into approval for broker-owned requests. */
  networkTargets?: Array<{
    origin: string;
    method: "GET" | "POST";
  }>;
  processMode: "none" | "pipe" | "pty" | "background";
  /** Complete rollback scope for the call. For process tools this is also the
   * maximum filesystem scope granted write access by the execution broker. */
  checkpointScope: string[];
  /** Transaction-control actions are executed by the runtime without opening
   * a nested mutation checkpoint. The target is frozen during preparation. */
  checkpointAction?: { kind: "restore"; checkpointId: string };
  /** Runtime-authored proof that an out-of-process broker owns the complete
   * rollback journal. Only the structured repository transaction tool may set it. */
  mutationAuthority?:
    | "broker_repository_transaction"
    | "disposable_enclosing_container";
  idempotence: "read_only" | "replay_safe" | "non_replayable";
  /** Semantic process request and broker-resolved capability. Present for
   * process tools; filesystem grants are never model-authored. */
  executionIntent?: ExecutionIntent;
  executionCapability?: ResolvedExecutionCapability;
}

export interface ToolRequest {
  callId: string;
  name: string;
  arguments: JsonValue;
}

export interface WorkspaceDelta {
  added: string[];
  modified: string[];
  deleted: string[];
}

export interface ToolOutcome {
  status: "succeeded" | "failed";
  output: string;
  diagnosticCodes: string[];
}

export interface ToolReceipt {
  callId: string;
  ok: boolean;
  output: string;
  /** Optional structured result projected unchanged into the durable receipt
   * and model-visible receipt summary. output remains the text projection. */
  result?: JsonValue;
  outcome: ToolOutcome;
  observedEffects: ToolEffect[];
  actualEffects: ToolEffect[];
  workspaceDelta?: WorkspaceDelta;
  artifacts: string[];
  artifactRefs?: ArtifactRef[];
  /** Marks the receipt projection as data that cannot provide instructions. */
  contentTrust?: "external_untrusted";
  diagnostics: string[];
  evidence: EvidenceRecord[];
  startedAt: string;
  completedAt: string;
}

/** Durable, replay-safe record of one tool call made inside an independent
 * verification session. The call and frozen plan are stored together so a
 * recovered reviewer can reuse the receipt without repeating side effects. */
export interface ReviewerToolReceipt {
  schemaVersion: 1;
  reviewRequestId: string;
  call: ModelToolCall;
  plan: ToolCallPlan;
  receipt: ToolReceipt & { outcome: ToolOutcome };
}

export interface RuntimeControlPort {
  readPlan(): Promise<PlanGraph>;
  readWorkPlan(): Promise<ModelPlanProjection>;
  updatePlan(input: { expectedRevision: number; plan: PlanGraph }): Promise<PlanGraph>;
  updateWorkPlan(input: ModelPlanUpdate): Promise<ModelPlanUpdateResult>;
  readBudget(): Promise<BudgetLedgerState>;
  readWorkspaceFrontier(input?: {
    cursor?: string;
    limit?: number;
  }): Promise<WorkspaceFrontierPage>;
  readArtifact(input: {
    artifactId: string;
    offsetBytes?: number;
    maxBytes?: number;
  }): Promise<ArtifactPage>;
  listCheckpoints(): Promise<CheckpointRef[]>;
  createCheckpoint(scopePaths: string[]): Promise<CheckpointRef>;
  restoreRunCheckpoint(checkpointId: string): Promise<CheckpointRef>;
  restoreRunChanges(callId: string): Promise<WorkspaceRestorationEvidence["data"]>;
  confirmRunRestored(callId: string): Promise<WorkspaceRestorationEvidence["data"]>;
  requestReview(): Promise<ReviewRequestResult>;
  loadSkill(qualifiedName: string): Promise<{ content: string; evidence: EvidenceRecord }>;
  resolveLoadedSkillResource(input: {
    qualifiedName: string;
    relativePath: string;
    purpose: "plan" | "execute";
  }): Promise<LoadedSkillResourceAccess>;
  reserveChildBudget(childId: string, allocation?: Partial<BudgetLimits>): Promise<BudgetLimits>;
  settleChildBudget(childId: string, consumed?: Partial<BudgetAmounts>): Promise<void>;
  releaseChildBudget(childId: string): Promise<void>;
  rollbackChildPlanAssignment(childId: string, nodeIds: string[], previousPlan: PlanGraph): Promise<PlanGraph>;
}

export interface ModelPlanStep {
  id?: string;
  step: string;
  status: "pending" | "in_progress" | "blocked" | "completed";
  blockedReason?: string;
}

export interface ModelPlanUpdate {
  explanation?: string;
  goal?: string;
  acceptanceCriteria?: string[];
  plan: ModelPlanStep[];
}

export interface ModelPlanProjection {
  revision: number;
  goal: string;
  acceptanceCriteria: string[];
  activeStepId?: string;
  plan: Array<Required<Pick<ModelPlanStep, "id" | "step" | "status">> & {
    blockedReason?: string;
  }>;
}

export interface ModelPlanNormalizationWarning {
  code:
    | "multiple_active_steps"
    | "active_step_selected"
    | "blocked_reason_defaulted"
    | "completed_step_preserved"
    | "completed_step_reopened"
    | "runtime_dependency_preserved"
    | "step_id_regenerated";
  message: string;
  stepId?: string;
}

export interface ModelPlanUpdateResult {
  status: "updated" | "normalized" | "no_change";
  warnings: ModelPlanNormalizationWarning[];
  plan: ModelPlanProjection;
}

export interface WorkspaceFrontierPage {
  revision: number;
  stateDigest: string;
  frontierDigest: string;
  total: number;
  offset: number;
  workspacePathCount?: number;
  environmentPathCount?: number;
  paths: string[];
  nextCursor?: string;
  validation: {
    status: "not_needed" | "unverified" | "passed" | "failed" | "incomplete";
    recordCount: number;
    missingPathCount: number;
    missingClaimCount: number;
  };
}

export interface ArtifactPage {
  artifactId: string;
  digest: string;
  totalBytes: number;
  offsetBytes: number;
  endOffsetBytes: number;
  nextOffset?: number;
  eof: boolean;
  encoding: "utf8" | "base64";
  content: string;
  contentTrust?: "external_untrusted";
}

export interface ReviewRequestResult {
  status: "review_requested" | "approved" | "validation_required" | "changes_required"
    | "review_unavailable" | "not_required";
  reviewState: "none" | "current" | "stale";
  reviewBasisDigest: string;
  frontierRevision: number;
  stateDigest: string;
  changedPaths: string[];
  missingValidationPaths: string[];
  findings?: JsonValue[];
}

export interface LoadedSkillResourceAccess {
  qualifiedName: string;
  relativePath: string;
  absolutePath: string;
  readRoot: string;
  digest: string;
}

export interface ToolExecutionContext {
  sessionId: string;
  runId: string;
  workspacePath: string;
  runMode: import("./outcomes.js").RunMode;
  /** Current reducer-owned goal epoch. Tools may bind evidence to it but may
   * never advance or reconstruct it. */
  goalEpoch?: number;
  mutationFrontierRevision?: number;
  mutationFrontierStateDigest?: string;
  /** Immutable runtime-approved plan for this exact call. Mutating tools must
   * fail closed when it is unavailable. */
  callPlan?: ToolCallPlan;
  /** Ephemeral, call-bound authorization. Never persisted or restored. */
  approval?: ToolCallApproval;
  signal: AbortSignal;
  heartbeat(): void;
  progress(update: { message: string; percent?: number }): Promise<void>;
  createArtifact(input: { name: string; content: string | Uint8Array }): Promise<string>;
  runtimeControl?: RuntimeControlPort;
}

export interface ToolCallApproval {
  callId: string;
  /** Runtime authority is valid only for an auditable permission-mode=auto decision. */
  authority: "user" | "runtime";
  networkApproved: boolean;
  externalReadApproved: boolean;
  processHandoffApproved: boolean;
  openWorldApproved: boolean;
}

export interface ToolExecutor {
  descriptors(): readonly ToolDescriptor[];
  /** Model-visible catalog. Runtime-only coordinator actions are omitted. */
  modelDescriptors?(): readonly ToolDescriptor[];
  prepare?(request: ToolRequest, context: ToolPreparationContext): Promise<ToolCallPlan>;
  execute(request: ToolRequest, context: ToolExecutionContext): Promise<ToolReceipt>;
}
