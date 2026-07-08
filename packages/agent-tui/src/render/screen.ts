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
import { renderComposer } from "./composer.js";
import { renderTranscript } from "./transcript.js";
import { fitStreamLine, muted, roleColor, separatorLine, streamGlyphs } from "./theme.js";

export interface RenderScreenOptions {
  workspacePath: string;
  provider: ProviderName;
  model?: string;
  permissionMode: PermissionMode;
  validationMode?: AgentHarnessValidationMode;
  finalEvidenceMode?: AgentFinalEvidenceMode;
  maxTurns?: number;
  mode: TuiRunMode;
  running: boolean;
  result: AgentRunResult | null;
  events: AgentEvent[];
  message: string | null;
  queuedInstruction?: string | null;
  composer: ComposerState;
  entries: TranscriptEntry[];
  workbenchOpen?: boolean;
  filePaths?: string[];
  diffText?: string;
  overlay?: string;
  palette?: string;
  width: number;
  height: number;
  color?: boolean;
}

function stateName(options: RenderScreenOptions): string {
  return options.running ? "running" : options.result?.status ?? "idle";
}

function stateRole(state: string, running: boolean): "danger" | "dim" | "success" | "warning" {
  if (running) return "warning";
  if (state === "error") return "danger";
  if (state === "completed") return "success";
  if (state === "stopped") return "warning";
  return "dim";
}

export function renderTopBar(options: RenderScreenOptions): string {
  const g = streamGlyphs();
  const width = options.width;
  const model = options.model ?? options.result?.model ?? "default";
  const state = stateName(options);
  const brand = roleColor("brand", sigmaBrandName(), options.color ?? false);
  const status = roleColor(stateRole(state, options.running), state, options.color ?? false);
  const chips = width < 72
    ? [options.mode, status]
    : [`${options.provider}/${model}`, options.mode, options.permissionMode, status];
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

function statusMarker(status: "running" | "ok" | "failed" | undefined, color: boolean): string {
  const g = streamGlyphs();
  if (status === "running") return roleColor("warning", g.running, color);
  if (status === "ok") return roleColor("success", g.ok, color);
  if (status === "failed") return roleColor("danger", g.fail, color);
  return roleColor("dim", g.info, color);
}

function recentActivity(entries: TranscriptEntry[], width: number, color: boolean): string[] {
  const g = streamGlyphs();
  const recent = entries.filter((entry) => entry.kind === "tool" || entry.kind === "test" || entry.kind === "approval").slice(-5);
  if (recent.length === 0) return [muted("none yet", color)];

  return recent.map((entry) => {
    if (entry.kind === "approval") {
      return truncateToWidth(`${roleColor("warning", "approval", color)} ${entry.toolName} ${g.separator} ${entry.risk}`, width);
    }
    if (entry.kind === "tool") {
      const duration = typeof entry.durationMs === "number" ? ` ${g.separator} ${entry.durationMs}ms` : "";
      return truncateToWidth(`${statusMarker(entry.status, color)} ${entry.name} ${entry.summary}${duration}`, width);
    }
    const duration = typeof entry.durationMs === "number" ? ` ${g.separator} ${entry.durationMs}ms` : "";
    return truncateToWidth(`${statusMarker(entry.status, color)} ${oneLine(redactSecretText(entry.command))} ${duration}`, width);
  });
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
    roleColor("accent", "Tool calls", color),
    ...recentActivity(options.entries, width, color).map((line) => `  ${truncateToWidth(line, Math.max(8, width - 2))}`),
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
  const running = new Set<string>();
  for (const event of events) {
    if (event.type === "tool_start") running.add(event.id);
    if (event.type === "tool_end" && event.parentId) running.delete(event.parentId);
  }
  return running.size;
}

function renderBottomStatus(options: RenderScreenOptions): string {
  const g = streamGlyphs();
  const model = options.model ?? options.result?.model ?? "default";
  const usage = options.result?.usage ?? usageFromEvents(options.events);
  const tools = runningTools(options.events);
  const pieces = [
    options.mode,
    `${options.provider}/${model}`,
    options.permissionMode,
    stateName(options)
  ];
  if (usage) pieces.push(`ctx ${formatUsage(usage).replaceAll(" ", "/")}`);
  if (tools > 0) pieces.push(`${tools} tool${tools === 1 ? "" : "s"}`);
  return pieces.join(` ${g.separator} `);
}

function trimScreen(lines: string[], height: number): string[] {
  if (lines.length <= height) return lines;
  return lines.slice(0, height);
}

export function renderScreen(options: RenderScreenOptions): string {
  const compact = options.height < 24;
  const topLines: string[] = [];
  const statusLine = renderBottomStatus(options);
  const composer = renderComposer({
    state: options.composer,
    mode: options.mode,
    running: options.running,
    approvalPending: options.entries.some((entry) => entry.kind === "approval"),
    queuedInstruction: options.queuedInstruction,
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
  const transcript = renderTranscript(options.entries, transcriptWidth, mainHeight, options.color);
  const main = useWorkbench
    ? joinColumns(transcript, renderWorkbenchPanel(options, workbenchWidth, mainHeight), 2, options.width)
    : transcript;
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
