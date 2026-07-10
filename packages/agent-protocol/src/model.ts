import type { JsonValue } from "./json.js";

export type ModelRole = "system" | "developer" | "user" | "assistant" | "tool";

export interface ModelToolCall {
  id: string;
  name: string;
  arguments: JsonValue;
}

export interface ModelMessage {
  role: ModelRole;
  content: string;
  reasoningContent?: string;
  toolCallId?: string;
  toolCalls?: ModelToolCall[];
}

export interface ModelToolDefinition {
  name: string;
  description: string;
  inputSchema: { [key: string]: JsonValue };
}

export interface ModelCapabilities {
  contextWindowTokens: number;
  maxOutputTokens: number;
  tools: boolean;
  parallelTools: boolean;
  reasoning: boolean;
  structuredOutput: boolean;
  promptCache: boolean;
  tokenizer: "provider" | "approximate";
}

export type ModelFinishReason = "stop" | "length" | "tool_calls" | "content_filter" | "protocol_error";

export interface ModelRequest {
  messages: ModelMessage[];
  tools?: ModelToolDefinition[];
  maxOutputTokens?: number;
  temperature?: number;
  signal: AbortSignal;
}

export interface ModelResponse {
  message: ModelMessage;
  finishReason: ModelFinishReason;
  inputTokens?: number;
  outputTokens?: number;
  raw?: JsonValue;
}

export type ModelStreamEvent =
  | { type: "content"; delta: string }
  | { type: "reasoning"; delta: string }
  | { type: "tool_call"; index: number; call: ModelToolCall }
  | { type: "usage"; inputTokens?: number; outputTokens?: number }
  | { type: "done"; response: ModelResponse };

export interface ModelGateway {
  readonly provider: string;
  readonly model: string;
  readonly capabilities: ModelCapabilities;
  complete(request: ModelRequest): Promise<ModelResponse>;
  stream(request: ModelRequest): AsyncIterable<ModelStreamEvent>;
  countTokens(messages: ModelMessage[], tools?: ModelToolDefinition[]): Promise<number>;
}
