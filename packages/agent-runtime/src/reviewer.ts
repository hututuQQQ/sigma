import { randomUUID } from "node:crypto";
import type {
  BudgetAmounts,
  ModelGateway,
  ModelMessage,
  ModelRequest,
  ModelResponse,
  ReviewEvidence,
  UsageRecord
} from "agent-protocol";
import type { ModelRouteConstraints } from "agent-model";
import {
  failedModelUsage,
  prepareModelBudget,
  successfulModelUsage,
  type PreparedModelBudget
} from "./model-accounting.js";
import type {
  AccountedReviewerResult,
  PreparedReviewerCall,
  ReviewerInput,
  ReviewerPort,
  ReviewerToolCheck,
  ReviewerToolEnvironment,
  ReviewerToolSessionPort
} from "./reviewer-contracts.js";
import {
  reviewEvidence
} from "./reviewer-result.js";
import {
  reviewMessages,
  reviewResultTool,
  reviewVerdictReminder
} from "./reviewer-prompt.js";
import { aggregateReviewerUsage } from "./reviewer-accounting.js";
import {
  protocolFailureResponse
} from "./reviewer-turn-protocol.js";
import { deterministicSamplingOptions } from "./model-request-policy.js";
import {
  activeInspectionRequired,
  isVerdictTool,
  settleReviewerTurn,
  type ReviewerTurnLoopResult
} from "./reviewer-loop-support.js";
import { aggregateReviewerBudget } from "./reviewer-budget.js";

export {
  isAccountableReviewer,
  type AccountableReviewerPort,
  type AccountedReviewerResult,
  type PreparedReviewerCall,
  type ReviewerInput,
  type ReviewerPort,
  type ReviewerWorkspaceRead
} from "./reviewer-contracts.js";
export {
  isActionableErrorFinding
} from "./reviewer-result.js";

function reviewerModelSessionId(input: ReviewerInput, requestId: string): string {
  return `review:${input.sessionId}:${requestId}`;
}

export class ModelReviewer implements ReviewerPort {
  constructor(
    private readonly gateway: ModelGateway,
    readonly reviewerId = "builtin-reviewer",
    private readonly toolEnvironment?: ReviewerToolEnvironment,
    private readonly limits: {
      maxTurns: number;
      maxToolCalls: number;
    } = { maxTurns: 4, maxToolCalls: 12 }
  ) {}

  async review(input: ReviewerInput, signal: AbortSignal): Promise<ReviewEvidence> {
    const prepared = await this.prepareReview(input, Number.MAX_SAFE_INTEGER);
    return (await this.reviewPrepared(input, randomUUID(), prepared, signal)).evidence;
  }

  async prepareReview(
    input: ReviewerInput,
    remainingBudgetMicroUsd: number,
    outputLimit = 2_048
  ): Promise<PreparedReviewerCall> {
    const messages = reviewMessages(input);
    const structured = this.gateway.capabilities.tools;
    const tools = structured
      ? [
          ...(this.toolEnvironment?.definitions() ?? []),
          reviewResultTool()
        ]
      : [];
    const toolChoice = structured ? "auto" as const : undefined;
    const maxOutputTokens = Math.min(
      outputLimit,
      this.gateway.capabilities.maxOutputTokens
    );
    const singleTurnBudget = await prepareModelBudget(
      this.gateway,
      messages,
      tools,
      maxOutputTokens,
      remainingBudgetMicroUsd
    );
    const turnCapacity = this.toolEnvironment ? this.limits.maxTurns : 1;
    return {
      messages,
      tools,
      ...(toolChoice ? { toolChoice } : {}),
      maxOutputTokens,
      maxTurns: turnCapacity,
      turnBudget: singleTurnBudget,
      budget: aggregateReviewerBudget(singleTurnBudget, turnCapacity)
    };
  }

  async reviewPrepared(
    input: ReviewerInput,
    requestId: string,
    prepared: PreparedReviewerCall,
    signal: AbortSignal
  ): Promise<AccountedReviewerResult> {
    const toolSession = this.toolEnvironment
      ? await this.toolEnvironment.open(input, requestId, signal)
      : undefined;
    const messages = [...prepared.messages];
    let result: ReviewerTurnLoopResult | undefined;
    let closeFailure: unknown;
    try {
      result = await this.runReviewTurns(
        input,
        requestId,
        prepared,
        messages,
        toolSession,
        signal
      );
    } finally {
      try {
        await toolSession?.close();
      } catch (error) {
        closeFailure = error;
      }
      try {
        await this.gateway.releaseSession?.(reviewerModelSessionId(input, requestId));
      } catch {
        // Provider transport cleanup must not replace the independent verdict.
      }
    }
    if (closeFailure) throw closeFailure;
    const response = result?.finalResponse ?? protocolFailureResponse(undefined,
      "Independent verification ended without a verdict.");
    return {
      evidence: reviewEvidence(input, this.reviewerId, response, result?.checks ?? []),
      usage: aggregateReviewerUsage(
        input,
        requestId,
        result?.usages ?? [],
        prepared,
        this.gateway
      )
    };
  }

  private async completeTurn(
    input: ReviewerInput,
    requestId: string,
    prepared: PreparedReviewerCall,
    messages: ModelMessage[],
    turn: number,
    verdictOnly: boolean,
    verdictAllowed: boolean,
    signal: AbortSignal
  ): Promise<{ response: ModelResponse; usage: UsageRecord }> {
    const startedAt = performance.now();
    const preparedTools = prepared.tools ?? [];
    const allowedTools = verdictAllowed
      ? preparedTools
      : preparedTools.filter((tool) => !isVerdictTool(tool.name));
    const tools = verdictOnly
      ? allowedTools.filter((tool) => isVerdictTool(tool.name))
      : allowedTools;
    const toolChoice = tools.length === 0
      ? undefined
      : verdictOnly && this.gateway.capabilities.strictToolChoice
        ? "required" as const
        : "auto" as const;
    const requestMessages = verdictOnly
      ? [
          ...messages,
          reviewVerdictReminder(input.verificationPolicy ?? "standard")
        ]
      : messages;
    const request: ModelRequest = {
      sessionId: reviewerModelSessionId(input, requestId),
      signal,
      tools,
      ...(toolChoice ? { toolChoice } : {}),
      ...deterministicSamplingOptions(this.gateway),
      maxOutputTokens: prepared.maxOutputTokens,
      messages: requestMessages
    };
    const constrained = this.gateway as ModelGateway & {
      completeWithConstraints(
        request: ModelRequest,
        constraints: ModelRouteConstraints
      ): Promise<ModelResponse>;
    };
    const turnBudget = prepared.turnBudget ?? prepared.budget;
    const response = turnBudget.routeConstraints
      && constrained.completeWithConstraints
      ? await constrained.completeWithConstraints(
          request,
          turnBudget.routeConstraints
        )
      : await this.gateway.complete(request);
    return {
      response,
      usage: successfulModelUsage(
        input,
        this.gateway,
        `${requestId}:turn:${turn}`,
        { messages: requestMessages, tools },
        response,
        turnBudget,
        performance.now() - startedAt,
        "reviewer"
      )
    };
  }

  private async runReviewTurns(
    input: ReviewerInput,
    requestId: string,
    prepared: PreparedReviewerCall,
    messages: ModelMessage[],
    toolSession: ReviewerToolSessionPort | undefined,
    signal: AbortSignal
  ): Promise<ReviewerTurnLoopResult> {
    const checks: ReviewerToolCheck[] = [];
    const usages: UsageRecord[] = [];
    let toolCalls = 0;
    let verdictOnly = false;
    const maximumTurns = toolSession
      ? Math.max(1, Math.min(this.limits.maxTurns, prepared.maxTurns ?? this.limits.maxTurns))
      : 1;
    const inspectionRequired = activeInspectionRequired(
      prepared, toolSession, maximumTurns
    );
    for (let turn = 1; turn <= maximumTurns; turn += 1) {
      signal.throwIfAborted();
      const verdictAllowed = !inspectionRequired || checks.length > 0;
      const completed = await this.completeTurn(
        input,
        requestId,
        prepared,
        messages,
        turn,
        Boolean(toolSession) && verdictAllowed
          && (verdictOnly || turn === maximumTurns),
        verdictAllowed,
        signal
      );
      usages.push(completed.usage);
      const step = await settleReviewerTurn({
        response: completed.response,
        toolSession,
        turn,
        maximumTurns,
        toolCalls,
        maxToolCalls: this.limits.maxToolCalls,
        inspectionRequired,
        messages,
        checks,
        usages,
        signal
      });
      if (step.result) return step.result;
      toolCalls = step.toolCalls;
      verdictOnly = step.verdictOnly;
    }
    return { checks, usages };
  }

  failedUsage(
    input: ReviewerInput,
    requestId: string,
    prepared: PreparedReviewerCall,
    latencyMs: number,
    error: unknown
  ): UsageRecord {
    const attempts = typeof (error as { attempts?: unknown })?.attempts === "number"
      ? Math.max(1, Math.trunc((error as { attempts: number }).attempts))
      : 1;
    return failedModelUsage(
      input,
      this.gateway,
      requestId,
      prepared.budget,
      latencyMs,
      "reviewer",
      attempts
    );
  }

  recoveredUsage(
    input: ReviewerInput,
    requestId: string,
    consumed: BudgetAmounts
  ): UsageRecord {
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
