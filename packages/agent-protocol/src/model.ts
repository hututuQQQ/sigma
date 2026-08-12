import type { JsonValue } from "./json.js";

export type ModelRole = "system" | "developer" | "user" | "assistant" | "tool";

export interface ModelToolCall {
  id: string;
  name: string;
  arguments: JsonValue;
}

export interface ModelProviderState {
  provider: string;
  version: 1;
  data: JsonValue;
}

/** Provider-neutral image input retained in durable conversation history. */
export interface ModelImage {
  data: string;
  mimeType: string;
}

export interface ModelMessage {
  role: ModelRole;
  content: string;
  images?: ModelImage[];
  reasoningContent?: string;
  toolCallId?: string;
  /** Provider-native tool result status. Only meaningful for tool messages. */
  isError?: boolean;
  toolCalls?: ModelToolCall[];
  providerState?: ModelProviderState;
}

/**
 * Conservative model-visible cost for one auto/high-detail image input.
 * Inline base64 is a transport representation, not text consumed by the
 * model. The estimate mirrors the resized-image heuristic used by Codex:
 * 7,373 model-visible bytes at four bytes per token, rounded up.
 */
export const MODEL_IMAGE_INPUT_TOKEN_ESTIMATE = 1_844;

export function modelImageInputTokenEstimate(messages: readonly ModelMessage[]): number {
  return messages.reduce(
    (total, message) => total + (message.images?.length ?? 0) * MODEL_IMAGE_INPUT_TOKEN_ESTIMATE,
    0
  );
}

/** Preserve image block metadata while excluding transport-only base64 from text tokenizers. */
export function modelMessagesWithoutImagePayloads(
  messages: readonly ModelMessage[]
): ModelMessage[] {
  return messages.map((message) => message.images?.length
    ? {
        ...message,
        images: message.images.map((image) => ({ ...image, data: "" }))
      }
    : message);
}

export interface ModelToolDefinition {
  name: string;
  description: string;
  inputSchema: { [key: string]: JsonValue };
  /** Provider-neutral presentation hints. Gateways that do not implement
   * deferred tool loading ignore this metadata and expose the tool normally. */
  presentation?: ModelToolPresentation;
}

export type ModelToolExposure = "direct" | "deferred";

export interface ModelToolNamespace {
  name: string;
  description: string;
}

export interface ModelToolPresentation {
  exposure: ModelToolExposure;
  namespace?: ModelToolNamespace;
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
  /**
   * The active provider/wire profile accepts an explicit sampling temperature.
   * Omitted means unknown and preserves the caller's request for third-party
   * gateways; `false` requires the harness to omit the field entirely.
   */
  temperatureControl?: boolean;
  /** The selected model accepts image blocks in user messages. */
  imageInput?: boolean;
  /**
   * The active provider/wire profile can honor toolChoice="required".
   * Optional so third-party gateways remain source compatible.
   */
  strictToolChoice?: boolean;
  /**
   * Thinking-mode tool calls must be replayed with the provider-returned
   * reasoning field. Complete non-thinking blocks without that field
   * are projected as one non-executable trajectory tombstone.
   */
  requiresToolCallReasoningReplay?: boolean;
  /** A strict tool choice is implemented by temporarily disabling thinking. */
  strictToolChoiceDisablesReasoning?: boolean;
  /** The selected provider/model/transport supports provider-hosted deferred
   * tool search. This is a wire capability, never a model-name policy. */
  hostedToolSearch?: boolean;
}

export type ModelFinishReason = "stop" | "length" | "tool_calls" | "content_filter" | "protocol_error";
export type ModelBillingMode = "metered" | "subscription" | "unpriced";

export interface ModelResponseUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  providerReported: boolean;
  costMicroUsd: number | null;
  billingMode?: ModelBillingMode;
  latencyMs: number;
  /** Zero-based retry index within the selected provider/model. */
  retryAttempt: number;
}

export interface ModelRequest {
  /**
   * Stable, opaque conversation identity used only for provider-side cache
   * affinity. It must not contain credentials or user-visible prompt text.
   */
  sessionId?: string;
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
  /** Accounting data; gateways estimate conservatively when providers omit usage. */
  usage: ModelResponseUsage;
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
  /** Release provider-side session affinity and transport resources. */
  releaseSession?(sessionId: string): void | Promise<void>;
}
