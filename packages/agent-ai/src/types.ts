export type ProviderName = "deepseek" | "glm";

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: unknown;
  };
}

export interface SystemMessage {
  role: "system";
  content: string;
}

export interface UserMessage {
  role: "user";
  content: string;
}

export interface AssistantMessage {
  role: "assistant";
  content?: string;
  reasoningContent?: string;
  toolCalls?: ToolCall[];
}

export interface ToolMessage {
  role: "tool";
  toolCallId: string;
  name?: string;
  content: string;
}

export type AgentMessage = SystemMessage | UserMessage | AssistantMessage | ToolMessage;

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  cacheTokens?: number;
  totalTokens?: number;
}

export interface ModelRequest {
  messages: AgentMessage[];
  tools?: ToolDefinition[];
  toolChoice?: "auto" | "none";
  maxTokens?: number;
  temperature?: number;
  reasoning?: {
    enabled: boolean;
    effort?: "high" | "max";
  };
  metadata?: Record<string, string>;
}

export interface ModelResponse {
  message: AssistantMessage;
  usage?: Usage;
  raw?: unknown;
}

export interface ModelEvent {
  type: "message_delta" | "tool_call_delta" | "usage" | "done" | "error";
  data?: unknown;
}

export interface ModelClient {
  readonly provider: ProviderName;
  readonly model: string;
  complete(req: ModelRequest): Promise<ModelResponse>;
  stream?(req: ModelRequest): AsyncIterable<ModelEvent>;
}

export interface ProviderOptions {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  maxRetries?: number;
  fetchImpl?: typeof fetch;
}
