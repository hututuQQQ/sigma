import type { AgentMessage, ToolDefinition } from "agent-ai";
import type { ContextBudgetSummary } from "../types.js";

function textOfMessage(message: AgentMessage): string {
  const record = message as AgentMessage & Record<string, unknown>;
  const parts = [
    message.role,
    message.content,
    typeof record.reasoningContent === "string" ? record.reasoningContent : "",
    typeof record.name === "string" ? record.name : "",
    typeof record.toolCallId === "string" ? record.toolCallId : "",
    Array.isArray(record.toolCalls) ? JSON.stringify(record.toolCalls) : ""
  ];
  return parts.filter((part): part is string => typeof part === "string" && part.length > 0).join("\n");
}

function estimateTokens(chars: number): number {
  return Math.max(1, Math.ceil(chars / 4));
}

export function summarizeContextBudget(options: {
  messages: AgentMessage[];
  tools: ToolDefinition[];
  maxMessageHistoryChars?: number;
  repoMapChars?: number;
  skillsChars?: number;
}): ContextBudgetSummary {
  const messageChars = options.messages.reduce((total, message) => total + textOfMessage(message).length, 0);
  const toolChars = options.tools.reduce((total, tool) => total + JSON.stringify(tool).length, 0);
  const estimatedChars = messageChars + toolChars + (options.repoMapChars ?? 0) + (options.skillsChars ?? 0);
  return {
    estimated_tokens: estimateTokens(estimatedChars),
    message_count: options.messages.length,
    tool_count: options.tools.length,
    ...(options.maxMessageHistoryChars ? { max_message_history_chars: options.maxMessageHistoryChars } : {}),
    ...(typeof options.repoMapChars === "number" ? { repo_map_chars: options.repoMapChars } : {}),
    ...(typeof options.skillsChars === "number" ? { skills_chars: options.skillsChars } : {})
  };
}
