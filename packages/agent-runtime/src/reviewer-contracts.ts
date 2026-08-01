import type {
  BudgetAmounts,
  DiagnosticEvidence,
  InputAccessEvidence,
  ModelMessage,
  ModelToolCall,
  ModelRequest,
  ModelToolDefinition,
  ReviewEvidence,
  ToolEffect,
  UsageRecord,
  ValidationEvidence,
  WorkspaceDeltaEvidence
} from "agent-protocol";
import type { PreparedModelBudget } from "./model-accounting.js";

export interface ReviewerWorkspaceRead {
  path: string;
  sha256?: string;
  byteLength?: number;
  offset?: number;
  returnedLines?: number;
  totalLines?: number;
  complete: boolean;
  content: string;
}

export interface ReviewerReceiptSummary {
  callId: string;
  toolName: string;
  ok: boolean;
  argumentsDigest: string;
  argumentsPreview: string;
  resultDigest: string;
  outputPreview: string;
  effects: ToolEffect[];
  diagnostics: string[];
  evidenceIds: string[];
  artifactIds: string[];
  completedAt: string;
}

export interface ReviewerInput {
  sessionId: string;
  runId: string;
  goal: string;
  acceptanceCriteria?: string[];
  frontierRevision: number;
  stateDigest: string;
  reviewBasisDigest: string;
  reviewMode: "workspace" | "completion";
  verificationPolicy?: "standard" | "strict";
  logicalWorkspacePath?: string;
  verificationScratchPath?: string;
  completionCandidate?: string;
  completionCandidateDigest?: string;
  workspaceDeltas: WorkspaceDeltaEvidence[];
  environmentMutations?: DiagnosticEvidence[];
  processSettlements?: DiagnosticEvidence[];
  validations: ValidationEvidence[];
  validationReadiness?: {
    ready: boolean;
    missingPaths: string[];
    missingClaims: string[];
    latestFailureSummary?: string;
  };
  inputAccesses?: InputAccessEvidence[];
  goalReferencedWorkspaceReads?: ReviewerWorkspaceRead[];
  sessionReceipts?: ReviewerReceiptSummary[];
  postReviewReceipts?: ReviewerReceiptSummary[];
}

export interface ReviewerPort {
  readonly reviewerId?: string;
  review(input: ReviewerInput, signal: AbortSignal): Promise<ReviewEvidence>;
}

export interface ReviewerToolCheck {
  toolName: string;
  evidenceIds: string[];
  summary: string;
}

export interface ReviewerToolSessionPort {
  definitions(): readonly ModelToolDefinition[];
  execute(call: ModelToolCall, signal: AbortSignal): Promise<{
    message: ModelMessage;
    check: ReviewerToolCheck;
  }>;
  close(): Promise<void>;
}

export interface ReviewerToolEnvironment {
  definitions(): readonly ModelToolDefinition[];
  open(
    input: ReviewerInput,
    reviewRequestId: string,
    signal: AbortSignal
  ): Promise<ReviewerToolSessionPort>;
}

export interface PreparedReviewerCall {
  messages: ModelMessage[];
  tools?: ModelToolDefinition[];
  toolChoice?: ModelRequest["toolChoice"];
  maxOutputTokens: number;
  /** Maximum logical reviewer turns funded by the aggregate reservation. */
  maxTurns?: number;
  /** Per-model-call routing and retry budget retained across logical turns. */
  turnBudget?: PreparedModelBudget;
  /** Aggregate reservation for the complete bounded review. */
  budget: PreparedModelBudget;
}

export interface AccountedReviewerResult {
  evidence: ReviewEvidence;
  usage: UsageRecord;
}

export interface AccountableReviewerPort extends ReviewerPort {
  prepareReview(
    input: ReviewerInput,
    remainingBudgetMicroUsd: number,
    maxOutputTokens?: number
  ): Promise<PreparedReviewerCall>;
  reviewPrepared(
    input: ReviewerInput,
    requestId: string,
    prepared: PreparedReviewerCall,
    signal: AbortSignal
  ): Promise<AccountedReviewerResult>;
  failedUsage(
    input: ReviewerInput,
    requestId: string,
    prepared: PreparedReviewerCall,
    latencyMs: number,
    error: unknown
  ): UsageRecord;
  recoveredUsage(
    input: ReviewerInput,
    requestId: string,
    consumed: BudgetAmounts
  ): UsageRecord;
}

export function isAccountableReviewer(
  reviewer: ReviewerPort
): reviewer is AccountableReviewerPort {
  const candidate = reviewer as Partial<AccountableReviewerPort>;
  return typeof candidate.prepareReview === "function"
    && typeof candidate.reviewPrepared === "function"
    && typeof candidate.failedUsage === "function"
    && typeof candidate.recoveredUsage === "function";
}
