import type { PresentationState } from "agent-presentation";
import { cellWidth, graphemes } from "./composer.js";
import type { TuiState } from "./state.js";

const ansi = {
  reset: "\u001b[0m", dim: "\u001b[2m", cyan: "\u001b[38;5;81m", green: "\u001b[38;5;114m",
  yellow: "\u001b[38;5;221m", red: "\u001b[38;5;203m", inverse: "\u001b[7m", clear: "\u001b[2J\u001b[H"
};
const wrappedRows = new WeakMap<object, Map<number, string[]>>();
const regexCodePoint = (hex: string): string => `\\u${hex}`;
const escapeCode = regexCodePoint("001b");
const bellCode = regexCodePoint("0007");
const oscPattern = new RegExp(`${escapeCode}\\][^${bellCode}]*(?:${bellCode}|${escapeCode}\\\\)`, "gu");
const csiPattern = new RegExp(`${escapeCode}\\[[0-?]*[ -/]*[@-~]`, "gu");
const escapePattern = new RegExp(`${escapeCode}[@-_]`, "gu");
const controlPattern = new RegExp(
  `[${regexCodePoint("0000")}-${regexCodePoint("0008")}${regexCodePoint("000b")}-${regexCodePoint("001f")}${regexCodePoint("007f")}]`,
  "gu"
);

export function sanitizeTerminalText(value: string): string {
  return value
    .replace(oscPattern, "")
    .replace(csiPattern, "")
    .replace(escapePattern, "")
    .replace(/\t/gu, "    ")
    .replace(controlPattern, "�");
}

function truncate(value: string, width: number): string {
  if (width <= 0) return "";
  let result = "";
  for (const item of graphemes(value)) {
    if (cellWidth(`${result}${item}`) > width) return width === 1 ? "…" : `${truncate(result, width - 1)}…`;
    result += item;
  }
  return result;
}

function wrap(value: string, width: number): string[] {
  if (width <= 1) return [truncate(value, Math.max(1, width))];
  const lines: string[] = [];
  for (const source of value.split("\n")) {
    let current = "";
    for (const item of graphemes(source)) {
      if (cellWidth(`${current}${item}`) > width) {
        lines.push(current);
        current = item;
      } else current += item;
    }
    lines.push(current);
  }
  return lines.length > 0 ? lines : [""];
}

function transcriptLines(view: PresentationState, width: number, rowLimit: number): string[] {
  const lines: string[] = [];
  for (let index = view.transcript.length - 1; index >= 0 && lines.length < rowLimit; index -= 1) {
    const item = view.transcript[index];
    const name = item.role === "user" ? "you" : "sigma";
    const color = item.role === "user" ? ansi.cyan : ansi.green;
    const bodyWidth = Math.max(1, width - name.length - 1);
    let byWidth = wrappedRows.get(item);
    if (!byWidth) {
      byWidth = new Map();
      wrappedRows.set(item, byWidth);
    }
    let body = byWidth.get(bodyWidth);
    if (!body) {
      body = wrap(sanitizeTerminalText(item.text), bodyWidth);
      byWidth.set(bodyWidth, body);
    }
    lines.unshift(`${color}${name}${ansi.reset} ${body[0] ?? ""}`, ...body.slice(1).map((line) => `${" ".repeat(name.length + 1)}${line}`));
  }
  return lines.slice(-rowLimit);
}

function activityLines(view: PresentationState, width: number): string[] {
  return view.activity.slice(-8).map((item) => {
    const color = item.status === "failed" ? ansi.red : item.status === "running" ? ansi.yellow : ansi.dim;
    const title = truncate(sanitizeTerminalText(item.title), Math.max(1, Math.floor(width * 0.55)));
    const detailWidth = Math.max(0, width - cellWidth(title) - 3);
    const detail = detailWidth > 0 ? ` ${truncate(sanitizeTerminalText(item.detail), detailWidth)}` : "";
    return `${color}· ${title}${detail}${ansi.reset}`;
  });
}

function approvalLines(state: TuiState, width: number): string[] {
  const pending = state.view.approvals.filter((item) => item.status === "pending");
  return pending.map((item, index) => {
    const detail = `${sanitizeTerminalText(item.toolName)}: ${sanitizeTerminalText(item.reason)} [${item.requestId}]`;
    return `${ansi.yellow}approval ${index + 1}/${pending.length}${ansi.reset} ${truncate(detail, Math.max(1, width - 13))}`;
  });
}

function composerLine(state: TuiState, width: number): string {
  const approval = state.view.approvals.some((item) => item.status === "pending");
  const label = approval ? "approve [y/n/a]" : ">";
  const maximum = Math.max(1, width - label.length - 1);
  let start = 0;
  while (start < state.composer.cursor && cellWidth(state.composer.graphemes.slice(start, state.composer.cursor + 1).join("")) > maximum) start += 1;
  const visible: string[] = [];
  for (const raw of state.composer.graphemes.slice(start)) {
    const item = sanitizeTerminalText(raw).replace(/\n/gu, " ");
    if (cellWidth(`${visible.join("")}${item}`) > maximum) break;
    visible.push(item);
  }
  const cursorIndex = state.composer.cursor - start;
  if (cursorIndex >= visible.length && cellWidth(visible.join("")) < maximum) visible.push(" ");
  const withCursor = visible.map((item, index) => index === cursorIndex ? `${ansi.inverse}${item}${ansi.reset}` : item).join("");
  return `${approval ? ansi.yellow : ansi.cyan}${label}${ansi.reset} ${withCursor}`;
}

export function renderFrame(state: TuiState, options: { width: number; height: number }): string {
  const width = Math.max(10, options.width);
  const height = Math.max(4, options.height);
  const statusText = `sigma  ${state.view.status}  ${state.mode}  ${state.sessionId?.slice(0, 8) ?? "new"}`;
  const status = `${ansi.dim}${truncate(sanitizeTerminalText(statusText), width)}${ansi.reset}`;
  const notice = state.notice ? `${ansi.yellow}${truncate(sanitizeTerminalText(state.notice), width)}${ansi.reset}` : "";
  const approvalBudget = Math.max(0, height - 3 - (notice ? 1 : 0));
  const approvals = approvalLines(state, width).slice(0, approvalBudget);
  const available = Math.max(0, height - 2 - approvals.length - (notice ? 1 : 0));
  const activity = state.activityCollapsed ? [] : activityLines(state.view, width);
  const allLines = [...transcriptLines(state.view, width, Math.max(1, available + state.scrollOffset + 16)), ...activity];
  const maximumScroll = Math.max(0, allLines.length - available);
  const end = allLines.length - Math.min(state.scrollOffset, maximumScroll);
  const visible = allLines.slice(Math.max(0, end - available), end);
  while (visible.length < available) visible.unshift("");
  const rows = [status, ...visible, ...approvals, ...(notice ? [notice] : []), composerLine(state, width)];
  return `${ansi.clear}${rows.map((line) => `${line}\u001b[K`).join("\n")}`;
}
