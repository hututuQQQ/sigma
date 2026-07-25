import type {
  ModelMessage,
  ModelResponse,
  UsageRecord
} from "agent-protocol";
import type {
  PreparedReviewerCall,
  ReviewerToolCheckV1,
  ReviewerToolSessionPort
} from "./reviewer-contracts.js";
import {
  assistantReviewMessage,
  protocolFailureResponse,
  submittedReviewResponse
} from "./reviewer-turn-protocol.js";
import { reviewerResponseObject } from "./reviewer-response-object.js";

export interface ReviewerTurnLoopResult {
  finalResponse?: ModelResponse;
  checks: ReviewerToolCheckV1[];
  usages: UsageRecord[];
}

interface ReviewerTurnStepInput {
  response: ModelResponse;
  toolSession: ReviewerToolSessionPort | undefined;
  turn: number;
  maximumTurns: number;
  toolCalls: number;
  maxToolCalls: number;
  inspectionRequired: boolean;
  messages: ModelMessage[];
  checks: ReviewerToolCheckV1[];
  usages: UsageRecord[];
  signal: AbortSignal;
}

interface ReviewerTurnStep {
  result?: ReviewerTurnLoopResult;
  toolCalls: number;
  verdictOnly: boolean;
}

function completedStep(
  result: ReviewerTurnLoopResult,
  toolCalls: number,
  verdictOnly = false
): ReviewerTurnStep {
  return { result, toolCalls, verdictOnly };
}

function failedStep(
  input: ReviewerTurnStepInput,
  message: string,
  toolCalls = input.toolCalls
): ReviewerTurnStep {
  return completedStep(
    failedReviewTurn(input.response, message, input.checks, input.usages),
    toolCalls,
    true
  );
}

export function isVerdictTool(name: string): boolean {
  return name === "submit_verification" || name === "submit_review";
}

export function malformedReviewSubmission(
  response: ModelResponse,
  calls: NonNullable<ModelResponse["message"]["toolCalls"]>
): boolean {
  return calls.some((call) => isVerdictTool(call.name))
    && reviewerResponseObject(response) === null;
}

export function failedReviewTurn(
  response: ModelResponse,
  message: string,
  checks: ReviewerToolCheckV1[],
  usages: UsageRecord[]
): ReviewerTurnLoopResult {
  return {
    finalResponse: protocolFailureResponse(response, message),
    checks,
    usages
  };
}

export function submittedReviewTurn(
  response: ModelResponse,
  calls: NonNullable<ModelResponse["message"]["toolCalls"]>,
  inspectionRequired: boolean,
  checks: ReviewerToolCheckV1[],
  usages: UsageRecord[]
): ReviewerTurnLoopResult | undefined {
  const submitted = submittedReviewResponse(response, calls);
  if (!submitted) return undefined;
  return inspectionRequired && checks.length === 0
    ? failedReviewTurn(
        response,
        "Independent verification must execute at least one available inspection before submitting a verdict.",
        checks,
        usages
      )
    : { finalResponse: submitted, checks, usages };
}

export function activeInspectionRequired(
  prepared: PreparedReviewerCall,
  toolSession: ReviewerToolSessionPort | undefined,
  maximumTurns: number
): boolean {
  return Boolean(toolSession)
    && maximumTurns >= 2
    && (prepared.tools ?? []).some((tool) => !isVerdictTool(tool.name));
}

export async function settleReviewerTurn(
  input: ReviewerTurnStepInput
): Promise<ReviewerTurnStep> {
  const calls = input.response.message.toolCalls ?? [];
  if (malformedReviewSubmission(input.response, calls)) {
    if (!input.toolSession || input.turn === input.maximumTurns) {
      return failedStep(
        input,
        "Independent verification submitted a malformed or mixed verdict at its protocol boundary."
      );
    }
    input.messages.push(assistantReviewMessage(input.response));
    return { toolCalls: input.toolCalls, verdictOnly: true };
  }
  const submitted = submittedReviewTurn(
    input.response,
    calls,
    input.inspectionRequired,
    input.checks,
    input.usages
  );
  if (submitted) return completedStep(submitted, input.toolCalls);
  if (!input.toolSession) {
    return completedStep({
      finalResponse: input.response,
      checks: input.checks,
      usages: input.usages
    }, input.toolCalls);
  }
  if (calls.length === 0) {
    input.messages.push(assistantReviewMessage(input.response));
    return input.turn === input.maximumTurns
      ? completedStep({
          finalResponse: input.response,
          checks: input.checks,
          usages: input.usages
        }, input.toolCalls, true)
      : { toolCalls: input.toolCalls, verdictOnly: input.checks.length > 0 };
  }
  if (input.toolCalls + calls.length > input.maxToolCalls) {
    return failedStep(
      input,
      "Independent verification exceeded its tool-call resource ceiling."
    );
  }
  const toolCalls = input.toolCalls + await executeInspectionCalls(
    input.toolSession,
    input.response,
    calls,
    input.messages,
    input.checks,
    input.signal
  );
  return input.turn === input.maximumTurns
    ? failedStep(
        input,
        "Independent verification reached its turn ceiling without submitting a verdict.",
        toolCalls
      )
    : {
        toolCalls,
        verdictOnly: toolCalls >= input.maxToolCalls
      };
}

export async function executeInspectionCalls(
  toolSession: ReviewerToolSessionPort,
  response: ModelResponse,
  calls: NonNullable<ModelResponse["message"]["toolCalls"]>,
  messages: ModelMessage[],
  checks: ReviewerToolCheckV1[],
  signal: AbortSignal
): Promise<number> {
  messages.push(assistantReviewMessage(response, calls));
  for (const call of calls) {
    const executed = await toolSession.execute(call, signal);
    checks.push(executed.check);
    messages.push(executed.message);
  }
  return calls.length;
}
