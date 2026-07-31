import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Message,
  Model as PiModel,
  TextContent,
  ThinkingContent,
  ToolCall as PiToolCall,
  ToolResultMessage
} from "@earendil-works/pi-ai";
import type {
  JsonValue,
  ModelMessage,
  ModelRequest,
  ModelResponse,
  ModelStreamEvent,
  ModelToolCall
} from "agent-protocol";
import type { PiBillingMode } from "./models.js";

interface ReplayState {
  responseId?: string;
  content: AssistantMessage["content"];
}

export interface MappedPiStreamEvent {
  events: readonly ModelStreamEvent[];
  done: boolean;
  nextToolIndex: number;
  error?: Error;
}

function jsonRecord(value: JsonValue): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function replayState(
  message: ModelMessage,
  model: PiModel<Api>
): ReplayState | undefined {
  const state = message.providerState;
  if (state?.provider !== model.provider || state.version !== 1
    || !state.data || typeof state.data !== "object" || Array.isArray(state.data)) {
    return undefined;
  }
  const data = state.data as Record<string, JsonValue>;
  if (!Array.isArray(data.content)) return undefined;
  if (data.model !== model.id) return undefined;
  if (data.api !== model.api) return undefined;
  return {
    ...(typeof data.responseId === "string" ? { responseId: data.responseId } : {}),
    content: data.content as unknown as AssistantMessage["content"]
  };
}

function assistantContent(
  message: ModelMessage,
  model: PiModel<Api>
): AssistantMessage["content"] {
  const replay = replayState(message, model);
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

function emptyUsage(): AssistantMessage["usage"] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  };
}

function piAssistantMessage(
  message: ModelMessage,
  model: PiModel<Api>
): AssistantMessage {
  const replay = replayState(message, model);
  return {
    role: "assistant",
    content: assistantContent(message, model),
    api: model.api,
    provider: model.provider,
    model: model.id,
    ...(replay?.responseId ? { responseId: replay.responseId } : {}),
    usage: emptyUsage(),
    stopReason: (message.toolCalls?.length ?? 0) > 0 ? "toolUse" : "stop",
    timestamp: Date.now()
  };
}

function instructionBlock(message: ModelMessage): string {
  return `<${message.role}>\n${message.content}\n</${message.role}>`;
}

function contextParts(
  messages: readonly ModelMessage[],
  model: PiModel<Api>
): { systemPrompt?: string; messages: Message[] } {
  const instructions: string[] = [];
  const result: Message[] = [];
  const toolNames = new Map<string, string>();
  let conversationStarted = false;
  for (const message of messages) {
    if (message.role === "system" || message.role === "developer") {
      if (model.provider === "deepseek" && conversationStarted) {
        result.push({
          role: "user",
          content: `<latest_reminder>\n${message.content}\n</latest_reminder>`,
          timestamp: Date.now()
        });
      } else {
        instructions.push(instructionBlock(message));
      }
      continue;
    }
    conversationStarted = true;
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
  return {
    ...(instructions.length > 0 ? { systemPrompt: instructions.join("\n\n") } : {}),
    messages: result
  };
}

export function piContext(request: ModelRequest, model: PiModel<Api>): Context {
  const parts = contextParts(request.messages, model);
  return {
    ...parts,
    ...(request.tools?.length ? {
      tools: request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema as never
      }))
    } : {})
  };
}

export function modelToolCall(call: PiToolCall): ModelToolCall {
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
    api: message.api,
    model: message.model,
    content: message.content as unknown as JsonValue
  };
  if (message.responseId) replay.responseId = message.responseId;
  return {
    role: "assistant",
    content: text,
    ...(reasoning ? { reasoningContent: reasoning } : {}),
    ...(calls.length > 0 ? { toolCalls: calls } : {}),
    providerState: {
      provider: message.provider,
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

function responseUsage(
  message: AssistantMessage,
  startedAt: number,
  billingMode: PiBillingMode
): ModelResponse["usage"] {
  const costMicroUsd = billingMode === "metered"
    ? Math.max(0, Math.ceil(message.usage.cost.total * 1_000_000))
    : null;
  return {
    inputTokens: message.usage.input + message.usage.cacheRead + message.usage.cacheWrite,
    outputTokens: message.usage.output,
    reasoningTokens: message.usage.reasoning ?? 0,
    cacheReadTokens: message.usage.cacheRead,
    cacheWriteTokens: message.usage.cacheWrite,
    providerReported: true,
    costMicroUsd,
    billingMode,
    latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
    retryAttempt: 0
  };
}

export function approximateTokens(value: unknown): number {
  const serialized = typeof value === "string" ? value : JSON.stringify(value) ?? "";
  let cjk = 0;
  let bytes = 0;
  for (const character of serialized) {
    if (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(character)) {
      cjk += 1;
    } else {
      bytes += Buffer.byteLength(character, "utf8");
    }
  }
  return cjk + Math.ceil(bytes / 4);
}

export function deepSeekPayload(payload: unknown, request: ModelRequest): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  if (request.toolChoice !== "required" && request.toolChoice !== "none") return payload;
  return {
    ...(payload as Record<string, unknown>),
    thinking: { type: "disabled" }
  };
}

function providerEventError(
  event: Extract<AssistantMessageEvent, { type: "error" }>,
  responseStatus: number | undefined
): Error {
  return Object.assign(
    new Error(event.error.errorMessage ?? event.reason),
    responseStatus === undefined ? {} : { status: responseStatus }
  );
}

export function mapPiStreamEvent(
  event: AssistantMessageEvent,
  toolIndex: number,
  startedAt: number,
  billingMode: PiBillingMode,
  responseStatus: number | undefined
): MappedPiStreamEvent {
  switch (event.type) {
    case "text_delta":
      return {
        events: [{ type: "content", delta: event.delta }],
        done: false,
        nextToolIndex: toolIndex
      };
    case "thinking_delta":
      return {
        events: [{ type: "reasoning", delta: event.delta }],
        done: false,
        nextToolIndex: toolIndex
      };
    case "toolcall_end":
      return {
        events: [{ type: "tool_call", index: toolIndex, call: modelToolCall(event.toolCall) }],
        done: false,
        nextToolIndex: toolIndex + 1
      };
    case "done": {
      const usage = responseUsage(event.message, startedAt, billingMode);
      return {
        events: [
          { type: "usage", inputTokens: usage.inputTokens, outputTokens: usage.outputTokens },
          {
            type: "done",
            response: {
              message: responseMessage(event.message),
              finishReason: finishReason(event.message),
              usage
            }
          }
        ],
        done: true,
        nextToolIndex: toolIndex
      };
    }
    case "error":
      return {
        events: [],
        done: false,
        nextToolIndex: toolIndex,
        error: providerEventError(event, responseStatus)
      };
    default:
      return { events: [], done: false, nextToolIndex: toolIndex };
  }
}
