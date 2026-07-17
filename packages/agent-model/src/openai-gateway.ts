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
import { ModelGatewayError, type ModelPricing } from "./catalog.js";
import {
  approximateTokenCount,
  normalizeModelResponse,
  type NormalizedModelResponse,
  type UnnormalizedModelResponse
} from "./usage.js";
import {
  abortable,
  addSseState,
  completeChoice,
  type DecodedStreamEvent,
  defaultOpenAICapabilities,
  httpError,
  missingKeyError,
  modelDeadline,
  modelErrorSummary,
  modelRetryDelay,
  normalizeGatewayError,
  rawUsage,
  streamDiagnostics,
  streamProtocolError,
  type StreamRetryCounts,
  waitForModelRetry,
  withStreamDiagnostics
} from "./openai-gateway-support.js";

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
  activeStreamTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  wireProfile?: Partial<OpenAIWireProfile>;
  pricing?: ModelPricing;
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
  private readonly activeStreamTimeoutMs?: number;
  private readonly fetchImpl: typeof fetch;
  private readonly wireProfile: OpenAIWireProfile;
  private readonly retryableFinishReasons: ReadonlySet<string>;
  private readonly pricing?: ModelPricing;

  constructor(options: OpenAIModelGatewayOptions) {
    this.provider = options.provider;
    this.model = options.model;
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    // Secrets copied from files or CI settings can carry a UTF-8 BOM or a
    // trailing line ending. Neither is credential material, and Fetch rejects
    // non-ByteString header characters before the request reaches the provider.
    this.apiKey = options.apiKey?.trim();
    this.apiKeyName = options.apiKeyName;
    this.capabilities = { ...defaultOpenAICapabilities, ...options.capabilities };
    this.maxRetries = Math.max(0, Math.trunc(options.maxRetries ?? 2));
    this.requestTimeoutMs = Math.max(1, Math.trunc(options.requestTimeoutMs ?? 120_000));
    this.idleTimeoutMs = Math.max(1, Math.trunc(options.idleTimeoutMs ?? 45_000));
    this.activeStreamTimeoutMs = options.activeStreamTimeoutMs === undefined
      ? undefined : Math.max(1, Math.trunc(options.activeStreamTimeoutMs));
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
    const progress: StreamProgress = { deliveredContent: "", deliveredReasoning: "" };
    const retries: StreamRetryCounts = { infrastructure: 0, partial: 0 };
    const transport = createSseStreamState();
    let lastEventType = "none";
    for (let attempt = 0; ; attempt += 1) {
        const status: StreamAttemptStatus = {
          semantic: false,
          retryAllowed: true,
          retryAfter: null,
          doneReceived: false,
          lastEventType,
          hasContent: progress.deliveredContent.length > 0,
          hasReasoning: progress.deliveredReasoning.length > 0,
          hasToolCall: false
        };
        const sse = createSseStreamState();
        try {
          for await (const event of this.streamAttempt(
            request, request.signal, progress, status, sse, attempt + 1
          )) {
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
          lastEventType = status.lastEventType;
          addSseState(transport, sse);
          await this.retryStream(
            error, attempt, request.signal, progress, status, retries, transport, attempt + 1
          );
        }
    }
  }

  private async *streamAttempt(
    request: ModelRequest,
    signal: AbortSignal,
    progress: StreamProgress,
    status: StreamAttemptStatus,
    sse: SseStreamState,
    retryAttempts: number
  ): AsyncIterable<DecodedStreamEvent> {
    const body = await this.openFirstByteBody(request, signal, status, sse.startedAtMs);
    const decoder = new StreamDecoder(this.provider, progress, status, this.retryableFinishReasons);
    for await (const payload of ssePayloads(body, signal, {
      firstByteTimeoutMs: this.requestTimeoutMs,
      idleTimeoutMs: this.idleTimeoutMs,
      ...(this.activeStreamTimeoutMs === undefined ? {} : { activeTimeoutMs: this.activeStreamTimeoutMs })
    }, sse)) {
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

  private async openFirstByteBody(
    request: ModelRequest,
    signal: AbortSignal,
    status: StreamAttemptStatus,
    startedAtMs: number
  ): Promise<ReadableStream<Uint8Array>> {
    const firstByteRemainingMs = Math.max(1, this.requestTimeoutMs - (performance.now() - startedAtMs));
    const firstByteScope = modelDeadline(
      signal,
      firstByteRemainingMs,
      `Model stream first byte exceeded ${this.requestTimeoutMs}ms.`
    );
    try {
      return await this.openStreamBody(request, firstByteScope.signal, status);
    } finally {
      firstByteScope.close();
    }
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
    if (!response.body) throw new ModelGatewayError(`${this.provider} stream has no body.`, "protocol");
    return response.body;
  }

  private async retryStream(
    error: unknown,
    attempt: number,
    signal: AbortSignal,
    progress: StreamProgress,
    status: StreamAttemptStatus,
    retries: StreamRetryCounts,
    sse: SseStreamState,
    retryAttempts: number
  ): Promise<void> {
    const rawCode = error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code
      : "";
    const base = rawCode.startsWith("provider_")
      ? Object.assign(new ModelGatewayError(
          modelErrorSummary(error),
          rawCode === "provider_resource_exhausted" ? "capacity" : "protocol",
          status.semantic,
          status.httpStatus,
          { cause: error }
        ), { code: rawCode })
      : normalizeGatewayError(this.provider, error);
    const normalized = withStreamDiagnostics(
      this.provider, this.model, base, status, sse, retryAttempts, signal
    );
    if (signal.aborted) throw normalized;
    if (!status.retryAllowed) throw normalized;
    const partial = status.semantic || progress.deliveredContent.length > 0 || progress.deliveredReasoning.length > 0;
    if (partial) {
      retries.partial += 1;
      if (retries.partial > this.maxRetries) throw normalized;
    } else {
      retries.infrastructure += 1;
      if (retries.infrastructure > this.maxRetries) throw normalized;
    }
    await waitForModelRetry(modelRetryDelay(attempt, status.retryAfter), signal);
  }

  private async fetchJsonWithRetry(
    body: Record<string, JsonValue>,
    parent: AbortSignal
  ): Promise<{ raw: Record<string, unknown>; attempt: number }> {
    if (!this.apiKey) throw missingKeyError(this.provider, this.apiKeyName);
    const scope = modelDeadline(parent, this.requestTimeoutMs);
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
          await waitForModelRetry(modelRetryDelay(attempt, retryAfter), scope.signal);
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
