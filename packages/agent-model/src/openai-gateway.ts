import type {
  JsonValue,
  ModelCapabilities,
  ModelGateway,
  ModelMessage,
  ModelRequest,
  ModelResponse,
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
import { ssePayloads } from "./sse.js";

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

function approximateTokens(value: string): number {
  let tokens = 0;
  let latin = 0;
  for (const character of value) {
    if (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(character)) tokens += 1;
    else latin += Buffer.byteLength(character, "utf8");
  }
  return tokens + Math.ceil(latin / 4);
}

function deadline(parent: AbortSignal, timeoutMs: number): { signal: AbortSignal; close: () => void } {
  const controller = new AbortController();
  const onAbort = (): void => controller.abort(parent.reason ?? new Error("Model request aborted."));
  if (parent.aborted) onAbort(); else parent.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    const error = new Error(`Model request exceeded ${timeoutMs}ms.`);
    error.name = "TimeoutError";
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

interface StreamRetryCounts { infrastructure: number; partial: number }

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

  constructor(options: OpenAIModelGatewayOptions) {
    this.provider = options.provider;
    this.model = options.model;
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.apiKeyName = options.apiKeyName;
    this.capabilities = { ...defaultCapabilities, ...options.capabilities };
    this.maxRetries = options.maxRetries ?? 3;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 300_000;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 60_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.wireProfile = resolveWireProfile(options.wireProfile);
    this.retryableFinishReasons = new Set(this.wireProfile.retryableFinishReasons);
  }

  async countTokens(messages: ModelMessage[], tools: ModelToolDefinition[] = []): Promise<number> {
    return approximateTokens(JSON.stringify({ messages, tools }));
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const raw = await this.fetchJsonWithRetry(bodyFor(request, this.model, false, this.wireProfile), request.signal);
    const choice = Array.isArray(raw.choices) && raw.choices[0] && typeof raw.choices[0] === "object"
      ? raw.choices[0] as Record<string, unknown> : {};
    const message = choice.message && typeof choice.message === "object" ? choice.message as Record<string, unknown> : {};
    const calls = this.parseCompleteCalls(message.tool_calls);
    const usage = raw.usage && typeof raw.usage === "object" ? raw.usage as Record<string, unknown> : {};
    return {
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
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    if (!this.apiKey) throw new Error(`${this.provider} API key is missing. Set ${this.apiKeyName}.`);
    const scope = deadline(request.signal, this.requestTimeoutMs);
    const progress: StreamProgress = { deliveredContent: "", deliveredReasoning: "" };
    const retries: StreamRetryCounts = { infrastructure: 0, partial: 0 };
    try {
      for (let attempt = 0; ; attempt += 1) {
        const status: StreamAttemptStatus = { semantic: false, retryAllowed: true, retryAfter: null };
        try {
          for await (const event of this.streamAttempt(request, scope.signal, progress, status)) yield event;
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
    status: StreamAttemptStatus
  ): AsyncIterable<ModelStreamEvent> {
    const body = await this.openStreamBody(request, signal, status);
    const decoder = new StreamDecoder(this.provider, progress, status, this.retryableFinishReasons);
    for await (const payload of ssePayloads(body, signal, this.idleTimeoutMs)) {
      if (payload === "[DONE]") {
        yield decoder.done();
        return;
      }
      for (const event of decoder.consume(payload)) yield event;
    }
    throw new Error(`${this.provider} stream ended before [DONE].`);
  }

  private async openStreamBody(
    request: ModelRequest,
    signal: AbortSignal,
    status: StreamAttemptStatus
  ): Promise<ReadableStream<Uint8Array>> {
    const response = await this.fetchImpl(
      `${this.baseUrl}/chat/completions`,
      this.fetchInit(bodyFor(request, this.model, true, this.wireProfile), signal)
    );
    status.retryAfter = response.headers.get("retry-after");
    if (!response.ok) {
      status.retryAllowed = response.status === 429 || response.status >= 500;
      throw new Error(`${this.provider} stream HTTP ${response.status}: ${(await response.text()).slice(0, 800)}`);
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
    if (!status.retryAllowed) throw error;
    const partial = status.semantic || progress.deliveredContent.length > 0 || progress.deliveredReasoning.length > 0;
    if (partial) {
      retries.partial += 1;
      if (retries.partial > 2) throw error;
    } else {
      retries.infrastructure += 1;
      if (retries.infrastructure > this.maxRetries) throw error;
    }
    await wait(retryDelay(attempt, status.retryAfter), signal);
  }

  private async fetchJsonWithRetry(body: Record<string, JsonValue>, parent: AbortSignal): Promise<Record<string, unknown>> {
    if (!this.apiKey) throw new Error(`${this.provider} API key is missing. Set ${this.apiKeyName}.`);
    const scope = deadline(parent, this.requestTimeoutMs);
    try {
      for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
        let retryAfter: string | null = null;
        try {
          const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, this.fetchInit(body, scope.signal));
          retryAfter = response.headers.get("retry-after");
          if (!response.ok) {
            const retryable = response.status === 429 || response.status >= 500;
            const message = `${this.provider} HTTP ${response.status}: ${(await response.text()).slice(0, 800)}`;
            if (!retryable) throw Object.assign(new Error(message), { retryable: false });
            throw new Error(message);
          }
          const raw = await response.json() as Record<string, unknown>;
          const choice = Array.isArray(raw.choices) && raw.choices[0] && typeof raw.choices[0] === "object"
            ? raw.choices[0] as Record<string, unknown>
            : {};
          if (typeof choice.finish_reason === "string" && this.retryableFinishReasons.has(choice.finish_reason)) {
            throw providerFinishError(this.provider, choice.finish_reason);
          }
          return raw;
        } catch (error) {
          if (scope.signal.aborted) throw scope.signal.reason;
          if ((error as { retryable?: unknown }).retryable === false || attempt === this.maxRetries) throw error;
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
