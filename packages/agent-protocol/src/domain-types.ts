import type { JsonValue } from "./json.js";

export type JsonObject = { [key: string]: JsonValue };

export type EvidenceKind =
  | "workspace_delta"
  | "command"
  | "validation"
  | "diagnostic"
  | "review"
  | "checkpoint"
  | "child_outcome"
  | "user_waiver";

export type EvidenceStatus = "passed" | "failed" | "warning" | "informational";
export type EvidenceAuthority = "system" | "developer" | "user" | "project" | "runtime" | "tool";

export type EvidenceProducer = JsonObject & {
  authority: EvidenceAuthority;
  id?: string;
};

export type EvidenceBase<TKind extends EvidenceKind, TData extends JsonObject> = JsonObject & {
  evidenceId: string;
  sessionId: string;
  runId: string;
  kind: TKind;
  status: EvidenceStatus;
  createdAt: string;
  producer: EvidenceProducer;
  summary: string;
  data: TData;
};

export type CheckpointDelta = JsonObject & {
  added: string[];
  modified: string[];
  deleted: string[];
};

export type WorkspaceDeltaEvidence = EvidenceBase<"workspace_delta", JsonObject & {
  delta: CheckpointDelta;
  checkpointId: string;
}>;

export type CommandEvidence = EvidenceBase<"command", JsonObject & {
  command: string;
  exitCode: number | null;
  signal?: string;
  artifactIds?: string[];
  stdoutArtifactId?: string;
  stderrArtifactId?: string;
}>;

export type ValidationEvidence = EvidenceBase<"validation", JsonObject & {
  validator: string;
  command?: string;
  exitCode?: number;
  artifactIds?: string[];
  workspaceDeltaEvidenceIds: string[];
}>;

export type DiagnosticEvidence = EvidenceBase<"diagnostic", JsonObject & {
  source: string;
  diagnostic: JsonValue;
}>;

export type ReviewEvidence = EvidenceBase<"review", JsonObject & {
  reviewerId: string;
  verdict: "approved" | "changes_requested";
  findings: JsonValue[];
  workspaceDeltaEvidenceIds: string[];
  validationEvidenceIds?: string[];
  checkpointId?: string;
}>;

export type CheckpointEvidence = EvidenceBase<"checkpoint", JsonObject & {
  checkpointId: string;
  checkpointStatus: CheckpointStatus;
  preManifestDigest: string;
  postManifestDigest?: string;
}>;

export type ChildOutcomeEvidence = EvidenceBase<"child_outcome", JsonObject & {
  childId: string;
  outcome: "completed" | "failed" | "cancelled" | "blocked";
  planNodeIds: string[];
}>;

export type UserWaiverEvidence = EvidenceBase<"user_waiver", JsonObject & {
  scope: "review" | "validation";
  reason: string;
  checkpointId?: string;
}>;

export type EvidenceRecord =
  | WorkspaceDeltaEvidence
  | CommandEvidence
  | ValidationEvidence
  | DiagnosticEvidence
  | ReviewEvidence
  | CheckpointEvidence
  | ChildOutcomeEvidence
  | UserWaiverEvidence;

export interface EvidenceRef {
  evidenceId: string;
  kind: EvidenceKind;
}

export interface ArtifactRef {
  artifactId: string;
  name: string;
  digest: string;
  mediaType?: string;
  sizeBytes?: number;
}

export type ModelExecutionRole =
  | "orchestrator"
  | "planner"
  | "reviewer"
  | "child_analyze"
  | "child_write"
  | "summarizer";

export interface UsageRecord {
  usageId: string;
  requestId: string;
  sessionId: string;
  runId: string;
  role: ModelExecutionRole;
  routeId: string;
  providerId: string;
  modelId: string;
  tokenizerId: string;
  tokenizerAccuracy: "exact" | "approximate";
  /** Digest of the pinned tokenizer asset used for deterministic accounting, when applicable. */
  tokenizerAssetDigest?: string;
  providerReported: boolean;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costMicroUsd: number;
  latencyMs: number;
  /** One-based provider/model attempt number. */
  attempt: number;
  occurredAt: string;
}

export type PlanNodeStatus = "pending" | "in_progress" | "blocked" | "completed" | "cancelled";

export type PlanNodeOwner =
  | { kind: "root" }
  | { kind: "child"; childId: string };

export interface PlanNode {
  id: string;
  title: string;
  dependencies: string[];
  status: PlanNodeStatus;
  owner: PlanNodeOwner;
  acceptanceCriteria: string[];
  evidence: EvidenceRef[];
  blockedReason?: string;
  reopenReason?: string;
}

export interface PlanGraph {
  revision: number;
  goal: string;
  activeNodeId?: string;
  nodes: PlanNode[];
}

export interface BudgetAmounts {
  inputTokens: number;
  outputTokens: number;
  costMicroUsd: number;
  modelTurns: number;
  toolCalls: number;
  children: number;
}

export interface BudgetLimits extends BudgetAmounts {
  maxDepth: number;
}

export type BudgetReservationStatus = "reserved" | "committed" | "released";

export interface BudgetReservation {
  reservationId: string;
  ownerId: string;
  status: BudgetReservationStatus;
  requested: BudgetAmounts;
  consumed: BudgetAmounts;
  createdAt: string;
  settledAt?: string;
}

export interface BudgetLedgerState {
  limits: BudgetLimits;
  consumed: BudgetAmounts;
  reserved: BudgetAmounts;
  reservations: BudgetReservation[];
}

export const DEFAULT_ROOT_BUDGET_LIMITS: BudgetLimits = {
  inputTokens: 8_000_000,
  outputTokens: 1_000_000,
  costMicroUsd: 50_000_000,
  modelTurns: 256,
  toolCalls: 2_048,
  children: 32,
  maxDepth: 4
};

export const DEFAULT_CHILD_BUDGET_LIMITS: BudgetLimits = {
  inputTokens: 1_000_000,
  outputTokens: 128_000,
  costMicroUsd: 8_000_000,
  modelTurns: 64,
  toolCalls: 512,
  children: 4,
  maxDepth: 4
};

export type CheckpointStatus = "open" | "sealed" | "restored";

export type CheckpointEntryKind = "file" | "directory" | "symlink" | "missing";

export interface CheckpointManifestEntry {
  path: string;
  kind: CheckpointEntryKind;
  mode?: number;
  sizeBytes?: number;
  digest?: string;
  symlinkTarget?: string;
}

export interface CheckpointManifest {
  manifestVersion: 1;
  digest: string;
  entries: CheckpointManifestEntry[];
  fileCount: number;
  totalBytes: number;
}

export interface CheckpointRef {
  checkpointId: string;
  sessionId: string;
  runId: string;
  status: CheckpointStatus;
  createdAt: string;
  sealedAt?: string;
  restoredAt?: string;
  preManifestDigest: string;
  postManifestDigest?: string;
  delta?: CheckpointDelta;
}

export interface FrozenArtifactRef {
  artifactId: string;
  digest: string;
  source: "home" | "workspace" | "builtin";
  qualifiedName: string;
  /** Optional for legacy loaded skills. New skill-process execution requires
   * this digest-bound, content-addressed resource manifest. */
  executionManifestArtifactId?: string;
  executionManifestDigest?: string;
}

export interface FrozenCustomizationRef {
  artifactId: string;
  digest: string;
}
