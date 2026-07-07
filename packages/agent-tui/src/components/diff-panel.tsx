import { redactSecretText, type AgentRunResult } from "agent-core";
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

export function renderDiffLines(
  result: AgentRunResult | null,
  diffText: string,
  mode: DiffMode = "stat",
  width = 80,
  maxLines = 20,
  color = false
): string[] {
  const raw = redactSecretText(diffText).trim();
  const body = raw ? raw.split(/\r?\n/) : ["No diff available."];
  const clipped = body.slice(0, Math.max(1, maxLines - 4));
  const formatted = clipped.map((line) => {
    const bodyLine = truncateToWidth(line, width);
    return mode === "patch" ? formatPatchLine(bodyLine, color) : bodyLine;
  });
  if (body.length > clipped.length) formatted.push(`${glyphs().ellipsis} ${body.length - clipped.length} diff lines truncated`);
  return [
    `mode: ${mode}`,
    ...changedLines(result?.changedFiles ?? [], width),
    "",
    ...formatted
  ];
}

export function DiffPanel(
  result: AgentRunResult | null,
  diffText: string,
  mode: DiffMode = "stat",
  width = 80,
  height?: number,
  color = false
): string {
  return renderDiffLines(result, diffText, mode, width, height ?? 24, color).join("\n");
}
