import type { AgentMessage, AssistantMessage } from "../types.js";
import { normalizeToolCalls } from "./tool-calls.js";

export function normalizeAssistantMessage(raw: unknown): AssistantMessage {
  const message = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const content = typeof message.content === "string" ? message.content : undefined;
  const reasoningContent =
    typeof message.reasoning_content === "string"
      ? message.reasoning_content
      : typeof message.reasoningContent === "string"
        ? message.reasoningContent
        : undefined;
  const toolCalls = normalizeToolCalls(message.tool_calls ?? message.toolCalls);

  const normalized: AssistantMessage = { role: "assistant" };
  if (content !== undefined && content.length > 0) normalized.content = content;
  if (reasoningContent !== undefined && reasoningContent.length > 0) normalized.reasoningContent = reasoningContent;
  if (toolCalls.length > 0) normalized.toolCalls = toolCalls;
  return normalized;
}

export function toOpenAIMessage(message: AgentMessage): Record<string, unknown> {
  if (message.role === "assistant") {
    return {
      role: "assistant",
      content: message.content ?? "",
      ...(message.toolCalls && message.toolCalls.length > 0
        ? {
            tool_calls: message.toolCalls.map((call) => ({
              id: call.id,
              type: "function",
              function: {
                name: call.function.name,
                arguments:
                  typeof call.function.arguments === "string"
                    ? call.function.arguments
                    : JSON.stringify(call.function.arguments ?? {})
              }
            }))
          }
        : {})
    };
  }

  if (message.role === "tool") {
    return {
      role: "tool",
      tool_call_id: message.toolCallId,
      name: message.name,
      content: message.content
    };
  }

  return {
    role: message.role,
    content: message.content
  };
}

export function toOpenAIMessages(messages: AgentMessage[]): Array<Record<string, unknown>> {
  return messages.map(toOpenAIMessage);
}
