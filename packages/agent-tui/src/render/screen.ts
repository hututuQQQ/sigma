import type { ProviderName } from "agent-ai";
import {
  DEFAULT_FINAL_EVIDENCE_MODE,
  DEFAULT_VALIDATION_MODE,
  redactSecretText,
  type AgentEvent,
  type AgentFinalEvidenceMode,
  type AgentHarnessValidationMode,
  type AgentRunResult,
  type PermissionMode,
  type SandboxConfig,
  type TokenTotals
} from "agent-core";
import { formatUsage, oneLine } from "../components/formatting.js";
import { usageFromEvents } from "../components/status-bar.js";
import type { ComposerState } from "../composer-state.js";
import type { TuiRunMode } from "../mode.js";
import type { TranscriptEntry } from "../view-model.js";
import { joinColumns, lineCount, splitLines } from "../ui/layout.js";
import { sigmaBrandName } from "../ui/brand.js";
import { truncateToWidth, visibleWidth } from "../ui/theme.js";
import { buildTuiRunState, type TuiRunState } from "../run-state.js";
import { renderComposer } from "./composer.js";
import { renderTranscript } from "./transcript.js";
import { fitStreamLine, muted, roleColor, separatorLine, streamGlyphs } from "./theme.js";
import type { ActivityItem, ActivityStatus } from "../view-model.js";

export interface RenderScreenOptions {
  workspacePath: string;
  provider: ProviderName;
  model?: string;
  permissionMode: PermissionMode;
  sandbox?: SandboxConfig;
  validationMode?: AgentHarnessValidationMode;
  finalEvidenceMode?: AgentFinalEvidenceMode;
  maxTurns?: number;
  mode: TuiRunMode;
  running: boolean;
  result: AgentRunResult | null;
  runState?: TuiRunState;
  events: AgentEvent[];
  message: string | null;
  queuedInstruction?: string | null;
  composer: ComposerState;
  entries: TranscriptEntry[];
  activityItems?: ActivityItem[];
  workbenchOpen?: boolean;
  filePaths?: string[];
  diffText?: string;
  overlay?: string;
  palette?: string;
  transcriptScrollOffset?: number;
  width: number;
  height: number;
  color?: boolean;
}

function screenRunState(options: RenderScreenOptions): TuiRunState {
  return options.runState ?? buildTuiRunState({
    running: options.running,
    result: options.result,
    queuedInstruction: options.queuedInstruction,
    approvalPending: options.entries.some((entry) => entry.kind === "approval")
  });
}

function stateName(options: RenderScreenOptions): string {
  return screenRunState(options).label;
}

function sandboxLabel(sandbox: SandboxConfig | undefined): string | null {
  if (!sandbox) return null;
  const network = typeof sandbox.network === "string" ? sandbox.network : sandbox.network?.mode;
  const backend = sandbox.backend && sandbox.backend !== "auto" ? `/${sandbox.backend}` : "";
  return `${sandbox.mode ?? "workspace-write"}${backend}${network ? `:${network}` : ""}`;
}

export function renderTopBar(options: RenderScreenOptions): string {
  const g = streamGlyphs();
  const width = options.width;
  const model = options.model ?? options.result?.model ?? "default";
  const runState = screenRunState(options);
  const state = runState.label;
  const brand = roleColor("brand", sigmaBrandName(), options.color ?? false);
  const status = roleColor(runState.tone, state, options.color ?? false);
  const sandbox = sandboxLabel(options.sandbox);
  const chips = width < 72
    ? [options.mode, status]
    : [`${options.provider}/${model}`, options.mode, options.permissionMode, ...(sandbox ? [sandbox] : []), status];
  return fitStreamLine([
    brand,
    chips.join(` ${g.separator} `)
  ].filter(Boolean).join("  "), width);
}

function validationState(options: RenderScreenOptions): string {
  if (!options.result?.harness) return options.validationMode ?? DEFAULT_VALIDATION_MODE;
  const failed = [...options.result.harness.validation_results, ...options.result.harness.precheck_results]
    .some((item) => item.exit_code !== 0);
  return failed ? "failed" : "ok";
}

function usageSummary(options: RenderScreenOptions): string {
  const usage: Partial<TokenTotals> | undefined = options.result?.usage ?? usageFromEvents(options.events);
  return usage ? formatUsage(usage) : "unknown";
}

function statusMarker(status: ActivityStatus | undefined, color: boolean): string {
  const g = streamGlyphs();
  if (status === "queued") return roleColor("dim", g.info, color);
  if (status === "running") return roleColor("warning", g.running, color);
  if (status === "ok") return roleColor("success", g.ok, color);
  if (status === "failed") return roleColor("danger", g.fail, color);
  if (status === "aborted") return roleColor("warning", g.fail, color);
  if (status === "waiting") return roleColor("warning", g.info, color);
  if (status === "info") return roleColor("dim", g.info, color);
  return roleColor("dim", g.info, color);
}

function fallbackActivity(entries: TranscriptEntry[]): ActivityItem[] {
  return entries.flatMap((entry): ActivityItem[] => {
    if (entry.kind === "approval") {
      return [{
        kind: "approval",
        status: "waiting",
        label: entry.toolName,
        detail: `${entry.risk}  ${entry.summary}`,
        timestamp: entry.timestamp
      }];
    }
    if (entry.kind === "tool") {
      return [{
        kind: "tool",
        status: entry.status,
        label: entry.name,
        detail: entry.summary,
        durationMs: entry.durationMs,
        timestamp: entry.timestamp
      }];
    }
    if (entry.kind === "test") {
      return [{
        kind: "check",
        status: entry.status,
        label: oneLine(redactSecretText(entry.command)),
        detail: entry.summary,
        durationMs: entry.durationMs,
        timestamp: entry.timestamp
      }];
    }
    return [];
  });
}

function recentActivity(activityItems: ActivityItem[] | undefined, entries: TranscriptEntry[], width: number, color: boolean): string[] {
  const g = streamGlyphs();
  const recent = (activityItems ?? fallbackActivity(entries)).slice(-6);
  if (recent.length === 0) return [muted("none yet", color)];

  return recent.map((item) => {
    const duration = typeof item.durationMs === "number" ? ` ${g.separator} ${item.durationMs}ms` : "";
    return truncateToWidth(`${statusMarker(item.status, color)} ${item.label} ${item.detail}${duration}`, width);
  });
}

function activityLine(item: ActivityItem, width: number, color: boolean): string {
  const g = streamGlyphs();
  const duration = typeof item.durationMs === "number" ? ` ${g.separator} ${item.durationMs}ms` : "";
  return truncateToWidth(`${statusMarker(item.status, color)} ${item.label} ${item.detail}${duration}`, width);
}

function activityStripItems(options: RenderScreenOptions): ActivityItem[] {
  const all = options.activityItems ?? fallbackActivity(options.entries);
  const active = all.filter((item) => item.status === "queued" || item.status === "running" || item.status === "waiting");
  if (active.length > 0) return active.slice(-4);
  if (!options.running) return [];
  return all.filter((item) => item.kind === "subagent" || item.kind === "tool" || item.kind === "check" || item.kind === "approval").slice(-4);
}

function renderActivityStrip(options: RenderScreenOptions, width: number, maxHeight: number): string[] {
  if (maxHeight < 2) return [];
  const color = options.color ?? false;
  const items = activityStripItems(options);
  if (items.length === 0) return [];
  const lines = [
    muted(separatorLine(width), color),
    roleColor("accent", "Activity", color),
    ...items.map((item) => `  ${activityLine(item, Math.max(8, width - 2), color)}`)
  ];
  return lines.slice(0, maxHeight).map((line) => fitStreamLine(line, width));
}

function panelLine(label: string, value: string, width: number): string {
  return truncateToWidth(`${label.padEnd(11)} ${value}`, width);
}

function diffStatLines(diffText: string | undefined, width: number): string[] {
  const raw = redactSecretText(diffText ?? "").trim();
  if (!raw) return ["none"];
  return raw.split(/\r?\n/).slice(0, 5).map((line) => truncateToWidth(line.trimEnd(), width));
}

function renderWorkbenchPanel(options: RenderScreenOptions, width: number, height: number): string {
  const color = options.color ?? false;
  const g = streamGlyphs();
  const files = (options.filePaths ?? []).slice(0, 6);
  const changed = options.result?.changedFiles ?? [];
  const lines = [
    roleColor("brand", `${g.sigma} Workbench`, color),
    muted(separatorLine(width), color),
    roleColor("accent", "Files", color),
    ...(files.length > 0 ? files.map((file) => `  ${truncateToWidth(file, Math.max(8, width - 2))}`) : ["  none indexed"]),
    "",
    roleColor("accent", "Changes", color),
    ...(changed.length > 0
      ? changed.slice(0, 6).map((file) => `  ${truncateToWidth(file, Math.max(8, width - 2))}`)
      : diffStatLines(options.diffText, Math.max(8, width - 2)).map((line) => `  ${line}`)),
    "",
    roleColor("accent", "Activity", color),
    ...recentActivity(options.activityItems, options.entries, width, color).map((line) => `  ${truncateToWidth(line, Math.max(8, width - 2))}`),
    "",
    roleColor("accent", "Checks", color),
    panelLine("validation", validationState(options), width),
    panelLine("evidence", options.result?.finalGate?.status ?? options.finalEvidenceMode ?? DEFAULT_FINAL_EVIDENCE_MODE, width),
    panelLine("tokens", usageSummary(options), width)
  ];
  return lines.slice(0, Math.max(1, height)).map((line) => fitStreamLine(line, width)).join("\n");
}

function shouldUseWorkbench(options: RenderScreenOptions, mainHeight: number): boolean {
  return Boolean(options.workbenchOpen) && options.width >= 110 && mainHeight >= 8;
}

function runningTools(events: AgentEvent[]): number {
  const queued = new Set<string>();
  const running = new Set<string>();
  for (const event of events) {
    const callId = typeof event.metadata?.toolCallId === "string" ? event.metadata.toolCallId : "";
    if (event.type === "tool_queued" && callId) queued.add(callId);
    if (event.type === "tool_start") {
      running.add(event.id);
      if (callId) queued.delete(callId);
    }
    if ((event.type === "tool_end" || event.type === "tool_aborted") && event.parentId) running.delete(event.parentId);
    if ((event.type === "tool_end" || event.type === "tool_aborted") && callId) queued.delete(callId);
  }
  return running.size + queued.size;
}

function renderBottomStatus(options: RenderScreenOptions): string {
  const g = streamGlyphs();
  const model = options.model ?? options.result?.model ?? "default";
  const usage = options.result?.usage ?? usageFromEvents(options.events);
  const runState = screenRunState(options);
  const tools = runningTools(options.events);
  const pieces = [
    options.mode,
    `${options.provider}/${model}`,
    options.permissionMode,
    runState.label
  ];
  if (usage) pieces.push(`ctx ${formatUsage(usage).replaceAll(" ", "/")}`);
  if (tools > 0) pieces.push(`${tools} tool${tools === 1 ? "" : "s"}`);
  if (runState.queuedCount > 0) pieces.push(`queued ${runState.queuedCount}`);
  if ((options.transcriptScrollOffset ?? 0) > 0) pieces.push(`scroll +${options.transcriptScrollOffset}`);
  return pieces.join(` ${g.separator} `);
}

function trimScreen(lines: string[], height: number): string[] {
  if (lines.length <= height) return lines;
  return lines.slice(0, height);
}

export function renderScreen(options: RenderScreenOptions): string {
  const runState = screenRunState(options);
  const compact = options.height < 24;
  const color = options.color ?? false;
  const g = streamGlyphs();
  const notice = options.message
    ? fitStreamLine(`${roleColor("accent", "notice", color)} ${g.pointer} ${truncateToWidth(oneLine(redactSecretText(options.message)), Math.max(10, options.width - 9))}`, options.width)
    : null;
  const topLines: string[] = compact
    ? []
    : [renderTopBar(options), ...(notice ? [notice] : [])];
  const statusLine = renderBottomStatus(options);
  const composer = renderComposer({
    state: options.composer,
    mode: options.mode,
    running: runState.running,
    approvalPending: runState.approvalPending,
    prompt: runState.composerPrompt,
    queuedInstruction: runState.queuedInstruction,
    footerStatus: statusLine,
    width: options.width,
    color: options.color,
    compact
  });
  const bottomHeight = lineCount(composer) + (options.palette ? lineCount(options.palette) : 0) + (options.overlay ? lineCount(options.overlay) : 0);
  const mainHeight = Math.max(2, options.height - topLines.length - bottomHeight);
  const useWorkbench = shouldUseWorkbench(options, mainHeight);
  const workbenchWidth = useWorkbench ? Math.min(42, Math.max(34, Math.floor(options.width * 0.32))) : 0;
  const transcriptWidth = useWorkbench ? Math.max(40, options.width - workbenchWidth - 2) : options.width;
  const activityStrip = useWorkbench ? [] : renderActivityStrip(options, transcriptWidth, Math.min(5, Math.max(0, mainHeight - 4)));
  const transcriptHeight = useWorkbench ? mainHeight : Math.max(1, mainHeight - activityStrip.length);
  const transcript = renderTranscript(
    options.entries,
    transcriptWidth,
    transcriptHeight,
    options.color,
    options.transcriptScrollOffset ?? 0
  );
  const main = useWorkbench
    ? joinColumns(transcript, renderWorkbenchPanel(options, workbenchWidth, mainHeight), 2, options.width)
    : [transcript, ...activityStrip].filter(Boolean).join("\n");
  const lines = [
    ...topLines,
    ...splitLines(main),
    ...(options.overlay ? splitLines(options.overlay) : []),
    ...(options.palette ? splitLines(options.palette) : []),
    ...splitLines(composer)
  ].map((line) => {
    const fitted = fitStreamLine(line, options.width);
    return visibleWidth(fitted) <= options.width ? fitted : truncateToWidth(fitted, options.width);
  });
  return trimScreen(lines, options.height).join("\n");
}
