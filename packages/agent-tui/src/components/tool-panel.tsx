import { redactSecretText, type AgentEvent, type AgentRunResult } from "agent-core";
import { box } from "../ui/box.js";
import { glyphs, truncateToWidth, wrapText } from "../ui/theme.js";
import {
  oneLine,
  summarizeToolArguments,
  toolArgsFromEvent,
  toolNameFromEvent,
  toolResultFromEvent,
  truncate
} from "./formatting.js";

function availableTools(events: AgentEvent[], result: AgentRunResult | null): string[] {
  if (result?.toolsAvailable && result.toolsAvailable.length > 0) return result.toolsAvailable;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const tools = events[index].metadata?.toolsAvailable;
    if (Array.isArray(tools) && tools.every((tool): tool is string => typeof tool === "string")) {
      return tools;
    }
  }
  return [];
}

function groupedTools(tools: string[], width: number): string[] {
  if (tools.length === 0) return ["available: after first run"];
  const groups = [
    { label: "read", names: ["read", "list", "glob", "grep", "repo_query", "git_diff"] },
    { label: "write", names: ["write", "edit", "apply_patch", "todo"] },
    { label: "run", names: ["bash", "shell_session", "service"] }
  ];
  const assigned = new Set<string>();
  const lines: string[] = [];
  for (const group of groups) {
    const present = tools.filter((tool) => group.names.includes(tool));
    present.forEach((tool) => assigned.add(tool));
    if (present.length > 0) {
      lines.push(...wrapText(`${group.label}: ${present.join(", ")}`, width));
    }
  }
  const other = tools.filter((tool) => !assigned.has(tool));
  if (other.length > 0) lines.push(...wrapText(`other: ${other.join(", ")}`, width));
  return lines;
}

function terminalToolKey(event: AgentEvent): string {
  const callId = event.metadata?.toolCallId;
  if (event.parentId) return `parent:${event.parentId}`;
  if (typeof callId === "string" && callId.length > 0) return `call:${callId}`;
  return `event:${event.id}`;
}

function recentTerminalToolEvents(events: AgentEvent[], limit: number): AgentEvent[] {
  const byKey = new Map<string, { event: AgentEvent; index: number }>();
  events.forEach((event, index) => {
    if (event.type !== "tool_end" && event.type !== "tool_aborted") return;
    byKey.set(terminalToolKey(event), { event, index });
  });
  return [...byKey.values()]
    .sort((a, b) => a.index - b.index)
    .map((item) => item.event)
    .slice(-limit);
}

function sandboxWarning(metadata: Record<string, unknown> | undefined): string {
  const sandbox = metadata?.sandbox;
  if (!sandbox || typeof sandbox !== "object") return "";
  const warning = (sandbox as Record<string, unknown>).warning;
  return typeof warning === "string" && warning ? `sandbox warning: ${truncate(oneLine(redactSecretText(warning)), 70)}` : "";
}

export function ToolPanel(events: AgentEvent[], result: AgentRunResult | null, width = 80, height?: number, color = false): string {
  const g = glyphs();
  const innerWidth = Math.max(20, width - 4);
  const toolEvents = recentTerminalToolEvents(events, 8);
  const startsById = new Map(events.filter((event) => event.type === "tool_start").map((event) => [event.id, event]));
  const lines = [
    "Available",
    ...groupedTools(availableTools(events, result), innerWidth),
    "",
    "Recent calls"
  ];

  if (toolEvents.length === 0) {
    lines.push("No tool calls yet.");
  }

  for (const event of toolEvents) {
    const meta = event.metadata ?? {};
    const start = event.parentId ? startsById.get(event.parentId) : undefined;
    const name = typeof meta.toolName === "string" ? meta.toolName : toolNameFromEvent(start ?? event);
    const detail = start ? summarizeToolArguments(name, toolArgsFromEvent(start)) : "";
    const res = toolResultFromEvent(event);
    const aborted = event.type === "tool_aborted" || res?.metadata?.cancelled === true;
    const marker = res?.ok ? g.ok : g.fail;
    const duration = typeof res?.metadata?.durationMs === "number" ? `${res.metadata.durationMs}ms` : "";
    const tail = res?.content ? truncate(oneLine(redactSecretText(res.content)), 70) : truncate(oneLine(redactSecretText(String(meta.reason ?? ""))), 70);
    const warning = sandboxWarning(res?.metadata);
    const status = aborted ? "aborted" : (res?.ok ? "ok" : "failed");
    lines.push(truncateToWidth(`${marker} ${name} ${status} ${[duration, detail, warning, tail].filter(Boolean).join(` ${g.separator} `)}`, innerWidth));
  }

  return box({
    title: `${g.sigma} Tools`,
    width,
    height,
    color,
    lines
  });
}
