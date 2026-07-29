import type {
  AssistantMessage,
  Context,
  CredentialStore,
  Message,
  Model as PiModel,
  TextContent,
  ThinkingContent,
  ToolCall as PiToolCall,
  ToolResultMessage
} from "@earendil-works/pi-ai";
import type {
  JsonValue,
  ModelCapabilities,
  ModelGateway,
  ModelMessage,
  ModelRequest,
  ModelResponse,
  ModelStreamEvent,
  ModelToolCall
} from "agent-protocol";
import { FileCredentialStore } from "./credential-store.js";
import { OpenAICodexError, sanitizeOpenAICodexError } from "./errors.js";
import {
  createOpenAICodexModels,
  getOpenAICodexPiModel,
  OPENAI_CODEX_PROVIDER_ID
} from "./models.js";
import { monitoredCodexStream } from "./stream-timeout.js";

interface ReplayState {
  responseId?: string;
  content: AssistantMessage["content"];
}

export interface OpenAICodexGatewayOptions {
  model: string;
  credentials?: CredentialStore;
  maxRetries?: number;
  requestTimeoutMs?: number;
  idleTimeoutMs?: number;
  activeStreamTimeoutMs?: number;
}

function jsonRecord(value: JsonValue): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function replayState(message: ModelMessage): ReplayState | undefined {
  const state = message.providerState;
  if (state?.provider !== OPENAI_CODEX_PROVIDER_ID || state.version !== 1
    || !state.data || typeof state.data !== "object" || Array.isArray(state.data)) return undefined;
  const data = state.data as Record<string, JsonValue>;
  if (!Array.isArray(data.content)) return undefined;
  return {
    ...(typeof data.responseId === "string" ? { responseId: data.responseId } : {}),
    content: data.content as unknown as AssistantMessage["content"]
  };
}

function assistantContent(message: ModelMessage): AssistantMessage["content"] {
  const replay = replayState(message);
  if (replay) return replay.content;
  const content: AssistantMessage["content"] = [];
  if (message.reasoningContent) {
    content.push({ type: "thinking", thinking: message.reasoningContent });
  }
  if (message.content) content.push({ type: "text", text: message.content });
  for (const call of message.toolCalls ?? []) {
    content.push({
      type: "toolCall",
      id: call.id,
      name: call.name,
      arguments: jsonRecord(call.arguments)
    });
  }
  return content;
}

function piAssistantMessage(message: ModelMessage, model: PiModel<"openai-codex-responses">): AssistantMessage {
  const replay = replayState(message);
  return {
    role: "assistant",
    content: assistantContent(message),
    api: "openai-codex-responses",
    provider: OPENAI_CODEX_PROVIDER_ID,
    model: model.id,
    ...(replay?.responseId ? { responseId: replay.responseId } : {}),
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    },
    stopReason: (message.toolCalls?.length ?? 0) > 0 ? "toolUse" : "stop",
    timestamp: Date.now()
  };
}

function systemPrompt(messages: readonly ModelMessage[]): string | undefined {
  const sections = messages.flatMap((message) =>
    message.role === "system" || message.role === "developer"
      ? [`<${message.role}>\n${message.content}\n</${message.role}>`]
      : []);
  return sections.length > 0 ? sections.join("\n\n") : undefined;
}

function contextMessages(
  messages: readonly ModelMessage[],
  model: PiModel<"openai-codex-responses">
): Message[] {
  const result: Message[] = [];
  const toolNames = new Map<string, string>();
  for (const message of messages) {
    if (message.role === "system" || message.role === "developer") continue;
    if (message.role === "user") {
      result.push({ role: "user", content: message.content, timestamp: Date.now() });
      continue;
    }
    if (message.role === "assistant") {
      for (const call of message.toolCalls ?? []) toolNames.set(call.id, call.name);
      result.push(piAssistantMessage(message, model));
      continue;
    }
    if (!message.toolCallId) continue;
    const toolResult: ToolResultMessage = {
      role: "toolResult",
      toolCallId: message.toolCallId,
      toolName: toolNames.get(message.toolCallId) ?? "tool",
      content: [{ type: "text", text: message.content }],
      isError: false,
      timestamp: Date.now()
    };
    result.push(toolResult);
  }
  return result;
}

function piContext(
  request: ModelRequest,
  model: PiModel<"openai-codex-responses">
): Context {
  return {
    ...(systemPrompt(request.messages) ? { systemPrompt: systemPrompt(request.messages) } : {}),
    messages: contextMessages(request.messages, model),
    ...(request.tools?.length ? {
      tools: request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema
      }))
    } : {})
  };
}

function modelToolCall(call: PiToolCall): ModelToolCall {
  return { id: call.id, name: call.name, arguments: call.arguments as JsonValue };
}

function responseMessage(message: AssistantMessage): ModelMessage {
  const text = message.content.filter((item): item is TextContent => item.type === "text")
    .map((item) => item.text).join("");
  const reasoning = message.content
    .filter((item): item is ThinkingContent => item.type === "thinking")
    .map((item) => item.thinking).join("");
  const calls = message.content
    .filter((item): item is PiToolCall => item.type === "toolCall")
    .map(modelToolCall);
  const replay: Record<string, JsonValue> = {
    content: message.content as unknown as JsonValue
  };
  if (message.responseId) replay.responseId = message.responseId;
  return {
    role: "assistant",
    content: text,
    ...(reasoning ? { reasoningContent: reasoning } : {}),
    ...(calls.length > 0 ? { toolCalls: calls } : {}),
    providerState: {
      provider: OPENAI_CODEX_PROVIDER_ID,
      version: 1,
      data: replay
    }
  };
}

function finishReason(message: AssistantMessage): ModelResponse["finishReason"] {
  if (message.stopReason === "length") return "length";
  if (message.stopReason === "toolUse") return "tool_calls";
  return "stop";
}

function responseUsage(message: AssistantMessage, startedAt: number): ModelResponse["usage"] {
  return {
    inputTokens: message.usage.input + message.usage.cacheRead + message.usage.cacheWrite,
    outputTokens: message.usage.output,
    reasoningTokens: message.usage.reasoning ?? 0,
    cacheReadTokens: message.usage.cacheRead,
    cacheWriteTokens: message.usage.cacheWrite,
    providerReported: true,
    costMicroUsd: null,
    billingMode: "subscription",
    latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
    retryAttempt: 0
  };
}

function approximateTokens(value: unknown): number {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
  let cjk = 0;
  let bytes = 0;
  for (const character of text) {
    if (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(character)) cjk += 1;
    else bytes += Buffer.byteLength(character, "utf8");
  }
  return cjk + Math.ceil(bytes / 4);
}

export class OpenAICodexGateway implements ModelGateway {
  readonly provider = OPENAI_CODEX_PROVIDER_ID;
  readonly model: string;
  readonly capabilities: ModelCapabilities;
  private readonly models;
  private readonly piModel;
  private readonly maxRetries: number;
  private readonly requestTimeoutMs?: number;
  private readonly idleTimeoutMs: number;
  private readonly activeStreamTimeoutMs?: number;

  constructor(options: OpenAICodexGatewayOptions) {
    this.model = options.model;
    const piModel = getOpenAICodexPiModel(options.model);
    if (!piModel) throw new OpenAICodexError("protocol", "protocol");
    this.piModel = piModel;
    this.models = createOpenAICodexModels(options.credentials ?? new FileCredentialStore());
    this.maxRetries = options.maxRetries ?? 0;
    this.requestTimeoutMs = options.requestTimeoutMs;
    this.idleTimeoutMs = Math.max(1, Math.trunc(options.idleTimeoutMs ?? 45_000));
    this.activeStreamTimeoutMs = options.activeStreamTimeoutMs === undefined
      ? undefined
      : Math.max(1, Math.trunc(options.activeStreamTimeoutMs));
    this.capabilities = {
      contextWindowTokens: piModel.contextWindow,
      maxOutputTokens: piModel.maxTokens,
      tools: true,
      parallelTools: true,
      reasoning: piModel.reasoning,
      structuredOutput: true,
      promptCache: true,
      tokenizer: "approximate",
      strictToolChoice: true
    };
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    for await (const event of this.stream(request)) {
      if (event.type === "done") return event.response;
    }
    throw new OpenAICodexError("protocol", "protocol");
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    const startedAt = performance.now();
    let toolIndex = 0;
    try {
      const stream = monitoredCodexStream((signal) =>
        this.models.stream(this.piModel, piContext(request, this.piModel), {
          signal,
          transport: "sse",
          maxTokens: request.maxOutputTokens,
          temperature: request.temperature,
          toolChoice: request.toolChoice,
          maxRetries: this.maxRetries,
          ...(this.requestTimeoutMs ? { timeoutMs: this.requestTimeoutMs } : {})
        }), {
        signal: request.signal,
        idleTimeoutMs: this.idleTimeoutMs,
        ...(this.activeStreamTimeoutMs === undefined
          ? {}
          : { activeTimeoutMs: this.activeStreamTimeoutMs })
      });
      for await (const event of stream) {
        if (event.type === "text_delta") yield { type: "content", delta: event.delta };
        else if (event.type === "thinking_delta") yield { type: "reasoning", delta: event.delta };
        else if (event.type === "toolcall_end") {
          yield { type: "tool_call", index: toolIndex++, call: modelToolCall(event.toolCall) };
        } else if (event.type === "done") {
          const usage = responseUsage(event.message, startedAt);
          yield { type: "usage", inputTokens: usage.inputTokens, outputTokens: usage.outputTokens };
          yield {
            type: "done",
            response: {
              message: responseMessage(event.message),
              finishReason: finishReason(event.message),
              usage
            }
          };
          return;
        } else if (event.type === "error") {
          request.signal.throwIfAborted();
          throw sanitizeOpenAICodexError(event.error.errorMessage ?? event.reason);
        }
      }
      throw new OpenAICodexError("protocol", "protocol");
    } catch (error) {
      request.signal.throwIfAborted();
      throw sanitizeOpenAICodexError(error);
    }
  }

  async countTokens(messages: ModelMessage[], tools = []): Promise<number> {
    return approximateTokens({ messages, tools });
  }
}
