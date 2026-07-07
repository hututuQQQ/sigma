import type { FileMentionSuggestion } from "../file-mentions.js";
import { renderCommandPalette } from "../components/commands.js";
import { fitStreamLine, muted, separatorLine, streamGlyphs } from "./theme.js";
import { truncateToWidth } from "../ui/theme.js";

export function renderCommandPaletteOverlay(buffer: string, width: number, maxRows: number, color = false): string {
  const lines = renderCommandPalette(buffer, width, maxRows);
  return lines.map((line) => fitStreamLine(line, width)).join("\n");
}

export function renderFileMentionPalette(prefix: string, suggestions: FileMentionSuggestion[], width: number, maxRows = 8, color = false): string {
  const g = streamGlyphs();
  const lines = [`files @${prefix}`];
  if (suggestions.length === 0) {
    lines.push("  no matching files");
  } else {
    for (const suggestion of suggestions.slice(0, maxRows)) {
      lines.push(`  ${g.pointer} ${truncateToWidth(suggestion.path, Math.max(8, width - 4))}`);
    }
  }
  lines.push(muted("  tab/enter inserts the top match", color));
  return lines.map((line) => fitStreamLine(line, width)).join("\n");
}

export function renderFocusOverlay(title: string, lines: string[], width: number, height: number, color = false): string {
  const output = [
    separatorLine(width),
    title,
    ...lines.slice(0, Math.max(0, height - 3))
  ];
  return output.map((line) => fitStreamLine(line, width)).join("\n");
}
