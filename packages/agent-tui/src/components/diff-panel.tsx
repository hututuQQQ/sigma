import { redactSecretText, type AgentRunResult } from "agent-core";
import { box } from "../ui/box.js";
import { accent, danger, glyphs, success, truncateToWidth } from "../ui/theme.js";

export type DiffMode = "stat" | "patch";

export function parseDiffMode(value: string): DiffMode | null {
  const normalized = value.trim();
  if (!normalized || normalized === "stat") return "stat";
  if (normalized === "patch") return "patch";
  return null;
}

function changedLines(changed: string[], width: number): string[] {
  if (changed.length === 0) return ["changed files: unknown"];
  const maxShown = 8;
  const shown = changed.slice(0, maxShown).join(", ");
  const suffix = changed.length > maxShown ? `, ... +${changed.length - maxShown}` : "";
  return [truncateToWidth(`changed files: ${shown}${suffix}`, width)];
}

function formatPatchLine(line: string, colorEnabled: boolean): string {
  if (line.startsWith("@@")) return accent(line, colorEnabled);
  if (line.startsWith("+++") || line.startsWith("---")) return accent(line, colorEnabled);
  if (line.startsWith("+")) return success(line, colorEnabled);
  if (line.startsWith("-")) return danger(line, colorEnabled);
  if (line.startsWith("diff --git")) return accent(line, colorEnabled);
  return line;
}

function formatDiffBody(diffText: string, mode: DiffMode, width: number, maxLines: number, colorEnabled: boolean): string[] {
  const raw = redactSecretText(diffText).trim();
  if (!raw) return ["No diff available."];
  const lines = raw.split(/\r?\n/);
  const clipped = lines.slice(0, maxLines);
  const formatted = clipped.map((line) => {
    const body = truncateToWidth(line, width);
    return mode === "patch" ? formatPatchLine(body, colorEnabled) : body;
  });
  if (lines.length > clipped.length) {
    formatted.push(`${glyphs().ellipsis} ${lines.length - clipped.length} diff lines truncated`);
  }
  return formatted;
}

export function DiffPanel(
  result: AgentRunResult | null,
  diffText: string,
  mode: DiffMode = "stat",
  width = 80,
  height?: number,
  color = false
): string {
  const g = glyphs();
  const innerWidth = Math.max(20, width - 4);
  const bodyMax = Math.max(4, (height ?? 28) - 8);
  const changed = result?.changedFiles ?? [];
  const lines = [
    `mode: ${mode}`,
    ...changedLines(changed, innerWidth),
    "",
    ...formatDiffBody(diffText, mode, innerWidth, bodyMax, color)
  ];
  return box({
    title: `${g.sigma} Diff`,
    width,
    height,
    color,
    lines
  });
}
