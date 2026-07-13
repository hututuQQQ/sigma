import type {
  JsonValue,
  ModelFinishReason,
  ModelMessage,
  ModelRequest,
  ModelToolDefinition
} from "agent-protocol";

export interface OpenAIWireProfile {
  developerRole: "developer" | "system";
  supportsToolChoice: boolean;
  thinking?: "enabled" | "disabled";
  retryableFinishReasons: readonly string[];
}

const defaultWireProfile: OpenAIWireProfile = {
  developerRole: "developer",
  supportsToolChoice: true,
  retryableFinishReasons: []
};

export function resolveWireProfile(profile: Partial<OpenAIWireProfile> | undefined): OpenAIWireProfile {
  return {
    developerRole: profile?.developerRole ?? defaultWireProfile.developerRole,
    supportsToolChoice: profile?.supportsToolChoice ?? defaultWireProfile.supportsToolChoice,
    ...(profile?.thinking ? { thinking: profile.thinking } : {}),
    retryableFinishReasons: profile?.retryableFinishReasons ?? defaultWireProfile.retryableFinishReasons
  };
}

function openAiMessages(messages: ModelMessage[], profile: OpenAIWireProfile): JsonValue[] {
  return messages.map((message) => ({
    role: message.role === "developer" ? profile.developerRole : message.role,
    content: message.content,
    ...(message.role === "assistant" && message.reasoningContent !== undefined
      ? { reasoning_content: message.reasoningContent }
      : {}),
    ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
    ...(message.toolCalls ? { tool_calls: message.toolCalls.map((call) => ({
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: JSON.stringify(call.arguments) }
    })) } : {})
  }));
}

function openAiTools(tools: ModelToolDefinition[] | undefined): JsonValue[] | undefined {
  return tools?.map((tool) => ({
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.inputSchema }
  }));
}

export function bodyFor(
  request: ModelRequest,
  model: string,
  stream: boolean,
  profile: OpenAIWireProfile
): Record<string, JsonValue> {
  const tools = openAiTools(request.tools);
  return {
    model,
    messages: openAiMessages(request.messages, profile),
    ...(tools?.length ? { tools } : {}),
    ...(profile.supportsToolChoice ? {
      tool_choice: tools?.length ? (request.toolChoice ?? "auto") : "none"
    } : {}),
    ...(profile.thinking ? { thinking: { type: profile.thinking } } : {}),
    ...(request.maxOutputTokens ? { max_tokens: request.maxOutputTokens } : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(stream ? { stream: true, stream_options: { include_usage: true } } : {})
  };
}

export function jsonValue(value: unknown): JsonValue {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(jsonValue);
  if (!value || typeof value !== "object") return null;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, jsonValue(item)])
  );
}

export function parseArguments(value: string): JsonValue {
  try { return jsonValue(JSON.parse(value)); } catch { return value; }
}

export function normalizedFinishReason(value: unknown, hasTools: boolean): ModelFinishReason {
  if (value === "stop") return "stop";
  if (value === "length") return "length";
  if (value === "content_filter") return "content_filter";
  if (value === "tool_calls" || hasTools) return "tool_calls";
  return "protocol_error";
}

export function providerFinishError(provider: string, reason: string): Error {
  return Object.assign(new Error(`${provider} returned retryable finish reason '${reason}'.`), {
    code: "provider_resource_exhausted"
  });
}
