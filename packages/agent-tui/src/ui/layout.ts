import { padRight, truncateToWidth, visibleWidth } from "./theme.js";

export function splitLines(value: string): string[] {
  return value.length === 0 ? [] : value.split(/\r?\n/);
}

export function lineCount(value: string): number {
  return splitLines(value).length;
}

export function fitLine(value: string, width: number): string {
  return padRight(truncateToWidth(value, width), width);
}

export function assertWithinWidth(value: string, width: number): boolean {
  return splitLines(value).every((line) => visibleWidth(line) <= width);
}

export function joinColumns(left: string, right: string, gap: number, width: number): string {
  const leftLines = splitLines(left);
  const rightLines = splitLines(right);
  const leftWidth = leftLines.reduce((max, line) => Math.max(max, visibleWidth(line)), 0);
  const rightWidth = rightLines.reduce((max, line) => Math.max(max, visibleWidth(line)), 0);
  const safeGap = Math.max(1, gap);
  const total = leftWidth + safeGap + rightWidth;
  if (total > width) return [left, right].filter(Boolean).join("\n");

  const rows = Math.max(leftLines.length, rightLines.length);
  const output: string[] = [];
  for (let index = 0; index < rows; index += 1) {
    output.push(`${fitLine(leftLines[index] ?? "", leftWidth)}${" ".repeat(safeGap)}${fitLine(rightLines[index] ?? "", rightWidth)}`);
  }
  return output.join("\n");
}

export interface CockpitMainOptions {
  timeline: string;
  focus: string;
  width: number;
  height: number;
  minColumnsWidth?: number;
}

export function renderMainArea(options: CockpitMainOptions): string {
  const width = Math.max(40, options.width);
  const minColumnsWidth = options.minColumnsWidth ?? 96;
  if (width < minColumnsWidth) return [options.timeline, options.focus].join("\n");
  return joinColumns(options.timeline, options.focus, 2, width);
}
