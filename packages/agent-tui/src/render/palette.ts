import type { FileMentionSuggestion } from "../file-mentions.js";
import { renderCommandPalette } from "../components/commands.js";
import { fitStreamLine, muted, roleColor, separatorLine, streamGlyphs } from "./theme.js";
import { truncateToWidth, visibleWidth } from "../ui/theme.js";

export function renderCommandPaletteOverlay(buffer: string, width: number, maxRows: number, color = false): string {
  const lines = renderCommandPalette(buffer, width, maxRows, color);
  return lines.map((line) => fitStreamLine(line, width)).join("\n");
}

export function renderFileMentionPalette(
  prefix: string,
  suggestions: FileMentionSuggestion[],
  width: number,
  maxRows = 8,
  color = false,
  selectedPaths: Iterable<string> = []
): string {
  const g = streamGlyphs();
  const selected = [...selectedPaths];
  const lines = [roleColor("accent", `files @${prefix}`, color)];
  if (suggestions.length === 0) {
    lines.push("  no matching files");
  } else {
    for (const [index, suggestion] of suggestions.slice(0, maxRows).entries()) {
      const marker = index === 0 ? roleColor("brand", g.pointer, color) : " ";
      const prefixText = `${marker} `;
      lines.push(`${prefixText}${truncateToWidth(suggestion.path, Math.max(8, width - visibleWidth(prefixText)))}`);
    }
  }
  if (selected.length > 0) {
    lines.push(muted(`  selected: ${selected.map((item) => `@${item}`).join(" ")}`, color));
  }
  lines.push(muted("  Space selects, Tab/Enter inserts", color));
  return lines.map((line) => fitStreamLine(line, width)).join("\n");
}

export function renderFocusOverlay(title: string, lines: string[], width: number, height: number, color = false): string {
  const output = [
    separatorLine(width),
    roleColor("accent", title, color),
    ...lines.slice(0, Math.max(0, height - 3))
  ];
  return output.map((line) => fitStreamLine(line, width)).join("\n");
}
