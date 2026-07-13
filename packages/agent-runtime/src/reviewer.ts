import { randomUUID } from "node:crypto";
import type {
  BudgetAmounts,
  JsonValue,
  ModelGateway,
  ModelMessage,
  ModelRequest,
  ModelResponse,
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

export interface ReviewerInput {
  sessionId: string;
  runId: string;
  goal: string;
  workspaceDeltas: WorkspaceDeltaEvidence[];
  validations: ValidationEvidence[];
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
  prepareReview(input: ReviewerInput, remainingBudgetMicroUsd: number): Promise<PreparedReviewerCall>;
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
}

export function isAccountableReviewer(reviewer: ReviewerPort): reviewer is AccountableReviewerPort {
  const candidate = reviewer as Partial<AccountableReviewerPort>;
  return typeof candidate.prepareReview === "function"
    && typeof candidate.reviewPrepared === "function"
    && typeof candidate.failedUsage === "function"
    && typeof candidate.recoveredUsage === "function";
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

function incompleteReviewInput(input: ReviewerInput): string | undefined {
  for (const delta of input.workspaceDeltas) {
    const diff = delta.data.reviewDiff;
    if (typeof diff !== "string") return `Delta ${delta.evidenceId} has no reviewable diff.`;
    if (diff.includes("[review diff truncated]") || diff.includes("[file diff truncated]")) {
      return `Delta ${delta.evidenceId} has a truncated diff.`;
    }
    if (diff.includes("[binary sha256=")) return `Delta ${delta.evidenceId} contains binary content.`;
  }
  return undefined;
}

export class ModelReviewer implements ReviewerPort {
  constructor(private readonly gateway: ModelGateway, readonly reviewerId = "builtin-reviewer") {}

  async review(input: ReviewerInput, signal: AbortSignal): Promise<ReviewEvidence> {
    const prepared = await this.prepareReview(input, Number.MAX_SAFE_INTEGER);
    return (await this.reviewPrepared(input, randomUUID(), prepared, signal)).evidence;
  }

  async prepareReview(input: ReviewerInput, remainingBudgetMicroUsd: number): Promise<PreparedReviewerCall> {
    const messages = reviewMessages(input);
    const maxOutputTokens = Math.min(4_096, this.gateway.capabilities.maxOutputTokens);
    const budget = await prepareModelBudget(
      this.gateway,
      messages,
      [],
      maxOutputTokens,
      remainingBudgetMicroUsd
    );
    return { messages, maxOutputTokens, budget };
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

function reviewMessages(input: ReviewerInput): ModelMessage[] {
  return [{
    role: "system",
    content: "You are Sigma's independent read-only code reviewer. Review only the supplied goal, durable workspace delta and validation evidence. Return strict JSON: {\"verdict\":\"approved\"|\"changes_requested\",\"findings\":[JSON values]}. Never claim to have edited files."
  }, {
    role: "user",
    content: JSON.stringify({
      goal: input.goal,
      workspaceDeltas: input.workspaceDeltas.map((item) => ({
        evidenceId: item.evidenceId,
        checkpointId: item.data.checkpointId,
        delta: item.data.delta,
        diff: item.data.reviewDiff ?? "[diff artifact unavailable]"
      })),
      validations: input.validations.map((item) => ({ status: item.status, summary: item.summary, data: item.data }))
    })
  }];
}

function reviewEvidence(
  input: ReviewerInput,
  reviewerId: string,
  response: ModelResponse
): ReviewEvidence {
    const parsed = responseObject(response.message.content);
    const inputProblem = incompleteReviewInput(input);
    const rawFindings = Array.isArray(parsed?.findings) ? parsed.findings : undefined;
    const validFindings = rawFindings !== undefined;
    const verdict = !inputProblem && validFindings && parsed?.verdict === "approved" ? "approved" : "changes_requested";
    const findings = inputProblem ? [inputProblem] : validFindings
      ? rawFindings.filter((item): item is JsonValue => item === null || ["string", "number", "boolean", "object"].includes(typeof item))
      : [parsed ? "Reviewer response omitted findings." : "Reviewer returned invalid JSON."];
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
        workspaceDeltaEvidenceIds: input.workspaceDeltas.map((item) => item.evidenceId),
        validationEvidenceIds: input.validations.map((item) => item.evidenceId),
        ...(input.workspaceDeltas.at(-1)?.data.checkpointId
          ? { checkpointId: input.workspaceDeltas.at(-1)!.data.checkpointId } : {})
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
