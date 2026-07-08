import {
  redactSecretText,
  type AgentEvent,
  type AgentRunResult,
  type PermissionRequest
} from "agent-core";
import {
  eventUsage,
  formatUsage,
  oneLine,
  summarizeToolArguments,
  toolArgsFromEvent,
  toolNameFromEvent,
  truncate
} from "./components/formatting.js";
import { sigmaWelcome } from "./ui/brand.js";
import { displayPathName } from "./ui/path.js";

export type TranscriptEntry =
  | { kind: "system"; text: string; timestamp?: string }
  | { kind: "user"; text: string; timestamp?: string }
  | { kind: "assistant"; text: string; toolCalls?: number; timestamp?: string }
  | { kind: "tool"; name: string; status: "running" | "ok" | "failed"; summary: string; durationMs?: number; timestamp?: string }
  | { kind: "approval"; toolName: string; risk: string; summary: string; timestamp?: string }
  | { kind: "diff"; mode: "stat" | "patch"; summary: string; timestamp?: string }
  | { kind: "changes"; files: string[]; timestamp?: string }
  | { kind: "test"; command: string; status: "running" | "ok" | "failed"; summary: string; durationMs?: number; timestamp?: string }
  | { kind: "summary"; text: string; status?: string; timestamp?: string };

export interface BuildTranscriptOptions {
  workspacePath: string;
  provider?: string;
  model?: string;
  events: AgentEvent[];
  result: AgentRunResult | null;
  localEntries?: TranscriptEntry[];
  pendingApproval?: PermissionRequest | null;
}

function eventTime(event: AgentEvent): string {
  return event.timestamp || new Date(0).toISOString();
}

function workspaceName(value: string): string {
  return displayPathName(redactSecretText(value));
}

function resultStatus(result: { ok?: boolean } | undefined): "ok" | "failed" {
  return result?.ok ? "ok" : "failed";
}

function toolDuration(result: { metadata?: Record<string, unknown> } | undefined): number | undefined {
  return typeof result?.metadata?.durationMs === "number" ? result.metadata.durationMs : undefined;
}

function formatBytes(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function eventResult(event: AgentEvent): { ok?: boolean; content?: string; metadata?: Record<string, unknown> } | undefined {
  const result = event.metadata?.result;
  return result && typeof result === "object"
    ? result as { ok?: boolean; content?: string; metadata?: Record<string, unknown> }
    : undefined;
}

function toolEntry(start: AgentEvent, end: AgentEvent | undefined): TranscriptEntry {
  const result = end ? eventResult(end) : undefined;
  const name = end && typeof end.metadata?.toolName === "string" ? end.metadata.toolName : toolNameFromEvent(start);
  const detail = summarizeToolArguments(name, toolArgsFromEvent(start));
  const tail = result?.content ? truncate(oneLine(redactSecretText(result.content)), 90) : "";
  const size = formatBytes(result?.metadata?.sizeBytes);
  return {
    kind: "tool",
    name,
    status: end ? resultStatus(result) : "running",
    summary: [detail, size, tail].filter(Boolean).join("  "),
    durationMs: toolDuration(result),
    timestamp: eventTime(end ?? start)
  };
}

function harnessEntry(start: AgentEvent, end: AgentEvent | undefined): TranscriptEntry {
  const meta = end?.metadata ?? start.metadata ?? {};
  const command = typeof start.metadata?.command === "string" ? redactSecretText(start.metadata.command) : String(start.metadata?.kind ?? "check");
  const ok = end ? meta.exitCode === 0 : false;
  const attempt = meta.attempt ? `attempt ${meta.attempt}` : "";
  const exit = end ? `exit ${meta.exitCode ?? "?"}` : "running";
  return {
    kind: "test",
    command,
    status: end ? (ok ? "ok" : "failed") : "running",
    summary: [String(meta.kind ?? "validation"), attempt, exit].filter(Boolean).join("  "),
    durationMs: typeof meta.durationMs === "number" ? meta.durationMs : undefined,
    timestamp: eventTime(end ?? start)
  };
}

function entriesFromEvents(events: AgentEvent[]): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  const toolEndsByParent = new Map<string, AgentEvent>();
  const checkEndsByParent = new Map<string, AgentEvent>();
  let latestAssistantDelta: AgentEvent | null = null;
  for (const event of events) {
    if (event.type === "tool_end" && event.parentId) toolEndsByParent.set(event.parentId, event);
    if (event.type === "harness_check_end" && event.parentId) checkEndsByParent.set(event.parentId, event);
    if (event.type === "assistant_delta") latestAssistantDelta = event;
  }

  for (const event of events) {
    const meta = event.metadata ?? {};
    if (event.type === "run_start") {
      const workspace = typeof meta.workspacePath === "string" ? workspaceName(meta.workspacePath) : "workspace";
      entries.push({ kind: "system", text: `run started in ${workspace}`, timestamp: eventTime(event) });
      continue;
    }
    if (event.type === "assistant_message") {
      latestAssistantDelta = null;
      const toolCalls = Array.isArray(meta.toolCalls) ? meta.toolCalls.length : 0;
      const text = typeof meta.content === "string" && meta.content.trim()
        ? redactSecretText(meta.content.trim())
        : toolCalls > 0
          ? `I will use ${toolCalls} tool${toolCalls === 1 ? "" : "s"}.`
          : "(empty message)";
      entries.push({ kind: "assistant", text, toolCalls, timestamp: eventTime(event) });
      continue;
    }
    if (event.type === "tool_start") {
      entries.push(toolEntry(event, toolEndsByParent.get(event.id)));
      continue;
    }
    if (event.type === "harness_check_start") {
      entries.push(harnessEntry(event, checkEndsByParent.get(event.id)));
      continue;
    }
    if (event.type === "usage") {
      const usage = eventUsage(event);
      if (usage) entries.push({ kind: "system", text: `usage ${formatUsage(usage)}`, timestamp: eventTime(event) });
      continue;
    }
    if (event.type === "error") {
      entries.push({ kind: "summary", status: "error", text: redactSecretText(String(meta.message ?? "")), timestamp: eventTime(event) });
      continue;
    }
  }
  if (latestAssistantDelta) {
    const text = typeof latestAssistantDelta.metadata?.content === "string"
      ? latestAssistantDelta.metadata.content
      : typeof latestAssistantDelta.metadata?.delta === "string"
        ? latestAssistantDelta.metadata.delta
        : "";
    if (text.trim()) {
      entries.push({ kind: "assistant", text: redactSecretText(text), timestamp: eventTime(latestAssistantDelta) });
    }
  }
  return entries;
}

function sortEntries(entries: TranscriptEntry[]): TranscriptEntry[] {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => (a.entry.timestamp ?? "").localeCompare(b.entry.timestamp ?? "") || a.index - b.index)
    .map((item) => item.entry);
}

export function buildTranscript(options: BuildTranscriptOptions): TranscriptEntry[] {
  const localEntries = options.localEntries ?? [];
  const entries = [...localEntries, ...entriesFromEvents(options.events)];
  if (options.pendingApproval) {
    const args = options.pendingApproval.arguments;
    entries.push({
      kind: "approval",
      toolName: options.pendingApproval.toolName,
      risk: options.pendingApproval.risk,
      summary: summarizeToolArguments(options.pendingApproval.toolName, args) || options.pendingApproval.reason,
      timestamp: new Date().toISOString()
    });
  }
  if (entries.length === 0) {
    const workspace = workspaceName(options.workspacePath);
    for (const line of sigmaWelcome({
      provider: options.provider,
      model: options.model ?? options.result?.model,
      workspacePath: redactSecretText(options.workspacePath)
    })) {
      entries.push({
        kind: "system",
        text: line,
        timestamp: new Date(0).toISOString()
      });
    }
    entries.push({
      kind: "system",
      text: "",
      timestamp: new Date(0).toISOString()
    });
    entries.push({
      kind: "system",
      text: `Ready in ${workspace}`,
      timestamp: new Date(0).toISOString()
    });
  }
  if (options.result) {
    const hasErrorSummary = entries.some((entry) => entry.kind === "summary" && entry.status === "error");
    if (options.result.status === "error" && hasErrorSummary) {
      return sortEntries(entries);
    }
    if (options.result.status === "error") {
      entries.push({
        kind: "summary",
        status: "error",
        text: options.result.lastError ?? options.result.finishReason,
        timestamp: new Date(Date.now() + 1).toISOString()
      });
      return sortEntries(entries);
    }
    if (options.result.changedFiles && options.result.changedFiles.length > 0) {
      entries.push({
        kind: "changes",
        files: options.result.changedFiles,
        timestamp: new Date(Date.now()).toISOString()
      });
    }
    const usageText = (options.result.usage.totalTokens ?? 0) > 0 ? formatUsage(options.result.usage) : "";
    const resultText = [
      `${options.result.status} ${options.result.finishReason}`,
      options.result.toolCalls > 0 ? `${options.result.toolCalls} tools` : "",
      options.result.turns > 0 ? `${options.result.turns} turns` : "",
      usageText
    ].filter(Boolean).join("  ");
    entries.push({
      kind: "summary",
      status: options.result.status,
      text: resultText,
      timestamp: new Date(Date.now() + 1).toISOString()
    });
  }

  return sortEntries(entries);
}
