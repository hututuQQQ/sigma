import type { ModelCapabilities, ModelStreamEvent } from "agent-protocol";
import type { StreamAttemptStatus } from "./openai-stream-decoder.js";
import type { SseStreamState } from "./sse.js";
import {
  ModelGatewayError,
  type ModelFailureCategory,
  type ModelFailureDiagnostics
} from "./catalog.js";
import type { RawUsage, UnnormalizedModelResponse } from "./usage.js";

export const defaultOpenAICapabilities: ModelCapabilities = {
  contextWindowTokens: 128_000,
  maxOutputTokens: 8_192,
  tools: true,
  parallelTools: true,
  reasoning: true,
  structuredOutput: false,
  promptCache: false,
  tokenizer: "approximate"
};

function timeoutError(message: string, options?: ErrorOptions): ModelGatewayError {
  const error = new ModelGatewayError(message, "timeout", false, undefined, options);
  error.name = "TimeoutError";
  return error;
}

export function modelDeadline(
  parent: AbortSignal,
  timeoutMs: number,
  message = `Model request exceeded ${timeoutMs}ms.`
): { signal: AbortSignal; close: () => void } {
  const controller = new AbortController();
  const onAbort = (): void => controller.abort(parent.reason ?? new Error("Model request aborted."));
  if (parent.aborted) onAbort(); else parent.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(timeoutError(message)), timeoutMs);
  return {
    signal: controller.signal,
    close: () => { clearTimeout(timer); parent.removeEventListener("abort", onAbort); }
  };
}

export function modelRetryDelay(attempt: number, retryAfter: string | null): number {
  const seconds = retryAfter ? Number(retryAfter) : Number.NaN;
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(30_000, seconds * 1000);
  const retryAt = retryAfter ? Date.parse(retryAfter) : Number.NaN;
  if (Number.isFinite(retryAt)) return Math.min(30_000, Math.max(0, retryAt - Date.now()));
  return Math.max(1, Math.floor(Math.random() * Math.min(8_000, 500 * 2 ** attempt)));
}

export async function waitForModelRetry(ms: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => { clearTimeout(timer); signal.removeEventListener("abort", onAbort); };
    const onAbort = (): void => { cleanup(); reject(signal.reason ?? new Error("Retry aborted.")); };
    const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function modelErrorSummary(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/Bearer\s+[^\s]+/giu, "Bearer [redacted]").slice(0, 800);
}

export function normalizeGatewayError(provider: string, error: unknown): ModelGatewayError {
  if (error instanceof ModelGatewayError) return error;
  if (error instanceof Error && error.name === "TimeoutError") {
    return timeoutError(modelErrorSummary(error), { cause: error });
  }
  return Object.assign(
    new ModelGatewayError(`${provider} network request failed: ${modelErrorSummary(error)}`, "network", false, undefined, {
      cause: error
    }),
    { retryable: true }
  );
}

export async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason ?? new Error("Operation aborted.");
  return await new Promise<T>((resolve, reject) => {
    const onAbort = (): void => { cleanup(); reject(signal.reason ?? new Error("Operation aborted.")); };
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => { cleanup(); resolve(value); },
      (error) => { cleanup(); reject(error); }
    );
  });
}

export interface StreamRetryCounts { infrastructure: number; partial: number }
export type DecodedStreamEvent =
  | Exclude<ModelStreamEvent, { type: "done" }>
  | { type: "done"; response: UnnormalizedModelResponse; rawUsage: RawUsage };

function failureReasonDiagnostics(
  error: unknown,
  signal?: AbortSignal
): Pick<ModelFailureDiagnostics, "abortReason" | "timeoutReason"> {
  const reason = signal?.aborted ? signal.reason : error;
  const summary = modelErrorSummary(reason).slice(0, 800);
  if (reason instanceof Error && reason.name === "TimeoutError") return { timeoutReason: summary };
  if (error instanceof Error && error.name === "TimeoutError") return { timeoutReason: modelErrorSummary(error) };
  return signal?.aborted ? { abortReason: summary } : {};
}

export function addSseState(total: SseStreamState, attempt: SseStreamState): void {
  total.chunksRead += attempt.chunksRead;
  total.bytesRead += attempt.bytesRead;
  total.framesRead += attempt.framesRead;
  total.dataPayloads += attempt.dataPayloads;
  total.transportEnded = attempt.transportEnded;
  total.trailingBytes += attempt.trailingBytes;
  total.firstByteAtMs ??= attempt.firstByteAtMs;
  if (attempt.lastFrameAtMs !== undefined) total.lastFrameAtMs = attempt.lastFrameAtMs;
  if (attempt.lastActivityAtMs !== undefined) total.lastActivityAtMs = attempt.lastActivityAtMs;
}

export function streamDiagnostics(
  provider: string,
  model: string,
  status: StreamAttemptStatus,
  sse: SseStreamState,
  retryAttempts: number,
  category: ModelFailureCategory = "protocol",
  error?: unknown,
  signal?: AbortSignal
): ModelFailureDiagnostics {
  const observedAt = performance.now();
  const elapsed = (at: number | undefined): number | undefined => at === undefined
    ? undefined : Math.max(0, Math.round(at - sse.startedAtMs));
  const firstByteMs = elapsed(sse.firstByteAtMs);
  const lastFrameMs = elapsed(sse.lastFrameAtMs);
  const idleSince = sse.lastActivityAtMs ?? sse.firstByteAtMs ?? sse.startedAtMs;
  return {
    provider,
    model,
    category,
    ...(status.httpStatus === undefined ? {} : { httpStatus: status.httpStatus }),
    ...(firstByteMs === undefined ? {} : { firstByteMs }),
    ...(lastFrameMs === undefined ? {} : { lastFrameMs }),
    idleDurationMs: Math.max(0, Math.round(observedAt - idleSince)),
    totalDurationMs: Math.max(0, Math.round(observedAt - sse.startedAtMs)),
    doneReceived: status.doneReceived,
    transportEnded: sse.transportEnded,
    lastEventType: status.lastEventType,
    hasContent: status.hasContent,
    hasReasoning: status.hasReasoning,
    hasToolCall: status.hasToolCall,
    retryAttempts,
    sseChunks: sse.chunksRead,
    sseBytes: sse.bytesRead,
    sseFrames: sse.framesRead,
    ssePayloads: sse.dataPayloads,
    sseTrailingBytes: sse.trailingBytes,
    ...failureReasonDiagnostics(error, signal)
  };
}

export function withStreamDiagnostics(
  provider: string,
  model: string,
  error: unknown,
  status: StreamAttemptStatus,
  sse: SseStreamState,
  retryAttempts: number,
  signal: AbortSignal
): ModelGatewayError {
  const normalized = normalizeGatewayError(provider, error);
  return Object.assign(normalized, { diagnostics: {
    ...normalized.diagnostics,
    ...streamDiagnostics(provider, model, status, sse, retryAttempts, normalized.category, error, signal)
  } });
}

export function streamProtocolError(
  provider: string,
  model: string,
  message: string,
  status: StreamAttemptStatus,
  sse: SseStreamState,
  retryAttempts: number,
  cause?: unknown
): ModelGatewayError {
  const detail = cause === undefined ? "" : ` Cause: ${modelErrorSummary(cause)}`;
  return Object.assign(
    new ModelGatewayError(
      `${message}${detail}`,
      "protocol",
      status.semantic || status.hasContent || status.hasReasoning || status.hasToolCall,
      status.httpStatus,
      cause === undefined ? undefined : { cause },
      streamDiagnostics(provider, model, status, sse, retryAttempts)
    ),
    { code: "model_stream_protocol_error" }
  );
}

export function completeChoice(
  raw: Record<string, unknown>,
  provider: string
): { choice: Record<string, unknown>; message: Record<string, unknown> } {
  if (!Array.isArray(raw.choices) || raw.choices.length === 0) {
    throw new ModelGatewayError(`${provider} response is malformed: choices must be a non-empty array.`, "protocol");
  }
  const choice = raw.choices[0];
  if (!choice || typeof choice !== "object" || Array.isArray(choice)) {
    throw new ModelGatewayError(`${provider} response is malformed: choices[0] must be an object.`, "protocol");
  }
  const message = (choice as Record<string, unknown>).message;
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    throw new ModelGatewayError(
      `${provider} response is malformed: choices[0].message must be an object.`,
      "protocol"
    );
  }
  return { choice: choice as Record<string, unknown>, message: message as Record<string, unknown> };
}

export function rawUsage(usage: Record<string, unknown>): RawUsage {
  const inputDetails = usage.prompt_tokens_details && typeof usage.prompt_tokens_details === "object"
    ? usage.prompt_tokens_details as Record<string, unknown> : {};
  const outputDetails = usage.completion_tokens_details && typeof usage.completion_tokens_details === "object"
    ? usage.completion_tokens_details as Record<string, unknown> : {};
  const cacheReadTokens = typeof inputDetails.cached_tokens === "number"
    ? inputDetails.cached_tokens
    : typeof usage.prompt_cache_hit_tokens === "number"
      ? usage.prompt_cache_hit_tokens
      : undefined;
  return {
    inputTokens: typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : undefined,
    outputTokens: typeof usage.completion_tokens === "number" ? usage.completion_tokens : undefined,
    cacheReadTokens,
    reasoningTokens: typeof outputDetails.reasoning_tokens === "number" ? outputDetails.reasoning_tokens : undefined
  };
}

export function missingKeyError(provider: string, apiKeyName: string): ModelGatewayError {
  return new ModelGatewayError(`${provider} API key is missing. Set ${apiKeyName}.`, "configuration");
}

export function httpError(provider: string, status: number, detail: string, prefix = ""): ModelGatewayError {
  let category: ModelFailureCategory = "protocol";
  if (status === 401 || status === 403) category = "auth";
  else if (status === 429) category = "rate_limit";
  else if (status >= 500) category = "server";
  return Object.assign(
    new ModelGatewayError(`${provider} ${prefix}HTTP ${status}: ${detail}`, category, false, status),
    { retryable: status === 429 || status >= 500 }
  );
}
