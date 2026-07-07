import { redactSecretText, type AgentEvent } from "agent-core";

function truncate(value: string, max = 120): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 3))}...`;
}

function eventLine(event: AgentEvent): string {
  const time = event.timestamp.slice(11, 19);
  const meta = event.metadata ?? {};
  if (event.type === "run_start") return `${time} run_start workspace=${meta.workspacePath ?? ""}`;
  if (event.type === "model_start") return `${time} model_start turn=${meta.turn ?? ""}`;
  if (event.type === "model_end") return `${time} model_end turn=${meta.turn ?? ""}`;
  if (event.type === "assistant_message") {
    const content = typeof meta.content === "string" ? redactSecretText(meta.content) : "";
    const toolCalls = Array.isArray(meta.toolCalls) ? ` tool_calls=${meta.toolCalls.length}` : "";
    return `${time} assistant ${truncate(content || "(tool call)")}${toolCalls}`;
  }
  if (event.type === "tool_start") {
    const toolCall = meta.toolCall as { function?: { name?: string } } | undefined;
    return `${time} tool_start ${toolCall?.function?.name ?? "unknown"}`;
  }
  if (event.type === "tool_end") {
    const result = meta.result as { ok?: boolean; content?: string } | undefined;
    return `${time} tool_end ${meta.toolName ?? "unknown"} ok=${String(result?.ok ?? false)} ${truncate(redactSecretText(result?.content ?? ""), 90)}`;
  }
  if (event.type === "error") return `${time} error ${truncate(redactSecretText(String(meta.message ?? "")))}`;
  if (event.type === "run_end") {
    const result = meta.result as { status?: string; finishReason?: string } | undefined;
    return `${time} run_end status=${result?.status ?? ""} finish=${result?.finishReason ?? ""}`;
  }
  return `${time} ${event.type}`;
}

export function Timeline(events: AgentEvent[], maxLines: number): string {
  const visible = events.slice(Math.max(0, events.length - maxLines));
  if (visible.length === 0) return "Timeline\n  No runs yet.";
  return ["Timeline", ...visible.map((event) => `  ${eventLine(event)}`)].join("\n");
}
