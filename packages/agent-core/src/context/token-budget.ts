import type { AgentMessage, ToolDefinition } from "agent-ai";
import type { ContextBudgetSummary, ContextSourceEntry, ContextSourceMap } from "../types.js";
import { buildContextSourceMap, contextPressure, contextSourceEntry, estimateContextTokens } from "./source-map.js";

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

export function summarizeContextBudget(options: {
  messages: AgentMessage[];
  tools: ToolDefinition[];
  maxMessageHistoryChars?: number;
  modelContextChars?: number;
  repoMapChars?: number;
  skillsChars?: number;
  sourceEntries?: ContextSourceEntry[];
}): ContextBudgetSummary {
  const messageChars = options.messages.reduce((total, message) => total + textOfMessage(message).length, 0);
  const toolChars = options.tools.reduce((total, tool) => total + JSON.stringify(tool).length, 0);
  const estimatedChars = messageChars + toolChars;
  const estimatedTokens = estimateContextTokens(estimatedChars);
  const generatedSourceMap: ContextSourceMap = {
    ...buildContextSourceMap([
      contextSourceEntry({
        id: "messages",
        kind: "messages",
        label: "Conversation messages",
        content: JSON.stringify(options.messages),
        modelVisible: true,
        activationReason: "active conversation window",
        authority: "runtime"
      }),
      contextSourceEntry({
        id: "tool_definitions",
        kind: "tool_definitions",
        label: "Tool definitions",
        content: JSON.stringify(options.tools),
        cacheable: true,
        modelVisible: true,
        activationReason: "tools available to the model",
        authority: "system"
      }),
      ...(options.sourceEntries ?? [])
    ]),
    total_estimated_tokens: estimatedTokens
  };
  return {
    estimated_tokens: estimatedTokens,
    message_count: options.messages.length,
    tool_count: options.tools.length,
    ...(options.maxMessageHistoryChars ? { max_message_history_chars: options.maxMessageHistoryChars } : {}),
    ...(options.modelContextChars ? { model_context_chars: options.modelContextChars } : {}),
    ...(typeof options.repoMapChars === "number" ? { repo_map_chars: options.repoMapChars } : {}),
    ...(typeof options.skillsChars === "number" ? { skills_chars: options.skillsChars } : {}),
    source_map: generatedSourceMap,
    pressure: contextPressure(estimatedTokens, options.maxMessageHistoryChars)
  };
}
