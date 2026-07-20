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

export interface ModelResponseUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  providerReported: boolean;
  costMicroUsd: number | null;
  latencyMs: number;
  /** Zero-based retry index within the selected provider/model. */
  retryAttempt: number;
}

export interface ModelRequest {
  messages: ModelMessage[];
  tools?: ModelToolDefinition[];
  toolChoice?: "auto" | "required" | "none";
  maxOutputTokens?: number;
  temperature?: number;
  signal: AbortSignal;
}

export interface ModelResponse {
  message: ModelMessage;
  finishReason: ModelFinishReason;
  /** Required V3 accounting data; gateways estimate conservatively when providers omit usage. */
  usage: ModelResponseUsage;
  /** @deprecated V2 compatibility projection. */
  inputTokens?: number;
  /** @deprecated V2 compatibility projection. */
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
  /** Host-attested upper bound on content-token contribution per UTF-8 byte.
   * Message framing is accounted separately. This is adapter/configuration
   * metadata, never a value accepted from a model or provider response.
   * Unknown bounds stay absent. */
  readonly maxTokensPerUtf8Byte?: number;
  complete(request: ModelRequest): Promise<ModelResponse>;
  stream(request: ModelRequest): AsyncIterable<ModelStreamEvent>;
  countTokens(messages: ModelMessage[], tools?: ModelToolDefinition[]): Promise<number>;
}
