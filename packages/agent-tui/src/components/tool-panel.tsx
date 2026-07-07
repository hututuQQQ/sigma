import { redactSecretText, type AgentEvent, type AgentRunResult } from "agent-core";
import {
  oneLine,
  summarizeToolArguments,
  toolArgsFromEvent,
  toolNameFromEvent,
  truncate
} from "./formatting.js";

function availableTools(events: AgentEvent[], result: AgentRunResult | null): string {
  if (result?.toolsAvailable && result.toolsAvailable.length > 0) return result.toolsAvailable.join(", ");
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const tools = events[index].metadata?.toolsAvailable;
    if (Array.isArray(tools) && tools.every((tool): tool is string => typeof tool === "string")) {
      return tools.join(", ");
    }
  }
  return "available after first run";
}

export function ToolPanel(events: AgentEvent[], result: AgentRunResult | null): string {
  const toolEvents = events.filter((event) => event.type === "tool_end").slice(-8);
  const startsById = new Map(events.filter((event) => event.type === "tool_start").map((event) => [event.id, event]));
  const lines = ["Tools", `  available: ${availableTools(events, result)}`];
  for (const event of toolEvents) {
    const meta = event.metadata ?? {};
    const start = event.parentId ? startsById.get(event.parentId) : undefined;
    const name = typeof meta.toolName === "string" ? meta.toolName : toolNameFromEvent(start ?? event);
    const detail = start ? summarizeToolArguments(name, toolArgsFromEvent(start)) : "";
    const res = meta.result as { ok?: boolean; content?: string; metadata?: Record<string, unknown> } | undefined;
    const duration = typeof res?.metadata?.durationMs === "number" ? ` duration=${res.metadata.durationMs}ms` : "";
    const tail = res?.content ? ` ${truncate(oneLine(redactSecretText(res.content)), 80)}` : "";
    lines.push(`  ${name} ${res?.ok ? "ok" : "failed"}${duration}${detail ? ` ${detail}` : ""}${tail}`);
  }
  return lines.join("\n");
}
