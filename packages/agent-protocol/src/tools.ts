import type { JsonValue } from "./json.js";
import type { ModelToolCall } from "./model.js";
import type {
  ArtifactRef,
  BudgetLedgerState,
  CheckpointRef,
  EvidenceRecord,
  BudgetAmounts,
  BudgetLimits,
  PlanGraph,
  PlanNodeOwner,
  WorkspaceRestorationEvidenceV1
} from "./domain.js";
import type { RunMode } from "./outcomes.js";
import type { ExecutionIntentV1, ResolvedExecutionCapabilityV1 } from "./execution-v5.js";

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
  idempotent: boolean;
  timeoutMs: number;
  idleTimeoutMs?: number;
  /** Trusted built-in declaration permitting broker-owned mutation journals. */
  brokerMutationAuthority?: "repository_transaction_v2" | "disposable_enclosing_container_v1";
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
    | "broker_repository_transaction_v2"
    | "disposable_enclosing_container_v1";
  idempotence: "read_only" | "replay_safe" | "non_replayable";
  /** V5 semantic process request and broker-resolved capability. Present for
   * process tools; filesystem grants are never model-authored. */
  executionIntent?: ExecutionIntentV1;
  executionCapability?: ResolvedExecutionCapabilityV1;
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
  /** V3 typed outcome; optional only on legacy executor input and normalized before durable emission. */
  outcome?: ToolOutcome;
  observedEffects: ToolEffect[];
  /** V3 exact post-execution effects. observedEffects remains as the V2 projection. */
  actualEffects?: ToolEffect[];
  workspaceDelta?: WorkspaceDelta;
  artifacts: string[];
  artifactRefs?: ArtifactRef[];
  diagnostics: string[];
  /** Typed durable evidence. Optional only while V2 tool executors migrate. */
  evidence?: EvidenceRecord[];
  startedAt: string;
  completedAt: string;
}

/** Durable, replay-safe record of one tool call made inside an independent
 * verification session. The call and frozen plan are stored together so a
 * recovered reviewer can reuse the receipt without repeating side effects. */
export interface ReviewerToolReceiptV1 {
  schemaVersion: 1;
  reviewRequestId: string;
  call: ModelToolCall;
  plan: ToolCallPlan;
  receipt: ToolReceipt & { outcome: ToolOutcome };
}

export interface RuntimeControlPort {
  readPlan(): Promise<PlanGraph>;
  readWorkPlan(): Promise<ModelPlanProjectionV3>;
  updatePlan(input: { expectedRevision: number; plan: PlanGraph }): Promise<PlanGraph>;
  updateWorkPlan(input: ModelPlanUpdateV3 | ModelPlanUpdateV2): Promise<ModelPlanUpdateResultV3>;
  readBudget(): Promise<BudgetLedgerState>;
  readWorkspaceFrontier(input?: {
    cursor?: string;
    limit?: number;
  }): Promise<WorkspaceFrontierPageV1>;
  readArtifact(input: {
    artifactId: string;
    offsetBytes?: number;
    maxBytes?: number;
  }): Promise<ArtifactPageV1>;
  listCheckpoints(): Promise<CheckpointRef[]>;
  createCheckpoint(scopePaths: string[]): Promise<CheckpointRef>;
  restoreRunCheckpoint(checkpointId: string): Promise<CheckpointRef>;
  restoreRunChanges(callId: string): Promise<WorkspaceRestorationEvidenceV1["data"]>;
  confirmRunRestored(callId: string): Promise<WorkspaceRestorationEvidenceV1["data"]>;
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

export interface ModelPlanNodeUpdateV2 {
  id: string;
  title: string;
  status: "pending" | "in_progress" | "blocked" | "completed" | "cancelled";
  dependencies?: string[];
  acceptanceCriteria?: string[];
  evidenceIds?: string[];
  blockedReason?: string;
  reopenReason?: string;
  /** One-release compatibility fields for the former model projection. */
  owner?: PlanNodeOwner;
  evidence?: PlanGraph["nodes"][number]["evidence"];
}

export interface ModelPlanUpdateV2 {
  expectedRevision: number;
  goal: string;
  activeNodeId?: string;
  nodes: ModelPlanNodeUpdateV2[];
}

export interface ModelPlanStepV3 {
  id?: string;
  step: string;
  status: "pending" | "in_progress" | "blocked" | "completed";
  blockedReason?: string;
}

export interface ModelPlanUpdateV3 {
  explanation?: string;
  goal?: string;
  acceptanceCriteria?: string[];
  plan: ModelPlanStepV3[];
}

export interface ModelPlanProjectionV3 {
  revision: number;
  goal: string;
  acceptanceCriteria: string[];
  activeStepId?: string;
  plan: Array<Required<Pick<ModelPlanStepV3, "id" | "step" | "status">> & {
    blockedReason?: string;
  }>;
}

export interface ModelPlanNormalizationWarningV3 {
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

export interface ModelPlanUpdateResultV3 {
  status: "updated" | "normalized" | "no_change";
  warnings: ModelPlanNormalizationWarningV3[];
  plan: ModelPlanProjectionV3;
}

export interface WorkspaceFrontierPageV1 {
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

export interface ArtifactPageV1 {
  artifactId: string;
  digest: string;
  totalBytes: number;
  offsetBytes: number;
  endOffsetBytes: number;
  nextOffset?: number;
  eof: boolean;
  encoding: "utf8" | "base64";
  content: string;
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
