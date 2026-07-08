import path from "node:path";
import { redactSecretText, type AgentEvent } from "agent-core";
import { box } from "../ui/box.js";
import { glyphs, truncateToWidth } from "../ui/theme.js";
import {
  eventUsage,
  formatUsage,
  oneLine,
  summarizeToolArguments,
  toolArgsFromEvent,
  toolNameFromEvent,
  toolResultFromEvent,
  truncate
} from "./formatting.js";

function compactTime(timestamp: string): string {
  return timestamp.includes("T") ? timestamp.slice(11, 16) : timestamp.slice(0, 5);
}

function formatBytes(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function workspaceName(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) return "";
  return path.basename(value) || redactSecretText(value);
}

function joinDetails(parts: string[]): string {
  const g = glyphs();
  return parts.filter(Boolean).join(` ${g.separator} `);
}

export function formatTimelineEvent(event: AgentEvent): string {
  const g = glyphs();
  const time = compactTime(event.timestamp);
  const meta = event.metadata ?? {};
  const prefix = (marker: string, text: string) => `${time}  ${marker} ${text}`;

  if (event.type === "run_start") {
    return prefix(g.sigma, joinDetails(["run started", workspaceName(meta.workspacePath) ? `workspace=${workspaceName(meta.workspacePath)}` : ""]));
  }
  if (event.type === "model_start") return prefix(g.running, `model turn ${meta.turn ?? "?"} started`);
  if (event.type === "model_end") return prefix(g.ok, joinDetails([`model turn ${meta.turn ?? "?"} ended`, formatUsage(eventUsage(event))]));
  if (event.type === "context_budget") {
    const budget = meta.budget as { estimated_tokens?: unknown; message_count?: unknown; tool_count?: unknown } | undefined;
    return prefix(g.info, joinDetails([`context turn ${meta.turn ?? "?"}`, `${budget?.estimated_tokens ?? "?"} est tokens`, `${budget?.message_count ?? "?"} messages`, `${budget?.tool_count ?? "?"} tools`]));
  }
  if (event.type === "assistant_message") {
    const toolCalls = Array.isArray(meta.toolCalls) ? meta.toolCalls.length : 0;
    if (toolCalls > 0) return prefix(g.info, `assistant proposed ${toolCalls} tool call${toolCalls === 1 ? "" : "s"}`);
    const content = typeof meta.content === "string" ? oneLine(redactSecretText(meta.content)) : "";
    return prefix(g.info, `assistant ${truncate(content || "(message)", 130)}`);
  }
  if (event.type === "tool_queued") {
    return prefix(g.info, `${meta.toolName ?? "tool"} queued`);
  }
  if (event.type === "tool_start") {
    const toolName = toolNameFromEvent(event);
    const detail = summarizeToolArguments(toolName, toolArgsFromEvent(event));
    return prefix(g.running, joinDetails([`${toolName} started`, detail]));
  }
  if (event.type === "tool_aborted") {
    return prefix(g.fail, joinDetails([`${meta.toolName ?? "tool"} aborted`, truncate(oneLine(redactSecretText(String(meta.reason ?? ""))), 90)]));
  }
  if (event.type === "tool_end") {
    const result = toolResultFromEvent(event);
    const status = result?.ok ? "ok" : "failed";
    const duration = typeof result?.metadata?.durationMs === "number" ? `${result.metadata.durationMs}ms` : "";
    const outputSize = formatBytes(result?.metadata?.sizeBytes);
    const tail = result?.content ? truncate(oneLine(redactSecretText(result.content)), 90) : "";
    return prefix(result?.ok ? g.ok : g.fail, joinDetails([`${meta.toolName ?? "tool"} ${status}`, outputSize, duration, tail]));
  }
  if (event.type === "harness_check_start") {
    const command = typeof meta.command === "string" ? truncateToWidth(oneLine(redactSecretText(meta.command)), 120) : "";
    return prefix(g.running, joinDetails([`${meta.kind ?? "check"} check started`, `attempt=${meta.attempt ?? "?"}`, command]));
  }
  if (event.type === "harness_check_end") {
    const ok = meta.exitCode === 0;
    return prefix(ok ? g.ok : g.fail, joinDetails([`${meta.kind ?? "check"} check ${ok ? "passed" : "failed"}`, `attempt=${meta.attempt ?? "?"}`, `exit=${meta.exitCode ?? "?"}`, `${meta.durationMs ?? "?"}ms`]));
  }
  if (event.type === "usage") return prefix(g.info, joinDetails([`usage turn=${meta.turn ?? "?"}`, formatUsage(eventUsage(event))]));
  if (event.type === "error") return prefix(g.fail, `error ${truncate(redactSecretText(String(meta.message ?? "")))}`);
  if (event.type === "run_end") {
    const result = meta.result as { status?: string; finishReason?: string } | undefined;
    return prefix(result?.status === "completed" ? g.ok : g.fail, joinDetails(["run completed", result?.status ?? "", result?.finishReason ?? ""]));
  }
  return prefix(g.info, String((event as { type: string }).type).replaceAll("_", " "));
}

export function Timeline(events: AgentEvent[], maxLines: number, width = 80, height?: number, color = false): string {
  const visible = events.slice(Math.max(0, events.length - maxLines));
  const lines = visible.length === 0
    ? ["No runs yet.", "Type a task and press Enter to start."]
    : visible.map((event) => formatTimelineEvent(event));
  return box({
    title: `${glyphs().sigma} Timeline`,
    width,
    height,
    color,
    lines
  });
}
