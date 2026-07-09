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
  toolResultFromEvent,
  truncate
} from "./components/formatting.js";
import { sigmaWelcome } from "./ui/brand.js";
import { displayPathName } from "./ui/path.js";

export type TranscriptEntry =
  | { kind: "system"; text: string; timestamp?: string }
  | { kind: "user"; text: string; timestamp?: string }
  | { kind: "assistant"; text: string; toolCalls?: number; timestamp?: string }
  | { kind: "tool"; name: string; status: "queued" | "running" | "ok" | "failed" | "aborted"; summary: string; durationMs?: number; timestamp?: string }
  | { kind: "approval"; toolName: string; risk: string; summary: string; timestamp?: string }
  | { kind: "subagent"; status: ActivityStatus; label: string; detail: string; timestamp?: string }
  | { kind: "diff"; mode: "stat" | "patch"; summary: string; timestamp?: string }
  | { kind: "changes"; files: string[]; timestamp?: string }
  | { kind: "test"; command: string; status: "running" | "ok" | "failed"; summary: string; durationMs?: number; timestamp?: string }
  | { kind: "summary"; text: string; status?: string; timestamp?: string };

export type ActivityStatus = "queued" | "running" | "ok" | "failed" | "aborted" | "waiting" | "info";

type ToolTranscriptEntry = Extract<TranscriptEntry, { kind: "tool" }>;
type TestTranscriptEntry = Extract<TranscriptEntry, { kind: "test" }>;

export interface ActivityItem {
  kind: "tool" | "check" | "approval" | "subagent" | "review" | "context" | "usage" | "budget" | "error";
  status: ActivityStatus;
  label: string;
  detail: string;
  durationMs?: number;
  timestamp?: string;
}

export interface BuildTranscriptOptions {
  workspacePath: string;
  provider?: string;
  model?: string;
  events: AgentEvent[];
  result: AgentRunResult | null;
  localEntries?: TranscriptEntry[];
  pendingApproval?: PermissionRequest | null;
}

export interface BuildActivityOptions {
  events: AgentEvent[];
  result: AgentRunResult | null;
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

function sandboxWarning(metadata: Record<string, unknown> | undefined): string {
  const sandbox = metadata?.sandbox;
  if (!sandbox || typeof sandbox !== "object") return "";
  const warning = (sandbox as Record<string, unknown>).warning;
  return typeof warning === "string" && warning ? `sandbox warning: ${truncate(oneLine(redactSecretText(warning)), 90)}` : "";
}

function formatBytes(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function eventResult(event: AgentEvent): { ok?: boolean; content?: string; metadata?: Record<string, unknown> } | undefined {
  return toolResultFromEvent(event);
}

function toolEntry(start: AgentEvent, end: AgentEvent | undefined): ToolTranscriptEntry {
  const result = end ? eventResult(end) : undefined;
  const name = end && typeof end.metadata?.toolName === "string" ? end.metadata.toolName : toolNameFromEvent(start);
  const detail = summarizeToolArguments(name, toolArgsFromEvent(start));
  const tail = result?.content ? truncate(oneLine(redactSecretText(result.content)), 90) : "";
  const size = formatBytes(result?.metadata?.sizeBytes);
  const warning = sandboxWarning(result?.metadata);
  const aborted = end?.type === "tool_aborted" || result?.metadata?.cancelled === true;
  return {
    kind: "tool",
    name,
    status: end ? (aborted ? "aborted" : resultStatus(result)) : (start.type === "tool_queued" ? "queued" : "running"),
    summary: [detail, size, warning, tail].filter(Boolean).join("  "),
    durationMs: toolDuration(result),
    timestamp: eventTime(end ?? start)
  };
}

function toolActivity(start: AgentEvent, end: AgentEvent | undefined): ActivityItem {
  const entry = toolEntry(start, end);
  return {
    kind: "tool",
    status: entry.status,
    label: entry.name,
    detail: entry.summary,
    durationMs: entry.durationMs,
    timestamp: entry.timestamp
  };
}

function harnessEntry(start: AgentEvent, end: AgentEvent | undefined): TestTranscriptEntry {
  const meta = end?.metadata ?? start.metadata ?? {};
  const command = typeof start.metadata?.command === "string" ? redactSecretText(start.metadata.command) : String(start.metadata?.kind ?? "check");
  const ok = end ? meta.exitCode === 0 : false;
  const attempt = meta.attempt ? `attempt ${meta.attempt}` : "";
  const exit = end ? `exit ${meta.exitCode ?? "?"}` : "running";
  const warning = sandboxWarning(meta);
  return {
    kind: "test",
    command,
    status: end ? (ok ? "ok" : "failed") : "running",
    summary: [String(meta.kind ?? "validation"), attempt, exit, warning].filter(Boolean).join("  "),
    durationMs: typeof meta.durationMs === "number" ? meta.durationMs : undefined,
    timestamp: eventTime(end ?? start)
  };
}

function harnessActivity(start: AgentEvent, end: AgentEvent | undefined): ActivityItem {
  const entry = harnessEntry(start, end);
  return {
    kind: "check",
    status: entry.status,
    label: oneLine(redactSecretText(entry.command)),
    detail: entry.summary,
    durationMs: entry.durationMs,
    timestamp: entry.timestamp
  };
}

interface SubagentJobLike {
  job_id?: unknown;
  subagent_type?: unknown;
  description?: unknown;
  status?: unknown;
  error?: unknown;
  report?: SubagentReportLike;
}

interface SubagentReportLike {
  id?: unknown;
  job_id?: unknown;
  subagent_type?: unknown;
  description?: unknown;
  status?: unknown;
  summary?: unknown;
  error?: unknown;
}

function shortId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) return "";
  return value.length <= 8 ? value : value.slice(0, 8);
}

function subagentTypeName(value: unknown): string {
  return typeof value === "string" && value.length > 0 ? value : "subagent";
}

function subagentStatus(value: unknown, fallback: ActivityStatus = "running"): ActivityStatus {
  const status = String(value ?? "");
  if (status === "completed" || status === "complete" || status === "ok" || status === "closed") return "ok";
  if (status === "failed" || status === "error") return "failed";
  if (status === "interrupted" || status === "cancelled" || status === "canceled") return "aborted";
  if (status === "waiting") return "waiting";
  if (status === "queued") return "queued";
  if (status === "info") return "info";
  if (status === "running") return "running";
  return fallback;
}

function subagentLabelFromMeta(meta: Record<string, unknown>): string {
  const job = meta.job as SubagentJobLike | undefined;
  const report = meta.report as SubagentReportLike | undefined;
  const type = subagentTypeName(meta.subagent_type ?? job?.subagent_type ?? report?.subagent_type);
  const jobId = shortId(meta.job_id ?? job?.job_id ?? report?.job_id);
  const subagentId = shortId(meta.subagent_id ?? report?.id);
  if (jobId) return `${type} job ${jobId}`;
  if (subagentId) return `${type} ${subagentId}`;
  return type;
}

function subagentDescriptionFromMeta(meta: Record<string, unknown>): string {
  const job = meta.job as SubagentJobLike | undefined;
  const report = meta.report as SubagentReportLike | undefined;
  const value = meta.description ?? job?.description ?? report?.description;
  return typeof value === "string" ? value : "";
}

function subagentDetailFromMeta(meta: Record<string, unknown>, fallback: string): string {
  const report = meta.report as SubagentReportLike | undefined;
  const job = meta.job as SubagentJobLike | undefined;
  const message = meta.message ?? meta.error ?? report?.error ?? report?.summary ?? job?.error ?? job?.status ?? meta.status;
  const text = typeof message === "string" && message.trim() ? message : fallback;
  const tool = typeof meta.tool_name === "string" && meta.tool_name ? `tool=${meta.tool_name}` : "";
  const phase = typeof meta.phase === "string" && meta.phase ? meta.phase : "";
  return truncate(oneLine(redactSecretText([phase, tool, text].filter(Boolean).join("  "))), 120);
}

function subagentActivity(event: AgentEvent, status: ActivityStatus, fallback: string): ActivityItem {
  const meta = event.metadata ?? {};
  return {
    kind: "subagent",
    status,
    label: subagentLabelFromMeta(meta),
    detail: subagentDetailFromMeta(meta, fallback),
    timestamp: eventTime(event)
  };
}

function subagentTranscriptEntry(event: AgentEvent, status: ActivityStatus, fallback: string): TranscriptEntry {
  const meta = event.metadata ?? {};
  const description = subagentDescriptionFromMeta(meta);
  const detail = subagentDetailFromMeta(meta, fallback);
  return {
    kind: "subagent",
    status,
    label: subagentLabelFromMeta(meta),
    detail: [description ? truncate(oneLine(redactSecretText(description)), 80) : "", detail].filter(Boolean).join("  "),
    timestamp: eventTime(event)
  };
}

function activityFromEvents(events: AgentEvent[]): ActivityItem[] {
  const items: ActivityItem[] = [];
  const toolEndsByParent = new Map<string, AgentEvent>();
  const toolStartsByCallId = new Map<string, AgentEvent>();
  const toolAbortsByParent = new Map<string, AgentEvent>();
  const toolAbortsByCallId = new Map<string, AgentEvent>();
  const checkEndsByParent = new Map<string, AgentEvent>();
  for (const event of events) {
    if (event.type === "tool_end" && event.parentId) toolEndsByParent.set(event.parentId, event);
    if (event.type === "tool_start" && typeof event.metadata?.toolCallId === "string") toolStartsByCallId.set(event.metadata.toolCallId, event);
    if (event.type === "tool_aborted" && event.parentId) toolAbortsByParent.set(event.parentId, event);
    if (event.type === "tool_aborted" && typeof event.metadata?.toolCallId === "string") toolAbortsByCallId.set(event.metadata.toolCallId, event);
    if (event.type === "harness_check_end" && event.parentId) checkEndsByParent.set(event.parentId, event);
  }

  for (const event of events) {
    const meta = event.metadata ?? {};
    if (event.type === "tool_queued") {
      const callId = typeof meta.toolCallId === "string" ? meta.toolCallId : "";
      if (callId && toolStartsByCallId.has(callId)) continue;
      items.push(toolActivity(event, callId ? toolAbortsByCallId.get(callId) : undefined));
      continue;
    }
    if (event.type === "tool_start") {
      items.push(toolActivity(event, toolAbortsByParent.get(event.id) ?? toolEndsByParent.get(event.id)));
      continue;
    }
    if (event.type === "tool_aborted" && !event.parentId) {
      const callId = typeof meta.toolCallId === "string" ? meta.toolCallId : "";
      if (callId && toolStartsByCallId.has(callId)) continue;
      items.push({
        kind: "tool",
        status: "aborted",
        label: typeof meta.toolName === "string" ? meta.toolName : "tool",
        detail: truncate(oneLine(redactSecretText(String(meta.reason ?? ""))), 90),
        timestamp: eventTime(event)
      });
      continue;
    }
    if (event.type === "harness_check_start") {
      items.push(harnessActivity(event, checkEndsByParent.get(event.id)));
      continue;
    }
    if (event.type === "context_budget") {
      const budget = meta.budget as { estimated_tokens?: unknown; message_count?: unknown; tool_count?: unknown } | undefined;
      items.push({
        kind: "context",
        status: "info",
        label: `context turn ${String(meta.turn ?? "?")}`,
        detail: `${String(budget?.estimated_tokens ?? "?")} est tokens  ${String(budget?.message_count ?? "?")} messages  ${String(budget?.tool_count ?? "?")} tools`,
        timestamp: eventTime(event)
      });
      continue;
    }
    if (event.type === "usage") {
      const usage = eventUsage(event);
      if (usage) {
        items.push({
          kind: "usage",
          status: "info",
          label: `usage turn ${String(meta.turn ?? "?")}`,
          detail: formatUsage(usage),
          timestamp: eventTime(event)
        });
      }
      continue;
    }
    if (event.type === "turn_budget_nudge") {
      const remaining = typeof meta.remainingTurns === "number" ? meta.remainingTurns : "?";
      items.push({
        kind: "budget",
        status: "waiting",
        label: "turn budget",
        detail: `${remaining} turns left; no files changed`,
        timestamp: eventTime(event)
      });
      continue;
    }
    if (event.type === "loop_control_steer" || event.type === "loop_control_tool_policy" || event.type === "loop_control_stop") {
      items.push({
        kind: "budget",
        status: event.type === "loop_control_stop" ? "failed" : "waiting",
        label: `loop ${String(meta.mode ?? "?")}`,
        detail: event.type === "loop_control_tool_policy"
          ? `tool policy${meta.toolsDisabled ? ": tools disabled" : ""}`
          : truncate(oneLine(redactSecretText(String(meta.reason ?? meta.message ?? ""))), 120),
        timestamp: eventTime(event)
      });
      continue;
    }
    if (event.type === "read_cache_hit") {
      items.push({
        kind: "tool",
        status: "ok",
        label: "read cache",
        detail: String(meta.path ?? ""),
        timestamp: eventTime(event)
      });
      continue;
    }
    if (event.type === "subagent_start") {
      items.push(subagentActivity(event, "running", "started"));
      continue;
    }
    if (event.type === "subagent_job_created") {
      items.push(subagentActivity(event, subagentStatus((meta.job as SubagentJobLike | undefined)?.status, "running"), "created"));
      continue;
    }
    if (event.type === "subagent_progress") {
      items.push(subagentActivity(event, subagentStatus(meta.status, "running"), "progress"));
      continue;
    }
    if (event.type === "subagent_job_closed") {
      items.push(subagentActivity(event, subagentStatus((meta.job as SubagentJobLike | undefined)?.status, "ok"), "closed"));
      continue;
    }
    if (event.type === "subagent_end" || event.type === "subagent_error") {
      const report = meta.report as { status?: unknown; summary?: unknown; error?: unknown } | undefined;
      items.push(subagentActivity(event, subagentStatus(report?.status, event.type === "subagent_error" ? "failed" : "ok"), "finished"));
      continue;
    }
    if (event.type === "review_gate_start") {
      items.push({
        kind: "review",
        status: "running",
        label: `review ${String(meta.gate ?? "?")}`,
        detail: "started",
        timestamp: eventTime(event)
      });
      continue;
    }
    if (event.type === "review_gate_end") {
      const status = String(meta.status ?? "");
      const findings = Array.isArray(meta.findings) ? meta.findings.length : 0;
      items.push({
        kind: "review",
        status: status === "failed" || status === "error" ? "failed" : "ok",
        label: `review ${String(meta.gate ?? "?")}`,
        detail: `${status || "done"} (${findings} findings)`,
        timestamp: eventTime(event)
      });
      continue;
    }
    if (event.type === "error") {
      items.push({
        kind: "error",
        status: "failed",
        label: "error",
        detail: truncate(oneLine(redactSecretText(String(meta.message ?? ""))), 120),
        timestamp: eventTime(event)
      });
    }
  }
  return items;
}

function entriesFromEvents(events: AgentEvent[]): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  const toolEndsByParent = new Map<string, AgentEvent>();
  const toolStartsByCallId = new Map<string, AgentEvent>();
  const toolAbortsByParent = new Map<string, AgentEvent>();
  const toolAbortsByCallId = new Map<string, AgentEvent>();
  const checkEndsByParent = new Map<string, AgentEvent>();
  let latestAssistantDelta: AgentEvent | null = null;
  for (const event of events) {
    if (event.type === "tool_end" && event.parentId) toolEndsByParent.set(event.parentId, event);
    if (event.type === "tool_start" && typeof event.metadata?.toolCallId === "string") toolStartsByCallId.set(event.metadata.toolCallId, event);
    if (event.type === "tool_aborted" && event.parentId) toolAbortsByParent.set(event.parentId, event);
    if (event.type === "tool_aborted" && typeof event.metadata?.toolCallId === "string") toolAbortsByCallId.set(event.metadata.toolCallId, event);
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
      const hasContent = typeof meta.content === "string" && meta.content.trim().length > 0;
      if (!hasContent && toolCalls > 0) continue;
      const text = hasContent ? redactSecretText(String(meta.content).trim()) : "(empty message)";
      entries.push({ kind: "assistant", text, toolCalls, timestamp: eventTime(event) });
      continue;
    }
    if (event.type === "tool_queued") {
      const callId = typeof meta.toolCallId === "string" ? meta.toolCallId : "";
      if (callId && toolStartsByCallId.has(callId)) continue;
      entries.push(toolEntry(event, callId ? toolAbortsByCallId.get(callId) : undefined));
      continue;
    }
    if (event.type === "tool_start") {
      entries.push(toolEntry(event, toolAbortsByParent.get(event.id) ?? toolEndsByParent.get(event.id)));
      continue;
    }
    if (event.type === "tool_aborted" && !event.parentId) {
      const callId = typeof meta.toolCallId === "string" ? meta.toolCallId : "";
      if (callId && toolStartsByCallId.has(callId)) continue;
      entries.push({
        kind: "tool",
        name: typeof meta.toolName === "string" ? meta.toolName : "tool",
        status: "aborted",
        summary: truncate(oneLine(redactSecretText(String(meta.reason ?? ""))), 90),
        timestamp: eventTime(event)
      });
      continue;
    }
    if (event.type === "context_budget") continue;
    if (event.type === "turn_budget_nudge") {
      entries.push({
        kind: "summary",
        status: "warning",
        text: truncate(oneLine(redactSecretText(String(meta.message ?? "Run budget warning."))), 160),
        timestamp: eventTime(event)
      });
      continue;
    }
    if (event.type === "loop_control_steer" || event.type === "loop_control_stop") {
      entries.push({
        kind: "summary",
        status: event.type === "loop_control_stop" ? "failed" : "warning",
        text: `loop controller ${String(meta.mode ?? "?")}: ${truncate(oneLine(redactSecretText(String(meta.message ?? meta.reason ?? ""))), 160)}`,
        timestamp: eventTime(event)
      });
      continue;
    }
    if (event.type === "loop_control_tool_policy") {
      const disabled = Array.isArray(meta.disabledTools) ? meta.disabledTools.join(", ") : "";
      entries.push({
        kind: "summary",
        text: `loop tool policy ${String(meta.mode ?? "?")}${disabled ? ` disabled ${disabled}` : ""}${meta.toolsDisabled ? " tools disabled" : ""}`,
        timestamp: eventTime(event)
      });
      continue;
    }
    if (event.type === "read_cache_hit") {
      entries.push({
        kind: "summary",
        text: `read cache hit: ${String(meta.path ?? "?")}`,
        timestamp: eventTime(event)
      });
      continue;
    }
    if (event.type === "harness_check_start") {
      entries.push(harnessEntry(event, checkEndsByParent.get(event.id)));
      continue;
    }
    if (event.type === "subagent_start") {
      entries.push(subagentTranscriptEntry(event, "running", "started"));
      continue;
    }
    if (event.type === "subagent_job_created") {
      entries.push(subagentTranscriptEntry(event, subagentStatus((meta.job as SubagentJobLike | undefined)?.status, "running"), "created"));
      continue;
    }
    if (event.type === "subagent_progress") {
      entries.push(subagentTranscriptEntry(event, subagentStatus(meta.status, "running"), "progress"));
      continue;
    }
    if (event.type === "subagent_job_closed") {
      entries.push(subagentTranscriptEntry(event, subagentStatus((meta.job as SubagentJobLike | undefined)?.status, "ok"), "closed"));
      continue;
    }
    if (event.type === "loop_guard_triggered") {
      entries.push({
        kind: "summary",
        status: String(meta.action ?? "loop_guard"),
        text: `loop guard ${String(meta.action ?? "?")}: ${truncate(oneLine(redactSecretText(String(meta.message ?? ""))), 120)}`,
        timestamp: eventTime(event)
      });
      continue;
    }
    if (event.type === "permission_catalog_updated") {
      entries.push({
        kind: "summary",
        text: `permission catalog updated: ${String(meta.ruleCount ?? "?")} rules`,
        timestamp: eventTime(event)
      });
      continue;
    }
    if (event.type === "subagent_end" || event.type === "subagent_error") {
      const report = meta.report as { status?: unknown; summary?: unknown; error?: unknown } | undefined;
      entries.push(subagentTranscriptEntry(event, subagentStatus(report?.status, event.type === "subagent_error" ? "failed" : "ok"), "finished"));
      continue;
    }
    if (event.type === "review_gate_start") {
      entries.push({
        kind: "summary",
        text: `review gate ${String(meta.gate ?? "?")} started`,
        timestamp: eventTime(event)
      });
      continue;
    }
    if (event.type === "review_gate_end") {
      const findings = Array.isArray(meta.findings) ? meta.findings.length : 0;
      entries.push({
        kind: "summary",
        status: String(meta.status ?? ""),
        text: `review gate ${String(meta.gate ?? "?")} ${String(meta.status ?? "?")} (${findings} findings)`,
        timestamp: eventTime(event)
      });
      continue;
    }
    if (event.type === "usage") continue;
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
  const sorted = entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => (a.entry.timestamp ?? "").localeCompare(b.entry.timestamp ?? "") || a.index - b.index)
    .map((item) => item.entry);
  return coalesceRunningSubagentEntries(sorted);
}

function sortActivity(items: ActivityItem[]): ActivityItem[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => (a.item.timestamp ?? "").localeCompare(b.item.timestamp ?? "") || a.index - b.index)
    .map((item) => item.item);
}

function coalesceRunningSubagentEntries(entries: TranscriptEntry[]): TranscriptEntry[] {
  const keep = entries.map(() => true);
  const latestByLabel = new Map<string, number>();
  entries.forEach((entry, index) => {
    if (entry.kind !== "subagent" || entry.status !== "running") return;
    const previous = latestByLabel.get(entry.label);
    if (previous !== undefined) keep[previous] = false;
    latestByLabel.set(entry.label, index);
  });
  return entries.filter((_entry, index) => keep[index]);
}

export function buildActivity(options: BuildActivityOptions): ActivityItem[] {
  const items = activityFromEvents(options.events);
  if (options.pendingApproval) {
    const summary = summarizeToolArguments(options.pendingApproval.toolName, options.pendingApproval.arguments)
      || options.pendingApproval.reason;
    items.push({
      kind: "approval",
      status: "waiting",
      label: options.pendingApproval.toolName,
      detail: `${options.pendingApproval.risk}  ${summary}`,
      timestamp: new Date().toISOString()
    });
  }
  if (options.result?.harness) {
    const failed = [...options.result.harness.validation_results, ...options.result.harness.precheck_results]
      .filter((item) => item.exit_code !== 0).length;
    const total = options.result.harness.validation_results.length + options.result.harness.precheck_results.length;
    if (total > 0) {
      items.push({
        kind: "check",
        status: failed > 0 ? "failed" : "ok",
        label: "validation evidence",
        detail: failed > 0 ? `${failed}/${total} checks failed` : `${total} checks passed`,
        timestamp: new Date(Date.now() + 1).toISOString()
      });
    }
  }
  return sortActivity(items);
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
    const changedCount = options.result.changedFiles?.length ?? 0;
    const noChanges = changedCount === 0 && options.result.status === "stopped";
    const phase = options.result.loopDiagnostics?.phase;
    const reason = options.result.loopDiagnostics?.lastControllerReason;
    const resultText = [
      `${options.result.status} ${options.result.finishReason}`,
      phase ? `phase=${phase}` : "",
      reason ? `reason=${reason}` : "",
      noChanges ? "no files changed" : changedCount > 0 ? `${changedCount} changed` : "",
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
