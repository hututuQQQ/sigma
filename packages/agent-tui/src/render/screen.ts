import path from "node:path";
import type { ProviderName } from "agent-ai";
import type { AgentEvent, AgentRunResult, PermissionMode } from "agent-core";
import type { ComposerState } from "../composer-state.js";
import type { TuiRunMode } from "../mode.js";
import type { TranscriptEntry } from "../view-model.js";
import { lineCount, splitLines } from "../ui/layout.js";
import { truncateToWidth } from "../ui/theme.js";
import { renderComposer } from "./composer.js";
import { renderTranscript } from "./transcript.js";
import { fitStreamLine, roleColor, streamGlyphs } from "./theme.js";

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

export function renderTopBar(options: RenderScreenOptions): string {
  const g = streamGlyphs();
  const width = options.width;
  const workspace = path.basename(options.workspacePath) || options.workspacePath;
  const model = options.model ?? options.result?.model ?? "default";
  const state = options.running ? "running" : options.result?.status ?? "idle";
  const brand = roleColor("brand", `${g.sigma} Sigma`, options.color ?? false);
  const stateRole: "danger" | "dim" | "success" | "warning" = options.running
    ? "warning"
    : state === "error"
      ? "danger"
      : state === "completed"
        ? "success"
        : state === "stopped"
          ? "warning"
          : "dim";
  const status = roleColor(stateRole, state, options.color ?? false);
  const chips = width < 72
    ? [options.mode, status]
    : [`${options.provider}/${model}`, options.mode, options.permissionMode, status];
  return fitStreamLine([
    `${brand} ${truncateToWidth(workspace, Math.max(10, Math.floor(width / 4)))}`,
    chips.join(` ${g.separator} `)
  ].filter(Boolean).join("  "), width);
}

function trimScreen(lines: string[], height: number): string[] {
  if (lines.length <= height) return lines;
  return lines.slice(0, height);
}

export function renderScreen(options: RenderScreenOptions): string {
  const compact = options.height < 24;
  const topLines = [renderTopBar(options)];
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
