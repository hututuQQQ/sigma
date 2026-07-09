import type {
  JsonValue,
  ModelCapabilities,
  ModelFinishReason,
  ModelGateway,
  ModelMessage,
  ModelRequest,
  ModelResponse,
  ModelStreamEvent,
  ModelToolCall,
  ModelToolDefinition
} from "agent-protocol";
import { ssePayloads } from "./sse.js";

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

function openAiMessages(messages: ModelMessage[]): JsonValue[] {
  return messages.map((message) => ({
    role: message.role,
    content: message.content,
    ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
    ...(message.toolCalls ? { tool_calls: message.toolCalls.map((call) => ({
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: JSON.stringify(call.arguments) }
    })) } : {})
  }));
}

function openAiTools(tools: ModelToolDefinition[] | undefined): JsonValue[] | undefined {
  return tools?.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } }));
}

function bodyFor(request: ModelRequest, model: string, stream: boolean): Record<string, JsonValue> {
  const tools = openAiTools(request.tools);
  return {
    model,
    messages: openAiMessages(request.messages),
    ...(tools?.length ? { tools, tool_choice: "auto" } : { tool_choice: "none" }),
    ...(request.maxOutputTokens ? { max_tokens: request.maxOutputTokens } : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(stream ? { stream: true, stream_options: { include_usage: true } } : {})
  };
}

function jsonValue(value: unknown): JsonValue {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(jsonValue);
  if (!value || typeof value !== "object") return null;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, jsonValue(item)]));
}

function parseArguments(value: string): JsonValue {
  try { return jsonValue(JSON.parse(value)); } catch { return value; }
}

function normalizedFinishReason(value: unknown, hasTools: boolean): ModelFinishReason {
  if (value === "stop") return "stop";
  if (value === "length") return "length";
  if (value === "content_filter") return "content_filter";
  if (value === "tool_calls" || hasTools) return "tool_calls";
  return "protocol_error";
}

interface StreamProgress { deliveredContent: string; deliveredReasoning: string }
interface StreamAttemptStatus { semantic: boolean; retryAllowed: boolean; retryAfter: string | null }
interface StreamRetryCounts { infrastructure: number; partial: number }
interface StreamCallParts { id?: string; name?: string; arguments: string }

function finalizeCalls(calls: Map<number, StreamCallParts>): ModelToolCall[] {
  return [...calls.entries()].sort(([left], [right]) => left - right).flatMap(([index, call]): ModelToolCall[] => call.name
    ? [{ id: call.id ?? `call_${index}`, name: call.name, arguments: parseArguments(call.arguments) }]
    : []);
}

class StreamDecoder {
  private readonly calls = new Map<number, StreamCallParts>();
  private content = "";
  private reasoningContent = "";
  private inputTokens: number | undefined;
  private outputTokens: number | undefined;
  private finish: unknown;

  constructor(
    private readonly provider: string,
    private readonly progress: StreamProgress,
    private readonly status: StreamAttemptStatus
  ) {}

  consume(payload: string): ModelStreamEvent[] {
    const chunk = JSON.parse(payload) as Record<string, unknown>;
    const events = this.consumeUsage(chunk);
    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    for (const choice of choices) events.push(...this.consumeChoice(choice));
    return events;
  }

  done(): ModelStreamEvent {
    const calls = finalizeCalls(this.calls);
    if (this.content !== this.progress.deliveredContent) {
      throw new Error(`${this.provider} restarted stream ended before the prior stable boundary.`);
    }
    return { type: "done", response: {
      message: { role: "assistant", content: this.content, ...(calls.length ? { toolCalls: calls } : {}) },
      finishReason: normalizedFinishReason(this.finish, calls.length > 0),
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens
    } };
  }

  private consumeUsage(chunk: Record<string, unknown>): ModelStreamEvent[] {
    const usage = chunk.usage && typeof chunk.usage === "object" ? chunk.usage as Record<string, unknown> : {};
    const hasInput = typeof usage.prompt_tokens === "number";
    const hasOutput = typeof usage.completion_tokens === "number";
    if (!hasInput && !hasOutput) return [];
    this.inputTokens = hasInput ? usage.prompt_tokens as number : this.inputTokens;
    this.outputTokens = hasOutput ? usage.completion_tokens as number : this.outputTokens;
    return [{ type: "usage", inputTokens: this.inputTokens, outputTokens: this.outputTokens }];
  }

  private consumeChoice(value: unknown): ModelStreamEvent[] {
    const choice = value && typeof value === "object" ? value as Record<string, unknown> : {};
    if (choice.finish_reason !== undefined) this.finish = choice.finish_reason;
    const delta = choice.delta && typeof choice.delta === "object" ? choice.delta as Record<string, unknown> : {};
    return [
      ...this.consumeText("content", delta.content),
      ...this.consumeText("reasoning", delta.reasoning_content),
      ...this.consumeToolCalls(delta.tool_calls)
    ];
  }

  private consumeText(kind: "content" | "reasoning", value: unknown): ModelStreamEvent[] {
    if (typeof value !== "string" || !value) return [];
    const current = kind === "content" ? this.content + value : this.reasoningContent + value;
    const delivered = kind === "content" ? this.progress.deliveredContent : this.progress.deliveredReasoning;
    if (!delivered.startsWith(current) && !current.startsWith(delivered)) {
      this.status.retryAllowed = false;
      const label = kind === "reasoning" ? " reasoning" : "";
      throw new Error(`${this.provider} restarted${label} stream diverged before the prior stable boundary.`);
    }
    if (kind === "content") this.content = current; else this.reasoningContent = current;
    if (current.length <= delivered.length) return [];
    const delta = current.slice(delivered.length);
    if (kind === "content") this.progress.deliveredContent = current; else this.progress.deliveredReasoning = current;
    this.status.semantic = true;
    return [kind === "content" ? { type: "content", delta } : { type: "reasoning", delta }];
  }

  private consumeToolCalls(value: unknown): ModelStreamEvent[] {
    const events: ModelStreamEvent[] = [];
    for (const raw of Array.isArray(value) ? value : []) {
      const item = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
      const index = typeof item.index === "number" ? item.index : this.calls.size;
      const fn = item.function && typeof item.function === "object" ? item.function as Record<string, unknown> : {};
      const current = this.calls.get(index) ?? { arguments: "" };
      if (typeof item.id === "string") current.id = item.id;
      if (typeof fn.name === "string") current.name = fn.name;
      if (typeof fn.arguments === "string") current.arguments += fn.arguments;
      this.calls.set(index, current);
      if (!current.name) continue;
      this.status.semantic = true;
      events.push({ type: "tool_call", index, call: {
        id: current.id ?? `call_${index}`,
        name: current.name,
        arguments: parseArguments(current.arguments)
      } });
    }
    return events;
  }
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
  }

  async countTokens(messages: ModelMessage[], tools: ModelToolDefinition[] = []): Promise<number> {
    return approximateTokens(JSON.stringify({ messages, tools }));
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const raw = await this.fetchJsonWithRetry(bodyFor(request, this.model, false), request.signal);
    const choice = Array.isArray(raw.choices) && raw.choices[0] && typeof raw.choices[0] === "object"
      ? raw.choices[0] as Record<string, unknown> : {};
    const message = choice.message && typeof choice.message === "object" ? choice.message as Record<string, unknown> : {};
    const calls = this.parseCompleteCalls(message.tool_calls);
    const usage = raw.usage && typeof raw.usage === "object" ? raw.usage as Record<string, unknown> : {};
    return {
      message: { role: "assistant", content: typeof message.content === "string" ? message.content : "", ...(calls.length ? { toolCalls: calls } : {}) },
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
    const decoder = new StreamDecoder(this.provider, progress, status);
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
      this.fetchInit(bodyFor(request, this.model, true), signal)
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
          return await response.json() as Record<string, unknown>;
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
