import type {
  ModelMessage,
  ModelResponse
} from "agent-protocol";

type ToolCalls = NonNullable<ModelResponse["message"]["toolCalls"]>;

export function submittedReviewResponse(
  response: ModelResponse,
  calls: ToolCalls
): ModelResponse | undefined {
  const submissions = calls.filter((call) =>
    call.name === "submit_verification" || call.name === "submit_review");
  if (submissions.length === 0) return undefined;
  return calls.length === 1 && submissions.length === 1
    ? response
    : protocolFailureResponse(
        response,
        "submit_verification must be the only tool call in its turn."
      );
}

export function assistantReviewMessage(
  response: ModelResponse,
  calls?: ToolCalls
): ModelMessage {
  return {
    role: "assistant",
    content: response.message.content,
    ...(response.message.reasoningContent
      ? { reasoningContent: response.message.reasoningContent }
      : {}),
    ...(calls ? { toolCalls: calls } : {}),
    ...(response.message.providerState
      ? { providerState: response.message.providerState }
      : {})
  };
}

export function protocolFailureResponse(
  response: ModelResponse | undefined,
  message: string
): ModelResponse {
  return {
    ...(response ?? {
      finishReason: "protocol_error" as const,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        providerReported: false,
        costMicroUsd: 0,
        latencyMs: 0,
        retryAttempt: 0
      }
    }),
    message: {
      role: "assistant",
      content: message
    },
    finishReason: "protocol_error"
  };
}
