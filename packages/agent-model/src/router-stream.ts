import type { ModelRequest, ModelResponse, ModelStreamEvent } from "agent-protocol";
import { ModelGatewayError, type ModelRole, type ModelSpec } from "./catalog.js";
import { normalizeModelResponse } from "./usage.js";

export interface RoutedResponseMetadata {
  routeId: string;
  role: ModelRole;
  modelSpecId: string;
  attempt: number;
  providerId: string;
  tokenizerId: string;
  tokenizerAccuracy: "exact" | "approximate";
  tokenizerAssetDigest?: string;
}

export interface RoutedStreamLifecycle {
  semanticDelta: boolean;
  completed: boolean;
  lastEventType: string;
  hasContent: boolean;
  hasReasoning: boolean;
  hasToolCall: boolean;
}

export function newRoutedStreamLifecycle(): RoutedStreamLifecycle {
  return {
    semanticDelta: false,
    completed: false,
    lastEventType: "none",
    hasContent: false,
    hasReasoning: false,
    hasToolCall: false
  };
}

export function observeRoutedStreamEvent(
  lifecycle: RoutedStreamLifecycle,
  event: ModelStreamEvent
): void {
  lifecycle.lastEventType = event.type;
  if (event.type === "content") lifecycle.hasContent = true;
  if (event.type === "reasoning") lifecycle.hasReasoning = true;
  if (event.type === "tool_call") lifecycle.hasToolCall = true;
  if (event.type === "content" || event.type === "reasoning" || event.type === "tool_call") {
    lifecycle.semanticDelta = true;
  }
  if (event.type === "done") {
    lifecycle.semanticDelta = true;
    lifecycle.completed = true;
  }
}

export function routedResponse(
  role: ModelRole,
  routeId: string,
  spec: ModelSpec,
  response: ModelResponse,
  request: ModelRequest,
  attempt: number,
  latencyMs: number
): ModelResponse & RoutedResponseMetadata {
  return {
    ...normalizeModelResponse({ spec, request, response, latencyMs, retryAttempt: attempt }),
    routeId,
    role,
    modelSpecId: spec.id,
    attempt,
    providerId: spec.providerId,
    tokenizerId: spec.tokenizer.id,
    tokenizerAccuracy: spec.tokenizer.accuracy,
    ...(spec.tokenizer.assetDigest ? { tokenizerAssetDigest: spec.tokenizer.assetDigest } : {})
  };
}

export function incompleteRoutedStreamError(
  spec: ModelSpec,
  lifecycle: RoutedStreamLifecycle,
  attempts: number
): ModelGatewayError {
  return Object.assign(
    new ModelGatewayError(
      `Model stream for '${spec.id}' ended without a terminal response (lastEventType=${lifecycle.lastEventType}, hasContent=${lifecycle.hasContent}, hasToolCall=${lifecycle.hasToolCall}).`,
      "protocol",
      lifecycle.semanticDelta,
      undefined,
      undefined,
      {
        provider: spec.providerId,
        model: spec.upstreamModel,
        category: "protocol",
        doneReceived: false,
        lastEventType: lifecycle.lastEventType,
        hasContent: lifecycle.hasContent,
        hasReasoning: lifecycle.hasReasoning,
        hasToolCall: lifecycle.hasToolCall,
        retryAttempts: attempts
      }
    ),
    { code: "model_stream_incomplete" }
  );
}
