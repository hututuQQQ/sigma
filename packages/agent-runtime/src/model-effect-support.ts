import type {
  ModelMessage,
  ModelRequest,
  ModelResponse,
  ModelStreamEvent,
  ModelToolDefinition
} from "agent-protocol";
import {
  failureDiagnostics as gatewayFailureDiagnostics,
  type ModelFailureDiagnostics,
  type ModelRouteConstraints
} from "agent-model";
import type { EffectRunnerOptions } from "./effect-runner.js";
import type { RuntimeSession } from "./types.js";

function errorCause(error: unknown): unknown {
  return error && typeof error === "object" ? (error as { cause?: unknown }).cause : undefined;
}

export function modelFailureMessage(error: unknown): string {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current instanceof Error && !seen.has(current) && messages.length < 6) {
    seen.add(current);
    const message = current.message.replace(/Bearer\s+[^\s]+/giu, "Bearer [redacted]");
    if (!messages.includes(message)) messages.push(message);
    current = errorCause(current);
  }
  if (messages.length === 0) return String(error);
  return messages.map((message, index) => `${index === 0 ? "" : "Caused by: "}${message}`).join("\n");
}

export function modelFailureCode(error: unknown): string {
  let fallback = "model_error";
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") {
      if (code !== "model_route_failed") return code;
      fallback = code;
    }
    current = errorCause(current);
  }
  return fallback;
}

export function modelFailureDiagnostics(
  error: unknown,
  provider: string,
  model: string
): ModelFailureDiagnostics {
  const seen = new Set<unknown>();
  let current: unknown = error;
  let diagnostics: ModelFailureDiagnostics | undefined;
  let attempts: number | undefined;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    diagnostics ??= gatewayFailureDiagnostics(current);
    const value = (current as { attempts?: unknown }).attempts;
    if (attempts === undefined && typeof value === "number") attempts = Math.max(1, Math.trunc(value));
    current = errorCause(current);
  }
  return {
    provider,
    model,
    ...diagnostics,
    ...(diagnostics?.retryAttempts === undefined && attempts !== undefined ? { retryAttempts: attempts } : {})
  };
}

interface ModelStreamLifecycle {
  doneReceived: boolean;
  lastEventType: string;
  hasContent: boolean;
  hasReasoning: boolean;
  hasToolCall: boolean;
}

interface ModelStreamState extends ModelStreamLifecycle {
  response?: ModelResponse;
  contentDelta: string;
  reasoningDelta: string;
  lastFlush: number;
}

function newModelStreamState(): ModelStreamState {
  return {
    doneReceived: false,
    lastEventType: "none",
    hasContent: false,
    hasReasoning: false,
    hasToolCall: false,
    contentDelta: "",
    reasoningDelta: "",
    lastFlush: Date.now()
  };
}

function incompleteModelStreamError(
  provider: string,
  model: string,
  lifecycle: ModelStreamLifecycle,
  message = "Model stream ended without a final response."
): Error {
  const diagnostics: ModelFailureDiagnostics = {
    provider,
    model,
    category: "protocol",
    doneReceived: lifecycle.doneReceived,
    lastEventType: lifecycle.lastEventType,
    hasContent: lifecycle.hasContent,
    hasReasoning: lifecycle.hasReasoning,
    hasToolCall: lifecycle.hasToolCall,
    retryAttempts: 1
  };
  return Object.assign(new Error(
    `${message} provider=${provider}, model=${model}, doneReceived=${lifecycle.doneReceived}, lastEventType=${lifecycle.lastEventType}, hasContent=${lifecycle.hasContent}, hasToolCall=${lifecycle.hasToolCall}.`
  ), { code: "model_stream_incomplete", category: "protocol", diagnostics });
}

function observeModelStreamEvent(
  state: ModelStreamState,
  event: ModelStreamEvent,
  provider: string,
  model: string
): void {
  if (state.doneReceived) {
    throw incompleteModelStreamError(provider, model, state, "Model stream emitted data after its final response.");
  }
  state.lastEventType = event.type;
  if (event.type === "content") {
    state.hasContent = true;
    state.contentDelta += event.delta;
  } else if (event.type === "reasoning") {
    state.hasReasoning = true;
    state.reasoningDelta += event.delta;
  } else if (event.type === "tool_call") {
    state.hasToolCall = true;
  } else if (event.type === "done") {
    state.doneReceived = true;
    state.response = event.response;
    state.hasContent ||= event.response.message.content.length > 0;
    state.hasReasoning ||= Boolean(event.response.message.reasoningContent);
    state.hasToolCall ||= (event.response.message.toolCalls?.length ?? 0) > 0;
  }
}

async function flushModelStreamDeltas(
  options: EffectRunnerOptions,
  session: RuntimeSession,
  turnId: number,
  state: ModelStreamState
): Promise<void> {
  if (state.contentDelta) {
    const delta = state.contentDelta;
    state.contentDelta = "";
    await options.emit(session, "model.delta", "runtime", { turnId, delta });
  }
  if (state.reasoningDelta) {
    const delta = state.reasoningDelta;
    state.reasoningDelta = "";
    await options.emit(session, "model.reasoning_delta", "runtime", { turnId, delta });
  }
  state.lastFlush = Date.now();
}

export async function streamModelResponse(
  options: EffectRunnerOptions,
  session: RuntimeSession,
  turnId: number,
  messages: ModelMessage[],
  tools: ModelToolDefinition[],
  toolChoice: ModelRequest["toolChoice"],
  signal: AbortSignal,
  routeConstraints: ModelRouteConstraints | undefined
): Promise<ModelResponse> {
  const state = newModelStreamState();
  const gateway = session.services.gateway as typeof session.services.gateway & {
    streamWithConstraints?(
      request: ModelRequest,
      constraints: ModelRouteConstraints
    ): AsyncIterable<ModelStreamEvent>;
  };
  const request = {
    messages,
    tools,
    ...(toolChoice ? { toolChoice } : {}),
    signal,
    maxOutputTokens: Math.min(options.outputReserveTokens, session.services.gateway.capabilities.maxOutputTokens)
  };
  const stream = routeConstraints && gateway.streamWithConstraints
    ? gateway.streamWithConstraints(request, routeConstraints)
    : gateway.stream(request);
  try {
    for await (const event of stream) {
      if (signal.aborted) throw signal.reason;
      observeModelStreamEvent(state, event, session.services.gateway.provider, session.services.gateway.model);
      if (Date.now() - state.lastFlush >= 33) await flushModelStreamDeltas(options, session, turnId, state);
    }
  } catch (error) {
    // Preserve already-observed semantic metadata before propagating a stream failure.
    await flushModelStreamDeltas(options, session, turnId, state);
    throw error;
  }
  if (!state.response) signal.throwIfAborted();
  await flushModelStreamDeltas(options, session, turnId, state);
  if (!state.response) {
    throw incompleteModelStreamError(
      session.services.gateway.provider,
      session.services.gateway.model,
      state
    );
  }
  return state.response;
}
