import type {
  JsonValue,
  ModelFinishReason,
  ModelMessage,
  ModelRequest,
  ModelToolDefinition
} from "agent-protocol";
import { ModelGatewayError } from "./catalog.js";

export type OpenAIToolChoicePolicy = "always" | "non_thinking_only" | "never";

export interface OpenAIWireProfile {
  developerRole: "developer" | "system";
  toolChoicePolicy: OpenAIToolChoicePolicy;
  /** @deprecated Use toolChoicePolicy. */
  supportsToolChoice?: boolean;
  thinking?: "enabled" | "disabled";
  retryableFinishReasons: readonly string[];
}

const defaultWireProfile: OpenAIWireProfile = {
  developerRole: "developer",
  toolChoicePolicy: "always",
  retryableFinishReasons: []
};

function legacyToolChoicePolicy(value: boolean | undefined): OpenAIToolChoicePolicy | undefined {
  if (value === undefined) return undefined;
  return value ? "always" : "never";
}

function validateToolChoiceProfile(
  canonical: OpenAIToolChoicePolicy | undefined,
  legacy: OpenAIToolChoicePolicy | undefined,
  thinking: OpenAIWireProfile["thinking"]
): void {
  if (canonical && legacy && canonical !== legacy) {
    throw new ModelGatewayError(
      `OpenAI wire profile has conflicting tool choice settings: toolChoicePolicy='${canonical}' and supportsToolChoice=${String(legacy === "always")}.`,
      "configuration"
    );
  }
  if (canonical === "non_thinking_only" && !thinking) {
    throw new ModelGatewayError(
      "OpenAI wire profile requires a thinking mode when toolChoicePolicy='non_thinking_only'.",
      "configuration"
    );
  }
}

function resolvedToolChoicePolicy(profile: Partial<OpenAIWireProfile> | undefined): OpenAIToolChoicePolicy {
  const canonical = profile?.toolChoicePolicy;
  const legacy = legacyToolChoicePolicy(profile?.supportsToolChoice);
  validateToolChoiceProfile(canonical, legacy, profile?.thinking);
  return canonical ?? legacy ?? defaultWireProfile.toolChoicePolicy;
}

export function resolveWireProfile(profile: Partial<OpenAIWireProfile> | undefined): OpenAIWireProfile {
  return {
    developerRole: profile?.developerRole ?? defaultWireProfile.developerRole,
    toolChoicePolicy: resolvedToolChoicePolicy(profile),
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

interface WireControls {
  thinking?: "enabled" | "disabled";
  toolChoice?: "auto" | "required" | "none";
}

function invalidToolChoice(message: string): ModelGatewayError {
  return new ModelGatewayError(message, "configuration");
}

function wireControls(request: ModelRequest, hasTools: boolean, profile: OpenAIWireProfile): WireControls {
  if (request.toolChoice === "required" && !hasTools) {
    throw invalidToolChoice("toolChoice='required' requires at least one tool definition.");
  }
  const choice = hasTools ? request.toolChoice ?? "auto" : "none";
  const strictChoice = request.toolChoice === "required" || request.toolChoice === "none";
  if (profile.toolChoicePolicy === "always") {
    return { ...(profile.thinking ? { thinking: profile.thinking } : {}), toolChoice: choice };
  }
  if (profile.toolChoicePolicy === "never") {
    if (strictChoice) {
      throw invalidToolChoice(`OpenAI wire profile cannot honor toolChoice='${request.toolChoice}'.`);
    }
    return profile.thinking ? { thinking: profile.thinking } : {};
  }
  if (strictChoice) return { thinking: "disabled", toolChoice: choice };
  return profile.thinking ? { thinking: profile.thinking } : {};
}

export function bodyFor(
  request: ModelRequest,
  model: string,
  stream: boolean,
  profile: OpenAIWireProfile
): Record<string, JsonValue> {
  const tools = openAiTools(request.tools);
  const controls = wireControls(request, Boolean(tools?.length), profile);
  return {
    model,
    messages: openAiMessages(request.messages, profile),
    ...(tools?.length ? { tools } : {}),
    ...(controls.toolChoice ? { tool_choice: controls.toolChoice } : {}),
    ...(controls.thinking ? { thinking: { type: controls.thinking } } : {}),
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
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== "string") return jsonValue(parsed);
    // Some OpenAI-compatible providers occasionally serialize the function
    // arguments object twice. Accept exactly one extra object layer, then let
    // the ordinary descriptor schema remain the authority. Never recursively
    // unwrap strings or accept arrays/scalars through this compatibility path.
    try {
      const nested = JSON.parse(parsed) as unknown;
      return nested && typeof nested === "object" && !Array.isArray(nested)
        ? jsonValue(nested)
        : parsed;
    } catch {
      return parsed;
    }
  } catch {
    return value;
  }
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
