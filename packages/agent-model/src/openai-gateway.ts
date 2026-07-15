import type {
  JsonValue,
  ModelCapabilities,
  ModelGateway,
  ModelMessage,
  ModelRequest,
  ModelStreamEvent,
  ModelToolCall,
  ModelToolDefinition
} from "agent-protocol";
import { StreamDecoder, type StreamAttemptStatus, type StreamProgress } from "./openai-stream-decoder.js";
import {
  bodyFor,
  jsonValue,
  normalizedFinishReason,
  parseArguments,
  providerFinishError,
  resolveWireProfile,
  type OpenAIWireProfile
} from "./openai-wire.js";
import { createSseStreamState, ssePayloads, type SseStreamState } from "./sse.js";
import {
  ModelGatewayError,
  type ModelFailureCategory,
  type ModelFailureDiagnostics,
  type ModelPricing
} from "./catalog.js";
import {
  approximateTokenCount,
  normalizeModelResponse,
  type NormalizedModelResponse,
  type RawUsage,
  type UnnormalizedModelResponse
} from "./usage.js";

export type { OpenAIWireProfile } from "./openai-wire.js";

export interface OpenAIModelGatewayOptions {
  provider: string;
  model: string;
  baseUrl: string;
  apiKey?: string;
  apiKeyName: string;
  capabilities?: Partial<ModelCapabilities>;
  maxRetries?: number;
  requestTimeoutMs?: number;
  idleTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  wireProfile?: Partial<OpenAIWireProfile>;
  pricing?: ModelPricing;
}

const defaultCapabilities: ModelCapabilities = {
  contextWindowTokens: 128_000,
  maxOutputTokens: 8_192,
  tools: true,
  parallelTools: true,
  reasoning: true,
  structuredOutput: false,
  promptCache: false,
  tokenizer: "approximate"
};

function deadline(parent: AbortSignal, timeoutMs: number): { signal: AbortSignal; close: () => void } {
  const controller = new AbortController();
  const onAbort = (): void => controller.abort(parent.reason ?? new Error("Model request aborted."));
  if (parent.aborted) onAbort(); else parent.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    const error = timeoutError(`Model request exceeded ${timeoutMs}ms.`);
    controller.abort(error);
  }, timeoutMs);
  return { signal: controller.signal, close: () => { clearTimeout(timer); parent.removeEventListener("abort", onAbort); } };
}

function retryDelay(attempt: number, retryAfter: string | null): number {
  const seconds = retryAfter ? Number(retryAfter) : Number.NaN;
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(30_000, seconds * 1000);
  const retryAt = retryAfter ? Date.parse(retryAfter) : Number.NaN;
  if (Number.isFinite(retryAt)) return Math.min(30_000, Math.max(0, retryAt - Date.now()));
  return Math.max(1, Math.floor(Math.random() * Math.min(8_000, 500 * 2 ** attempt)));
}

async function wait(ms: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => { clearTimeout(timer); signal.removeEventListener("abort", onAbort); };
    const onAbort = (): void => { cleanup(); reject(signal.reason ?? new Error("Retry aborted.")); };
    const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function timeoutError(message: string): ModelGatewayError {
  const error = new ModelGatewayError(message, "timeout");
  error.name = "TimeoutError";
  return error;
}

function errorSummary(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/Bearer\s+[^\s]+/giu, "Bearer [redacted]").slice(0, 800);
}

function normalizeGatewayError(provider: string, error: unknown): ModelGatewayError {
  if (error instanceof ModelGatewayError) return error;
  if (error instanceof Error && error.name === "TimeoutError") {
    return timeoutError(errorSummary(error));
  }
  return Object.assign(
    new ModelGatewayError(`${provider} network request failed: ${errorSummary(error)}`, "network", false, undefined, {
      cause: error
    }),
    { retryable: true }
  );
}

async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason ?? new Error("Operation aborted.");
  return await new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      cleanup();
      reject(signal.reason ?? new Error("Operation aborted."));
    };
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => { cleanup(); resolve(value); },
      (error) => { cleanup(); reject(error); }
    );
  });
}

interface StreamRetryCounts { infrastructure: number; partial: number }
type DecodedStreamEvent =
  | Exclude<ModelStreamEvent, { type: "done" }>
  | { type: "done"; response: UnnormalizedModelResponse; rawUsage: RawUsage };

function streamDiagnostics(
  provider: string,
  model: string,
  status: StreamAttemptStatus,
  sse: SseStreamState,
  retryAttempts: number
): ModelFailureDiagnostics {
  return {
    provider,
    model,
    category: "protocol",
    ...(status.httpStatus === undefined ? {} : { httpStatus: status.httpStatus }),
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
    sseTrailingBytes: sse.trailingBytes
  };
}

function streamProtocolError(
  provider: string,
  model: string,
  message: string,
  status: StreamAttemptStatus,
  sse: SseStreamState,
  retryAttempts: number,
  cause?: unknown
): ModelGatewayError {
  const detail = cause === undefined ? "" : ` Cause: ${errorSummary(cause)}`;
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

export class OpenAIModelGateway implements ModelGateway {
  readonly provider: string;
  readonly model: string;
  readonly capabilities: ModelCapabilities;
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly apiKeyName: string;
  private readonly maxRetries: number;
  private readonly requestTimeoutMs: number;
  private readonly idleTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly wireProfile: OpenAIWireProfile;
  private readonly retryableFinishReasons: ReadonlySet<string>;
  private readonly pricing?: ModelPricing;

  constructor(options: OpenAIModelGatewayOptions) {
    this.provider = options.provider;
    this.model = options.model;
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.apiKeyName = options.apiKeyName;
    this.capabilities = { ...defaultCapabilities, ...options.capabilities };
    this.maxRetries = Math.max(0, Math.trunc(options.maxRetries ?? 2));
    this.requestTimeoutMs = Math.max(1, Math.trunc(options.requestTimeoutMs ?? 120_000));
    this.idleTimeoutMs = Math.max(1, Math.trunc(options.idleTimeoutMs ?? 45_000));
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.wireProfile = resolveWireProfile(options.wireProfile);
    this.retryableFinishReasons = new Set(this.wireProfile.retryableFinishReasons);
    this.pricing = options.pricing;
  }

  async countTokens(messages: ModelMessage[], tools: ModelToolDefinition[] = []): Promise<number> {
    return approximateTokenCount({ messages, tools });
  }

  async complete(request: ModelRequest): Promise<NormalizedModelResponse> {
    const startedAt = performance.now();
    const result = await this.fetchJsonWithRetry(bodyFor(request, this.model, false, this.wireProfile), request.signal);
    const raw = result.raw;
    const { choice, message } = completeChoice(raw, this.provider);
    const calls = this.parseCompleteCalls(message.tool_calls);
    const usage = raw.usage && typeof raw.usage === "object" ? raw.usage as Record<string, unknown> : {};
    const response: UnnormalizedModelResponse = {
      message: {
        role: "assistant",
        content: typeof message.content === "string" ? message.content : "",
        ...(typeof message.reasoning_content === "string" ? { reasoningContent: message.reasoning_content } : {}),
        ...(calls.length ? { toolCalls: calls } : {})
      },
      finishReason: normalizedFinishReason(choice.finish_reason, calls.length > 0),
      inputTokens: typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : undefined,
      outputTokens: typeof usage.completion_tokens === "number" ? usage.completion_tokens : undefined,
      raw: jsonValue(raw)
    };
    return normalizeModelResponse({
      spec: { pricing: this.pricing },
      request,
      response,
      rawUsage: rawUsage(usage),
      latencyMs: performance.now() - startedAt,
      retryAttempt: result.attempt
    });
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    if (!this.apiKey) throw missingKeyError(this.provider, this.apiKeyName);
    const startedAt = performance.now();
    const scope = deadline(request.signal, this.requestTimeoutMs);
    const progress: StreamProgress = { deliveredContent: "", deliveredReasoning: "" };
    const retries: StreamRetryCounts = { infrastructure: 0, partial: 0 };
    try {
      for (let attempt = 0; ; attempt += 1) {
        const status: StreamAttemptStatus = {
          semantic: false,
          retryAllowed: true,
          retryAfter: null,
          doneReceived: false,
          lastEventType: "none",
          hasContent: progress.deliveredContent.length > 0,
          hasReasoning: progress.deliveredReasoning.length > 0,
          hasToolCall: false
        };
        try {
          for await (const event of this.streamAttempt(request, scope.signal, progress, status, attempt + 1)) {
            if (event.type === "done") {
              yield { type: "done", response: normalizeModelResponse({
                spec: { pricing: this.pricing },
                request,
                response: event.response,
                rawUsage: event.rawUsage,
                latencyMs: performance.now() - startedAt,
                retryAttempt: attempt
              }) };
            } else yield event;
          }
          return;
        } catch (error) {
          await this.retryStream(error, attempt, scope.signal, progress, status, retries);
        }
      }
    } finally {
      scope.close();
    }
  }

  private async *streamAttempt(
    request: ModelRequest,
    signal: AbortSignal,
    progress: StreamProgress,
    status: StreamAttemptStatus,
    retryAttempts: number
  ): AsyncIterable<DecodedStreamEvent> {
    const body = await this.openStreamBody(request, signal, status);
    const decoder = new StreamDecoder(this.provider, progress, status, this.retryableFinishReasons);
    const sse = createSseStreamState();
    for await (const payload of ssePayloads(body, signal, this.idleTimeoutMs, sse)) {
      if (payload === "[DONE]") {
        status.doneReceived = true;
        status.lastEventType = "[DONE]";
        let done: ReturnType<StreamDecoder["done"]>;
        try {
          done = decoder.done();
        } catch (error) {
          if ((error as { code?: unknown })?.code === "provider_resource_exhausted") {
            throw Object.assign(error as Error, {
              diagnostics: streamDiagnostics(this.provider, this.model, status, sse, retryAttempts)
            });
          }
          throw streamProtocolError(
            this.provider,
            this.model,
            `${this.provider} stream terminal payload could not be finalized.`,
            status,
            sse,
            retryAttempts,
            error
          );
        }
        if (done.type !== "done") throw new Error("Stream decoder returned a non-terminal done event.");
        yield { ...done, rawUsage: decoder.rawUsage() };
        return;
      }
      status.lastEventType = "sse.data";
      let decoded: ModelStreamEvent[];
      try {
        decoded = decoder.consume(payload);
      } catch (error) {
        throw streamProtocolError(
          this.provider,
          this.model,
          `${this.provider} stream contained an invalid SSE data payload.`,
          status,
          sse,
          retryAttempts,
          error
        );
      }
      for (const event of decoded) {
        if (event.type === "done") throw new Error("Stream decoder emitted an early terminal event.");
        status.lastEventType = event.type;
        yield event;
      }
    }
    throw streamProtocolError(
      this.provider,
      this.model,
      `${this.provider} stream ended before [DONE] (transportEnded=${sse.transportEnded}, lastEventType=${status.lastEventType}, hasContent=${status.hasContent}, hasToolCall=${status.hasToolCall}, attempts=${retryAttempts}).`,
      status,
      sse,
      retryAttempts
    );
  }

  private async openStreamBody(
    request: ModelRequest,
    signal: AbortSignal,
    status: StreamAttemptStatus
  ): Promise<ReadableStream<Uint8Array>> {
    const response = await abortable(
      this.fetchImpl(
        `${this.baseUrl}/chat/completions`,
        this.fetchInit(bodyFor(request, this.model, true, this.wireProfile), signal)
      ),
      signal
    );
    status.retryAfter = response.headers.get("retry-after");
    status.httpStatus = response.status;
    if (!response.ok) {
      status.retryAllowed = response.status === 429 || response.status >= 500;
      const detail = await abortable(response.text(), signal);
      throw httpError(this.provider, response.status, detail.slice(0, 800), "stream ");
    }
    if (!response.body) throw new Error(`${this.provider} stream has no body.`);
    return response.body;
  }

  private async retryStream(
    error: unknown,
    attempt: number,
    signal: AbortSignal,
    progress: StreamProgress,
    status: StreamAttemptStatus,
    retries: StreamRetryCounts
  ): Promise<void> {
    if (signal.aborted) throw signal.reason;
    const rawCode = error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code
      : "";
    const normalized = rawCode.startsWith("provider_")
      ? error as Error
      : normalizeGatewayError(this.provider, error);
    if (!status.retryAllowed) throw normalized;
    const partial = status.semantic || progress.deliveredContent.length > 0 || progress.deliveredReasoning.length > 0;
    if (partial) {
      retries.partial += 1;
      if (retries.partial > this.maxRetries) throw normalized;
    } else {
      retries.infrastructure += 1;
      if (retries.infrastructure > this.maxRetries) throw normalized;
    }
    await wait(retryDelay(attempt, status.retryAfter), signal);
  }

  private async fetchJsonWithRetry(
    body: Record<string, JsonValue>,
    parent: AbortSignal
  ): Promise<{ raw: Record<string, unknown>; attempt: number }> {
    if (!this.apiKey) throw missingKeyError(this.provider, this.apiKeyName);
    const scope = deadline(parent, this.requestTimeoutMs);
    try {
      for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
        let retryAfter: string | null = null;
        try {
          const response = await abortable(
            this.fetchImpl(`${this.baseUrl}/chat/completions`, this.fetchInit(body, scope.signal)),
            scope.signal
          );
          retryAfter = response.headers.get("retry-after");
          if (!response.ok) {
            const retryable = response.status === 429 || response.status >= 500;
            const detail = await abortable(response.text(), scope.signal);
            const failure = httpError(this.provider, response.status, detail.slice(0, 800));
            if (!retryable) throw Object.assign(failure, { retryable: false });
            throw failure;
          }
          const raw = await abortable(response.json() as Promise<Record<string, unknown>>, scope.signal);
          const choice = Array.isArray(raw.choices) && raw.choices[0] && typeof raw.choices[0] === "object"
            ? raw.choices[0] as Record<string, unknown>
            : {};
          if (typeof choice.finish_reason === "string" && this.retryableFinishReasons.has(choice.finish_reason)) {
            throw providerFinishError(this.provider, choice.finish_reason);
          }
          return { raw, attempt };
        } catch (error) {
          if (scope.signal.aborted) throw scope.signal.reason;
          const normalized = normalizeGatewayError(this.provider, error);
          if ((normalized as { retryable?: unknown }).retryable === false || attempt === this.maxRetries) {
            throw normalized;
          }
          await wait(retryDelay(attempt, retryAfter), scope.signal);
        }
      }
      throw new Error(`${this.provider} request failed.`);
    } finally {
      scope.close();
    }
  }

  private fetchInit(body: Record<string, JsonValue>, signal: AbortSignal): RequestInit {
    return { method: "POST", headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify(body), signal };
  }

  private parseCompleteCalls(value: unknown): ModelToolCall[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap((raw, index): ModelToolCall[] => {
      const item = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
      const fn = item.function && typeof item.function === "object" ? item.function as Record<string, unknown> : {};
      return typeof fn.name === "string" ? [{ id: typeof item.id === "string" ? item.id : `call_${index}`, name: fn.name, arguments: parseArguments(typeof fn.arguments === "string" ? fn.arguments : "{}") }] : [];
    });
  }

}

function completeChoice(
  raw: Record<string, unknown>,
  provider: string
): { choice: Record<string, unknown>; message: Record<string, unknown> } {
  if (!Array.isArray(raw.choices) || raw.choices.length === 0) {
    throw new ModelGatewayError(
      `${provider} response is malformed: choices must be a non-empty array.`,
      "protocol"
    );
  }
  const choice = raw.choices[0];
  if (!choice || typeof choice !== "object" || Array.isArray(choice)) {
    throw new ModelGatewayError(
      `${provider} response is malformed: choices[0] must be an object.`,
      "protocol"
    );
  }
  const message = (choice as Record<string, unknown>).message;
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    throw new ModelGatewayError(
      `${provider} response is malformed: choices[0].message must be an object.`,
      "protocol"
    );
  }
  return {
    choice: choice as Record<string, unknown>,
    message: message as Record<string, unknown>
  };
}

function rawUsage(usage: Record<string, unknown>): RawUsage {
  const inputDetails = usage.prompt_tokens_details && typeof usage.prompt_tokens_details === "object"
    ? usage.prompt_tokens_details as Record<string, unknown> : {};
  const outputDetails = usage.completion_tokens_details && typeof usage.completion_tokens_details === "object"
    ? usage.completion_tokens_details as Record<string, unknown> : {};
  return {
    inputTokens: typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : undefined,
    outputTokens: typeof usage.completion_tokens === "number" ? usage.completion_tokens : undefined,
    cacheReadTokens: typeof inputDetails.cached_tokens === "number" ? inputDetails.cached_tokens : undefined,
    reasoningTokens: typeof outputDetails.reasoning_tokens === "number" ? outputDetails.reasoning_tokens : undefined
  };
}

function missingKeyError(provider: string, apiKeyName: string): ModelGatewayError {
  return new ModelGatewayError(`${provider} API key is missing. Set ${apiKeyName}.`, "configuration");
}

function httpError(provider: string, status: number, detail: string, prefix = ""): ModelGatewayError {
  let category: ModelFailureCategory = "protocol";
  if (status === 401 || status === 403) category = "auth";
  else if (status === 429) category = "rate_limit";
  else if (status >= 500) category = "server";
  return Object.assign(
    new ModelGatewayError(`${provider} ${prefix}HTTP ${status}: ${detail}`, category, false, status),
    { retryable: status === 429 || status >= 500 }
  );
}
