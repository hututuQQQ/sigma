import { redactSecretText } from "agent-core";
import type { ComposerState } from "../composer-state.js";
import type { TuiRunMode } from "../mode.js";
import { oneLine } from "../components/formatting.js";
import { fitStreamLine, muted, streamGlyphs, warning } from "./theme.js";
import { truncateToWidth } from "../ui/theme.js";

export interface RenderComposerOptions {
  state: ComposerState;
  mode: TuiRunMode;
  running: boolean;
  approvalPending: boolean;
  queuedInstruction?: string | null;
  width: number;
  color?: boolean;
  compact?: boolean;
}

function promptLabel(options: RenderComposerOptions): string {
  const g = streamGlyphs();
  if (options.approvalPending) return `approval ${g.prompt} `;
  if (options.running) return `draft ${g.prompt} `;
  return `${options.mode} ${g.prompt} `;
}

function textWithCursor(state: ComposerState): string {
  const g = streamGlyphs();
  const safeCursor = Math.min(Math.max(0, state.cursor), state.text.length);
  return `${state.text.slice(0, safeCursor)}${g.cursor}${state.text.slice(safeCursor)}`;
}

export function renderComposer(options: RenderComposerOptions): string {
  const width = options.width;
  const g = streamGlyphs();
  const prompt = promptLabel(options);
  const input = redactSecretText(textWithCursor(options.state));
  const inputLines = input.split(/\r?\n/);
  const lines: string[] = [];
  const firstPrefix = options.approvalPending ? warning(prompt, options.color ?? false) : prompt;
  lines.push(fitStreamLine(`${firstPrefix}${inputLines[0] ?? g.cursor}`, width));
  for (const line of inputLines.slice(1)) {
    lines.push(fitStreamLine(`  ${g.prompt} ${line}`, width));
  }

  if (!options.compact) {
    const queue = options.queuedInstruction
      ? `queued ${g.pointer} ${truncateToWidth(oneLine(redactSecretText(options.queuedInstruction)), Math.max(10, width - 10))}`
      : "";
    if (queue) lines.push(fitStreamLine(muted(queue, options.color ?? false), width));
    const send = options.running ? "enter queue" : "enter send";
    const hints = `${send} ${g.separator} ctrl+j newline ${g.separator} tab plan/build ${g.separator} / commands ${g.separator} @ files ${g.separator} ! shell`;
    lines.push(fitStreamLine(muted(hints, options.color ?? false), width));
  }
  return lines.join("\n");
}
