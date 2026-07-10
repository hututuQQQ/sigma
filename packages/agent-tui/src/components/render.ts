import type { PresentationState } from "agent-presentation";
import { cellWidth, graphemeCellWidth, graphemes } from "./composer.js";
import type { TuiState } from "./state.js";

const ansi = {
  reset: "\u001b[0m", dim: "\u001b[2m", cyan: "\u001b[38;5;81m", green: "\u001b[38;5;114m",
  yellow: "\u001b[38;5;221m", red: "\u001b[38;5;203m", inverse: "\u001b[7m", clear: "\u001b[2J\u001b[H"
};
const wrappedRows = new WeakMap<object, Map<string, string[]>>();
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
  const result: string[] = [];
  const widths: number[] = [];
  let used = 0;
  for (const item of graphemes(value)) {
    const itemWidth = graphemeCellWidth(item);
    if (used + itemWidth > width) {
      if (width === 1) return "…";
      while (used > width - 1 && result.length > 0) {
        used -= widths.pop() ?? 0;
        result.pop();
      }
      return `${result.join("")}…`;
    }
    result.push(item);
    widths.push(itemWidth);
    used += itemWidth;
  }
  return result.join("");
}

function wrap(value: string, width: number): string[] {
  if (width <= 1) return [truncate(value, Math.max(1, width))];
  const lines: string[] = [];
  for (const source of value.split("\n")) {
    let current = "";
    let currentWidth = 0;
    for (const item of graphemes(source)) {
      const itemWidth = graphemeCellWidth(item);
      if (currentWidth + itemWidth > width) {
        lines.push(current);
        current = item;
        currentWidth = itemWidth;
      } else {
        current += item;
        currentWidth += itemWidth;
      }
    }
    lines.push(current);
  }
  return lines.length > 0 ? lines : [""];
}

function wrapTail(value: string, width: number, maximumRows: number): string[] {
  const maximumCharacters = Math.max(4_096, width * Math.max(1, maximumRows) * 4);
  const clipped = value.length > maximumCharacters ? value.slice(-maximumCharacters) : value;
  const rows = wrap(clipped, width);
  return rows.length > maximumRows ? rows.slice(-maximumRows) : rows;
}

function transcriptLines(view: PresentationState, width: number, rowLimit: number): string[] {
  const lines: string[] = [];
  for (let index = view.transcript.length - 1; index >= 0 && lines.length < rowLimit; index -= 1) {
    const item = view.transcript[index];
    const name = item.role === "user" ? "you" : item.role === "system" ? "error" : "sigma";
    const color = item.role === "user" ? ansi.cyan : item.role === "system" ? ansi.red : ansi.green;
    const bodyWidth = Math.max(1, width - name.length - 1);
    const remainingRows = Math.max(1, rowLimit - lines.length);
    const cacheKey = `${bodyWidth}:${remainingRows}`;
    let byWidth = wrappedRows.get(item);
    if (!byWidth) {
      byWidth = new Map();
      wrappedRows.set(item, byWidth);
    }
    let body = byWidth.get(cacheKey);
    if (!body) {
      body = wrapTail(sanitizeTerminalText(item.text), bodyWidth, remainingRows);
      if (byWidth.size >= 8) byWidth.clear();
      byWidth.set(cacheKey, body);
    }
    lines.unshift(`${color}${name}${ansi.reset} ${body[0] ?? ""}`, ...body.slice(1).map((line) => `${" ".repeat(name.length + 1)}${line}`));
  }
  return lines.slice(-rowLimit);
}

function boundedWrap(value: string, width: number, maximumRows: number): string[] {
  const rows = wrap(value, width);
  if (rows.length <= maximumRows) return rows;
  const leading = Math.ceil((maximumRows - 1) * 0.6);
  const trailing = maximumRows - leading - 1;
  return [...rows.slice(0, leading), truncate("…", width), ...rows.slice(-trailing)];
}

function activityItemLines(item: PresentationState["activity"][number], width: number): string[] {
  const color = item.status === "failed" ? ansi.red : item.status === "running" ? ansi.yellow : ansi.dim;
  const title = sanitizeTerminalText(item.title);
  const detail = sanitizeTerminalText(item.detail);
  if (item.status !== "failed" && item.kind !== "diagnostic") {
    const shortTitle = truncate(title, Math.max(1, Math.floor(width * 0.55)));
    const detailWidth = Math.max(0, width - cellWidth(shortTitle) - 3);
    const shortDetail = detailWidth > 0 ? ` ${truncate(detail, detailWidth)}` : "";
    return [`${color}· ${shortTitle}${shortDetail}${ansi.reset}`];
  }
  const body = detail ? `${title}: ${detail}` : title;
  return boundedWrap(body, Math.max(1, width - 2), 6)
    .map((row) => `${color}· ${row}${ansi.reset}`);
}

function activityLines(view: PresentationState, width: number): string[] {
  return view.activity.slice(-8).flatMap((item) => activityItemLines(item, width));
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
  const cursorCell = state.composer.cursor < state.composer.graphemes.length
    ? cellWidth(state.composer.graphemes[state.composer.cursor]) : 1;
  let start = state.composer.cursor;
  let beforeWidth = 0;
  while (start > 0) {
    const previousWidth = cellWidth(state.composer.graphemes[start - 1]);
    if (beforeWidth + previousWidth + cursorCell > maximum) break;
    beforeWidth += previousWidth;
    start -= 1;
  }
  const visible: string[] = [];
  let visibleWidth = 0;
  for (const raw of state.composer.graphemes.slice(start)) {
    const item = sanitizeTerminalText(raw).replace(/\n/gu, " ");
    const itemWidth = cellWidth(item);
    if (visibleWidth + itemWidth > maximum) break;
    visible.push(item);
    visibleWidth += itemWidth;
  }
  const cursorIndex = state.composer.cursor - start;
  if (cursorIndex >= visible.length && visibleWidth < maximum) visible.push(" ");
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
  const transcriptBudget = Math.min(5_000, Math.max(1, available + state.scrollOffset + 16));
  const allLines = [...transcriptLines(state.view, width, transcriptBudget), ...activity];
  const maximumScroll = Math.max(0, allLines.length - available);
  const end = allLines.length - Math.min(state.scrollOffset, maximumScroll);
  const visible = allLines.slice(Math.max(0, end - available), end);
  while (visible.length < available) visible.unshift("");
  const rows = [status, ...visible, ...approvals, ...(notice ? [notice] : []), composerLine(state, width)];
  return `${ansi.clear}${rows.map((line) => `${line}\u001b[K`).join("\n")}`;
}
