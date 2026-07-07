import path from "node:path";
import type { ProviderName } from "agent-ai";
import type { AgentEvent, AgentRunResult, PermissionMode } from "agent-core";
import type { ComposerState } from "../composer-state.js";
import type { TuiRunMode } from "../mode.js";
import type { TranscriptEntry } from "../view-model.js";
import { formatUsage } from "../components/formatting.js";
import { usageFromEvents } from "../components/status-bar.js";
import { lineCount, splitLines } from "../ui/layout.js";
import { truncateToWidth } from "../ui/theme.js";
import { renderComposer } from "./composer.js";
import { renderTranscript } from "./transcript.js";
import { fitStreamLine, muted, roleColor, separatorLine, streamGlyphs } from "./theme.js";

export interface RenderScreenOptions {
  workspacePath: string;
  provider: ProviderName;
  model?: string;
  permissionMode: PermissionMode;
  mode: TuiRunMode;
  running: boolean;
  result: AgentRunResult | null;
  events: AgentEvent[];
  message: string | null;
  queuedInstruction?: string | null;
  composer: ComposerState;
  entries: TranscriptEntry[];
  overlay?: string;
  palette?: string;
  width: number;
  height: number;
  color?: boolean;
}

function lastTurn(events: AgentEvent[]): number | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const turn = events[index].metadata?.turn;
    if (typeof turn === "number") return turn;
  }
  return null;
}

export function renderTopBar(options: RenderScreenOptions): string {
  const g = streamGlyphs();
  const width = options.width;
  const workspace = path.basename(options.workspacePath) || options.workspacePath;
  const model = options.model ?? options.result?.model ?? "default";
  const state = options.running ? "running" : options.result?.status ?? "idle";
  const turn = options.result?.turns ?? lastTurn(options.events) ?? 0;
  const tools = options.result?.toolCalls ?? options.events.filter((event) => event.type === "tool_start").length;
  const usage = options.result?.usage ?? usageFromEvents(options.events);
  const brand = roleColor("accent", `${g.sigma} sigma`, options.color ?? false);

  const wideParts = [
    brand,
    workspace,
    `${options.provider}/${model}`,
    `mode ${options.mode}`,
    options.permissionMode,
    state,
    turn > 0 ? `turn ${turn}` : "",
    tools > 0 ? `tools ${tools}` : "",
    usage ? formatUsage(usage) : "",
    options.message ? `notice ${options.message}` : "",
    "? help",
    "/ commands"
  ].filter(Boolean);

  const narrowParts = [
    brand,
    `${options.mode}`,
    state,
    options.message ? truncateToWidth(options.message, 24) : ""
  ].filter(Boolean);

  const parts = width < 80 ? narrowParts : wideParts;
  return fitStreamLine(parts.join(` ${g.separator} `), width);
}

function trimScreen(lines: string[], height: number): string[] {
  if (lines.length <= height) return lines;
  return lines.slice(0, height);
}

export function renderScreen(options: RenderScreenOptions): string {
  const compact = options.height < 24;
  const topLines = compact
    ? [renderTopBar(options)]
    : [renderTopBar(options), muted(separatorLine(options.width), options.color ?? false)];
  const composer = renderComposer({
    state: options.composer,
    mode: options.mode,
    running: options.running,
    approvalPending: options.entries.some((entry) => entry.kind === "approval"),
    queuedInstruction: options.queuedInstruction,
    width: options.width,
    color: options.color,
    compact
  });
  const bottomHeight = lineCount(composer) + (options.palette ? lineCount(options.palette) : 0) + (options.overlay ? lineCount(options.overlay) : 0);
  const transcriptHeight = Math.max(2, options.height - topLines.length - bottomHeight - 1);
  const transcript = renderTranscript(options.entries, options.width, transcriptHeight, options.color);
  const lines = [
    ...topLines,
    ...splitLines(transcript),
    ...(options.overlay ? splitLines(options.overlay) : []),
    ...(options.palette ? splitLines(options.palette) : []),
    ...splitLines(composer)
  ].map((line) => fitStreamLine(line, options.width));
  return trimScreen(lines, options.height).join("\n");
}
