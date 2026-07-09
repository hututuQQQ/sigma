import { redactSecretText } from "agent-core";
import type { ComposerState } from "../composer-state.js";
import type { TuiRunMode } from "../mode.js";
import { oneLine } from "../components/formatting.js";
import { fitStreamLine, muted, roleColor, separatorLine, streamGlyphs, warning } from "./theme.js";
import { truncateToWidth, visibleWidth } from "../ui/theme.js";

export interface RenderComposerOptions {
  state: ComposerState;
  mode: TuiRunMode;
  running: boolean;
  approvalPending: boolean;
  prompt?: ">" | "queue >" | "approval >";
  queuedInstruction?: string | null;
  footerStatus?: string;
  width: number;
  maxHeight?: number;
  color?: boolean;
  compact?: boolean;
}

function promptLabel(options: RenderComposerOptions): string {
  if (options.prompt) return options.prompt;
  if (options.approvalPending) return "approval >";
  if (options.running) return "queue >";
  return ">";
}

function textWithCursor(state: ComposerState): string {
  const g = streamGlyphs();
  const safeCursor = Math.min(Math.max(0, state.cursor), state.text.length);
  return `${state.text.slice(0, safeCursor)}${g.cursor}${state.text.slice(safeCursor)}`;
}

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function cursorLineIndex(state: ComposerState): number {
  const safeCursor = Math.min(Math.max(0, state.cursor), state.text.length);
  return normalizeNewlines(state.text.slice(0, safeCursor)).split("\n").length - 1;
}

function visibleInputLines(inputLines: string[], cursorLine: number, maxLines: number): string[] {
  if (inputLines.length <= maxLines) return inputLines;
  const safeMax = Math.max(1, maxLines);
  if (safeMax === 1) return [`... ${inputLines.length - 1} lines hidden`];

  const safeCursor = Math.min(Math.max(0, cursorLine), inputLines.length - 1);
  const needsTopOnly = safeCursor >= inputLines.length - safeMax + 1;
  if (needsTopOnly) {
    const bodyCount = safeMax - 1;
    const start = Math.max(0, inputLines.length - bodyCount);
    return [`... ${start} lines above`, ...inputLines.slice(start)];
  }

  const needsBottomOnly = safeCursor < safeMax - 1;
  if (needsBottomOnly) {
    const bodyCount = safeMax - 1;
    const end = Math.min(inputLines.length, bodyCount);
    return [...inputLines.slice(0, end), `... ${inputLines.length - end} lines below`];
  }

  if (safeMax === 2) {
    return [`... ${safeCursor} lines above`, inputLines[safeCursor] ?? ""];
  }

  const bodyCount = safeMax - 2;
  const before = Math.floor((bodyCount - 1) / 2);
  const start = Math.min(
    Math.max(0, safeCursor - before),
    Math.max(0, inputLines.length - bodyCount)
  );
  const end = Math.min(inputLines.length, start + bodyCount);
  return [
    `... ${start} lines above`,
    ...inputLines.slice(start, end),
    `... ${inputLines.length - end} lines below`
  ];
}

function footerLine(options: RenderComposerOptions): string {
  const g = streamGlyphs();
  const color = options.color ?? false;
  const left = "? for shortcuts";
  const right = options.footerStatus
    ? options.footerStatus
    : `${options.mode} ${g.separator} tab workbench ${g.separator} / commands`;
  const leftText = `  ${left}`;
  const gap = options.width - visibleWidth(leftText) - visibleWidth(right);
  const line = gap >= 2
    ? `${leftText}${" ".repeat(gap)}${right}`
    : `${leftText} ${g.separator} ${right}`;
  return fitStreamLine(muted(line, color), options.width);
}

export function renderComposer(options: RenderComposerOptions): string {
  const width = options.width;
  const g = streamGlyphs();
  const prompt = promptLabel(options);
  const input = normalizeNewlines(redactSecretText(textWithCursor(options.state)));
  const inputLines = input.split("\n");
  const lines: string[] = [];

  if (options.compact) {
    const visible = visibleInputLines(inputLines, cursorLineIndex(options.state), options.maxHeight ?? inputLines.length);
    const firstPrefix = options.approvalPending ? warning(`${prompt} `, options.color ?? false) : `${prompt} `;
    lines.push(fitStreamLine(`${firstPrefix}${visible[0] ?? g.cursor}`, width));
    for (const line of visible.slice(1)) {
      lines.push(fitStreamLine(`  ${g.prompt} ${line}`, width));
    }
    return lines.join("\n");
  }

  const color = options.color ?? false;
  const rule = options.approvalPending
    ? warning(separatorLine(width), color)
    : muted(separatorLine(width), color);
  const label = options.approvalPending
    ? warning(prompt, color)
    : roleColor("accent", prompt, color);
  const queue = options.queuedInstruction
    ? `queued ${g.pointer} ${truncateToWidth(oneLine(redactSecretText(options.queuedInstruction)), Math.max(10, width - 10))}`
    : "";
  const chromeLines = 3 + (queue ? 1 : 0);
  const maxInputLines = options.maxHeight ? Math.max(1, options.maxHeight - chromeLines) : inputLines.length;
  const safeLines = visibleInputLines(inputLines.length > 0 ? inputLines : [g.cursor], cursorLineIndex(options.state), maxInputLines);
  lines.push(rule);
  lines.push(fitStreamLine(`${label} ${safeLines[0] ?? g.cursor}`, width));
  for (const line of safeLines.slice(1)) {
    lines.push(fitStreamLine(`  ${g.prompt} ${line}`, width));
  }
  lines.push(rule);

  if (queue) lines.push(fitStreamLine(muted(`  ${queue}`, color), width));
  lines.push(footerLine(options));
  return lines.join("\n");
}
