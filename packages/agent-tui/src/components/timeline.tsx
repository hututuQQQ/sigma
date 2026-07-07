import { redactSecretText, type AgentEvent } from "agent-core";
import {
  eventUsage,
  formatUsage,
  oneLine,
  summarizeToolArguments,
  toolArgsFromEvent,
  toolNameFromEvent,
  truncate
} from "./formatting.js";

export function formatTimelineEvent(event: AgentEvent): string {
  const time = event.timestamp.slice(11, 19);
  const meta = event.metadata ?? {};
  if (event.type === "run_start") return `${time} run started workspace=${meta.workspacePath ?? ""}`;
  if (event.type === "model_start") return `${time} model turn ${meta.turn ?? "?"} started`;
  if (event.type === "model_end") return `${time} model turn ${meta.turn ?? "?"} ended ${formatUsage(eventUsage(event))}`;
  if (event.type === "assistant_message") {
    const content = typeof meta.content === "string" ? oneLine(redactSecretText(meta.content)) : "";
    const toolCalls = Array.isArray(meta.toolCalls) ? ` tool_calls=${meta.toolCalls.length}` : "";
    return `${time} assistant ${truncate(content || "(tool call)", 130)}${toolCalls}`;
  }
  if (event.type === "tool_start") {
    const toolName = toolNameFromEvent(event);
    const detail = summarizeToolArguments(toolName, toolArgsFromEvent(event));
    return `${time} tool start ${toolName}${detail ? ` ${detail}` : ""}`;
  }
  if (event.type === "tool_end") {
    const result = meta.result as { ok?: boolean; content?: string; metadata?: Record<string, unknown> } | undefined;
    const duration = typeof result?.metadata?.durationMs === "number" ? ` duration=${result.metadata.durationMs}ms` : "";
    const outputSize = typeof result?.metadata?.sizeBytes === "number" ? ` size=${result.metadata.sizeBytes}` : "";
    const tail = result?.content ? ` ${truncate(oneLine(redactSecretText(result.content)), 90)}` : "";
    return `${time} tool end ${meta.toolName ?? "unknown"} ${result?.ok ? "ok" : "failed"}${duration}${outputSize}${tail}`;
  }
  if (event.type === "harness_check_start") {
    const command = typeof meta.command === "string" ? ` command=${truncate(oneLine(redactSecretText(meta.command)), 150)}` : "";
    return `${time} ${meta.kind ?? "check"} check started attempt=${meta.attempt ?? "?"}${command}`;
  }
  if (event.type === "harness_check_end") {
    return `${time} ${meta.kind ?? "check"} check ended attempt=${meta.attempt ?? "?"} exit=${meta.exitCode ?? "?"} duration=${meta.durationMs ?? "?"}ms`;
  }
  if (event.type === "usage") return `${time} usage turn=${meta.turn ?? "?"} ${formatUsage(eventUsage(event))}`;
  if (event.type === "error") return `${time} error ${truncate(redactSecretText(String(meta.message ?? "")))}`;
  if (event.type === "run_end") {
    const result = meta.result as { status?: string; finishReason?: string } | undefined;
    return `${time} run ended status=${result?.status ?? ""} finish=${result?.finishReason ?? ""}`;
  }
  return `${time} ${event.type}`;
}

export function Timeline(events: AgentEvent[], maxLines: number): string {
  const visible = events.slice(Math.max(0, events.length - maxLines));
  if (visible.length === 0) return "Timeline\n  No runs yet.";
  return ["Timeline", ...visible.map((event) => `  ${formatTimelineEvent(event)}`)].join("\n");
}
