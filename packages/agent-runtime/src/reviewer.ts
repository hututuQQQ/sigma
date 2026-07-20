import { randomUUID } from "node:crypto";
import type {
  BudgetAmounts,
  JsonValue,
  InputAccessEvidence,
  ModelGateway,
  ModelMessage,
  ModelRequest,
  ModelResponse,
  RepositoryDeltaEvidence,
  ReviewEvidence,
  UsageRecord,
  ValidationEvidence,
  WorkspaceDeltaEvidence
} from "agent-protocol";
import type { ModelRouteConstraints } from "agent-model";
import {
  failedModelUsage,
  prepareModelBudget,
  successfulModelUsage,
  type PreparedModelBudget
} from "./model-accounting.js";
import { reviewInputFailure } from "./review-evidence-preflight.js";
import { reviewMessages } from "./reviewer-messages.js";
import type { ReviewObservationProjectionV1 } from "./review-observations.js";
import { COMPLETION_CANDIDATE_MAX_SERIALIZED_UTF8_BYTES,
  type CompletionReviewCandidateV1 } from "./completion-review-candidate.js";
export { reviewInputFailure } from "./review-evidence-preflight.js";
export { completionCandidateDigest, type CompletionReviewCandidateV1 } from "./completion-review-candidate.js";
export interface ReviewerInput {
  sessionId: string;
  runId: string;
  goal: string;
  frontierRevision: number;
  stateDigest: string;
  reviewBasisDigest: string;
  workspaceDeltas: WorkspaceDeltaEvidence[];
  repositoryDeltas?: RepositoryDeltaEvidence[];
  validations: ValidationEvidence[];
  validationRequiredPaths?: string[];
  reviewMode?: "workspace" | "completion";
  completionCandidate?: CompletionReviewCandidateV1;
  completionCandidateDigest?: string;
  inputAccesses?: InputAccessEvidence[];
  observations?: ReviewObservationProjectionV1;
}
export interface ReviewerPort {
  readonly reviewerId?: string;
  review(input: ReviewerInput, signal: AbortSignal): Promise<ReviewEvidence>;
}

export interface PreparedReviewerCall {
  messages: ModelMessage[];
  maxOutputTokens: number;
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
  recoveredUsage(input: ReviewerInput, requestId: string, consumed: BudgetAmounts): UsageRecord;
  /** Quote a conservative budget for any completion candidate produced within
   * `candidateOutputTokenLimit`. The runtime deducts this quote before it
   * admits the solver request that will produce that candidate. */
  prepareCompletionReserve?(
    input: ReviewerInput,
    remainingBudgetMicroUsd: number,
    maxOutputTokens: number
  ): Promise<PreparedModelBudget>;
}

export const COMPLETION_REVIEW_OUTPUT_TOKENS = 2_048;

export function isAccountableReviewer(reviewer: ReviewerPort): reviewer is AccountableReviewerPort {
  const candidate = reviewer as Partial<AccountableReviewerPort>;
  return typeof candidate.prepareReview === "function"
    && typeof candidate.reviewPrepared === "function"
    && typeof candidate.failedUsage === "function"
    && typeof candidate.recoveredUsage === "function";
}

export function canQuoteCompletionReserve(
  reviewer: AccountableReviewerPort
): reviewer is AccountableReviewerPort & Required<Pick<AccountableReviewerPort, "prepareCompletionReserve">> {
  return typeof reviewer.prepareCompletionReserve === "function";
}

function responseObject(content: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(content.trim()) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    return Object.keys(record).every((key) => key === "verdict" || key === "findings") ? record : null;
  } catch {
    return null;
  }
}

export function reviewInputFailureEvidence(
  input: ReviewerInput,
  reviewerId: string,
  message: string
): ReviewEvidence {
  return {
    evidenceId: randomUUID(),
    sessionId: input.sessionId,
    runId: input.runId,
    kind: "review",
    status: "failed",
    createdAt: new Date().toISOString(),
    producer: { authority: "runtime", id: reviewerId },
    summary: message,
    data: {
      reviewerId,
      verdict: "changes_requested",
      findings: [message],
      frontierRevision: input.frontierRevision,
      stateDigest: input.stateDigest,
      reviewBasisDigest: input.reviewBasisDigest,
      reviewBasisVersion: 3,
      ...(input.completionCandidateDigest
        ? { completionCandidateDigest: input.completionCandidateDigest } : {}),
      validationEvidenceIds: input.validations.map((item) => item.evidenceId),
      repositoryDeltaEvidenceIds: input.repositoryDeltas?.map((item) => item.evidenceId) ?? [],
      reviewRelevantEvidenceIds: input.observations?.items.map((item) => item.evidenceId) ?? [],
      ...(input.workspaceDeltas.some((item) => item.data.reviewProblem?.code === "review_scope_too_large")
        ? { failureCode: "review_scope_too_large" as const } : {})
    }
  };
}

export class ModelReviewer implements ReviewerPort {
  constructor(private readonly gateway: ModelGateway, readonly reviewerId = "builtin-reviewer") {}

  async review(input: ReviewerInput, signal: AbortSignal): Promise<ReviewEvidence> {
    const inputProblem = reviewInputFailure(input);
    if (inputProblem) return reviewInputFailureEvidence(input, this.reviewerId, inputProblem);
    const outputLimit = input.reviewMode === "completion"
      ? COMPLETION_REVIEW_OUTPUT_TOKENS : undefined;
    const prepared = await this.prepareReview(input, Number.MAX_SAFE_INTEGER, outputLimit);
    return (await this.reviewPrepared(input, randomUUID(), prepared, signal)).evidence;
  }

  async prepareReview(
    input: ReviewerInput,
    remainingBudgetMicroUsd: number,
    outputLimit = 4_096
  ): Promise<PreparedReviewerCall> {
    const messages = reviewMessages(input);
    const maxOutputTokens = Math.min(outputLimit, this.gateway.capabilities.maxOutputTokens);
    const budget = await prepareModelBudget(
      this.gateway,
      messages,
      [],
      maxOutputTokens,
      remainingBudgetMicroUsd
    );
    return { messages, maxOutputTokens, budget };
  }

  async prepareCompletionReserve(
    input: ReviewerInput,
    remainingBudgetMicroUsd: number,
    outputLimit = COMPLETION_REVIEW_OUTPUT_TOKENS
  ): Promise<PreparedModelBudget> {
    const maxTokensPerUtf8Byte = this.gateway.maxTokensPerUtf8Byte;
    if (!Number.isSafeInteger(maxTokensPerUtf8Byte) || (maxTokensPerUtf8Byte ?? 0) < 1) {
      throw new Error("The reviewer gateway has no trusted tokenizer UTF-8 expansion bound.");
    }
    const messages = reviewMessages(input);
    const counted = await this.gateway.countTokens(messages, []);
    const baseContentUtf8Bytes = messages.reduce((total, message) =>
      total + Buffer.byteLength(message.content, "utf8"), 0);
    // Do not assume inserting the candidate preserves token boundaries in the
    // surrounding JSON. The empty request count covers non-negative framing;
    // independently bounding every byte of the full possible message content
    // covers even a tokenizer that re-segments all surrounding text.
    const boundedContentTokens = (baseContentUtf8Bytes
      + COMPLETION_CANDIDATE_MAX_SERIALIZED_UTF8_BYTES) * (maxTokensPerUtf8Byte as number);
    const minimumInputTokens = Math.max(1, Math.ceil(counted)) + boundedContentTokens;
    if (!Number.isSafeInteger(boundedContentTokens) || !Number.isSafeInteger(minimumInputTokens)) {
      throw new Error("The reviewer tokenizer UTF-8 expansion bound exceeds the safe accounting range.");
    }
    return await prepareModelBudget(
      this.gateway,
      messages,
      [],
      Math.min(outputLimit, this.gateway.capabilities.maxOutputTokens),
      remainingBudgetMicroUsd,
      minimumInputTokens
    );
  }

  async reviewPrepared(
    input: ReviewerInput,
    requestId: string,
    prepared: PreparedReviewerCall,
    signal: AbortSignal
  ): Promise<AccountedReviewerResult> {
    const startedAt = performance.now();
    const request = {
      signal,
      tools: [],
      temperature: 0,
      maxOutputTokens: prepared.maxOutputTokens,
      messages: prepared.messages
    };
    const constrained = this.gateway as ModelGateway & {
      completeWithConstraints(request: ModelRequest, constraints: ModelRouteConstraints): Promise<ModelResponse>;
    };
    const response = prepared.budget.routeConstraints && constrained.completeWithConstraints
      ? await constrained.completeWithConstraints(request, prepared.budget.routeConstraints)
      : await this.gateway.complete(request);
    const evidence = reviewEvidence(input, this.reviewerId, response);
    const usage = successfulModelUsage(
      input,
      this.gateway,
      requestId,
      { messages: prepared.messages, tools: [] },
      response,
      prepared.budget,
      performance.now() - startedAt,
      "reviewer"
    );
    return { evidence, usage };
  }

  failedUsage(
    input: ReviewerInput,
    requestId: string,
    prepared: PreparedReviewerCall,
    latencyMs: number,
    error: unknown
  ): UsageRecord {
    const attempts = typeof (error as { attempts?: unknown })?.attempts === "number"
      ? Math.max(1, Math.trunc((error as { attempts: number }).attempts)) : 1;
    return failedModelUsage(input, this.gateway, requestId, prepared.budget, latencyMs, "reviewer", attempts);
  }

  recoveredUsage(input: ReviewerInput, requestId: string, consumed: BudgetAmounts): UsageRecord {
    const prepared: PreparedModelBudget = {
      estimatedInputTokens: Math.max(1, consumed.inputTokens),
      reserved: consumed,
      reservedAttempts: Math.max(1, consumed.modelTurns)
    };
    return {
      ...failedModelUsage(
        input,
        this.gateway,
        requestId,
        prepared,
        0,
        "reviewer",
        Math.max(1, consumed.modelTurns)
      ),
      inputTokens: consumed.inputTokens,
      outputTokens: consumed.outputTokens,
      costMicroUsd: consumed.costMicroUsd,
      providerReported: false
    };
  }
}

export function isActionableErrorFinding(finding: JsonValue): boolean {
  if (finding && typeof finding === "object" && !Array.isArray(finding)
    && Object.hasOwn(finding, "actionable") && Object.hasOwn(finding, "severity")) {
    const structured = finding as Record<string, JsonValue>;
    return structured.actionable === true && structured.severity === "error";
  }
  // Old review evidence allowed arbitrary JSON findings. Preserve the prior
  // conservative interpretation when reading those durable records.
  return true;
}

function reviewEvidenceReferences(input: ReviewerInput): Pick<ReviewEvidence["data"],
  "completionCandidateDigest" | "validationEvidenceIds" | "repositoryDeltaEvidenceIds"
  | "reviewRelevantEvidenceIds" | "failureCode"> {
  const repositoryDeltaEvidenceIds = (input.repositoryDeltas ?? []).map((item) => item.evidenceId);
  const reviewRelevantEvidenceIds = (input.observations?.items ?? []).map((item) => item.evidenceId);
  const scopeTooLarge = input.workspaceDeltas.some((item) =>
    item.data.reviewProblem?.code === "review_scope_too_large");
  return {
    ...(input.completionCandidateDigest
      ? { completionCandidateDigest: input.completionCandidateDigest } : {}),
    validationEvidenceIds: input.validations.map((item) => item.evidenceId),
    repositoryDeltaEvidenceIds,
    reviewRelevantEvidenceIds,
    ...(scopeTooLarge ? { failureCode: "review_scope_too_large" } : {})
  };
}

function reviewEvidence(
  input: ReviewerInput,
  reviewerId: string,
  response: ModelResponse
): ReviewEvidence {
    const parsed = responseObject(response.message.content);
    const inputProblem = reviewInputFailure(input);
    const rawFindings = Array.isArray(parsed?.findings) ? parsed.findings : undefined;
    const validFindings = rawFindings !== undefined;
    const findings = inputProblem ? [inputProblem] : validFindings
      ? rawFindings.filter((item): item is JsonValue => item === null || ["string", "number", "boolean", "object"].includes(typeof item))
      : [parsed ? "Reviewer response omitted findings." : "Reviewer returned invalid JSON."];
    const verdict = !inputProblem && validFindings && !findings.some(isActionableErrorFinding)
      ? "approved" : "changes_requested";
    return {
      evidenceId: randomUUID(),
      sessionId: input.sessionId,
      runId: input.runId,
      kind: "review",
      status: verdict === "approved" ? "passed" : "failed",
      createdAt: new Date().toISOString(),
      producer: { authority: "runtime", id: reviewerId },
      summary: verdict === "approved" ? "Independent reviewer approved the change." : "Independent reviewer requested changes.",
      data: {
        reviewerId,
        verdict,
        findings,
        frontierRevision: input.frontierRevision,
        stateDigest: input.stateDigest,
        reviewBasisDigest: input.reviewBasisDigest,
        reviewBasisVersion: 3,
        ...reviewEvidenceReferences(input)
      }
    };
}

export function documentationOnly(evidence: WorkspaceDeltaEvidence): boolean {
  const paths = [
    ...evidence.data.delta.added,
    ...evidence.data.delta.modified,
    ...evidence.data.delta.deleted
  ];
  const diff = evidence.data.reviewDiff;
  if (typeof diff !== "string" || diff.includes("[review diff truncated]")
    || diff.includes("[file diff truncated]") || diff.includes("[binary sha256=")) return false;
  const metadata = [...diff.matchAll(/^\[metadata before=([^ ]+) after=([^\]]+)\]$/gmu)];
  if (metadata.length !== paths.length || metadata.some((match) => !documentationMetadata(match[1]!, match[2]!))) return false;
  return paths.length > 0 && paths.every((file) => {
    const normalized = file.replaceAll("\\", "/").toLowerCase();
    const basename = normalized.split("/").at(-1) ?? "";
    if (/\.(md|mdx|rst|adoc)$/u.test(normalized)) return true;
    if (normalized.startsWith("docs/") && normalized.endsWith(".txt")) return true;
    return /^(readme|license|licence|changelog|contributing|authors|notice)(\.txt)?$/u.test(basename);
  });
}

function documentationMetadata(before: string, after: string): boolean {
  const parse = (value: string): { kind: string; mode?: string } => {
    if (value === "absent") return { kind: "absent" };
    const separator = value.lastIndexOf(":");
    return separator < 0 ? { kind: value } : { kind: value.slice(0, separator), mode: value.slice(separator + 1) };
  };
  const left = parse(before);
  const right = parse(after);
  if (![left.kind, right.kind].every((kind) => kind === "absent" || kind === "file")) return false;
  return left.kind === "absent" || right.kind === "absent" || left.mode === right.mode;
}
