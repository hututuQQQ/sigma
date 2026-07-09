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
  const input = redactSecretText(textWithCursor(options.state));
  const inputLines = input.split(/\r?\n/);
  const lines: string[] = [];

  if (options.compact) {
    const firstPrefix = options.approvalPending ? warning(`${prompt} `, options.color ?? false) : `${prompt} `;
    lines.push(fitStreamLine(`${firstPrefix}${inputLines[0] ?? g.cursor}`, width));
    for (const line of inputLines.slice(1)) {
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
  lines.push(rule);
  const safeLines = inputLines.length > 0 ? inputLines : [g.cursor];
  lines.push(fitStreamLine(`${label} ${safeLines[0] ?? g.cursor}`, width));
  for (const line of safeLines.slice(1)) {
    lines.push(fitStreamLine(`  ${g.prompt} ${line}`, width));
  }
  lines.push(rule);

  const queue = options.queuedInstruction
    ? `queued ${g.pointer} ${truncateToWidth(oneLine(redactSecretText(options.queuedInstruction)), Math.max(10, width - 10))}`
    : "";
  if (queue) lines.push(fitStreamLine(muted(`  ${queue}`, color), width));
  lines.push(footerLine(options));
  return lines.join("\n");
}
