import {
  accent,
  color,
  danger,
  dim,
  glyphs,
  success,
  supportsColor,
  supportsUnicode,
  truncateToWidth,
  visibleWidth
} from "../ui/theme.js";

export type StreamGlyphs = ReturnType<typeof glyphs> & {
  cursor: string;
  prompt: string;
};

export function streamGlyphs(): StreamGlyphs {
  const base = glyphs();
  if (!supportsUnicode()) {
    return { ...base, cursor: "|", prompt: ">" };
  }
  return { ...base, cursor: "\u258c", prompt: "\u203a" };
}

export function streamColorEnabled(stream: NodeJS.WriteStream = process.stdout): boolean {
  return supportsColor(stream);
}

export function muted(text: string, enabled: boolean): string {
  return color(text, "muted", enabled);
}

export function warning(text: string, enabled: boolean): string {
  return color(text, "warning", enabled);
}

export function roleColor(role: "brand" | "accent" | "danger" | "dim" | "info" | "success" | "warning", text: string, enabled: boolean): string {
  if (role === "brand") return color(text, "brand", enabled);
  if (role === "accent") return accent(text, enabled);
  if (role === "danger") return danger(text, enabled);
  if (role === "info") return color(text, "info", enabled);
  if (role === "success") return success(text, enabled);
  if (role === "warning") return warning(text, enabled);
  return dim(text, enabled);
}

export function separatorLine(width: number): string {
  const g = streamGlyphs();
  const char = supportsUnicode() ? g.horizontal : "-";
  return char.repeat(Math.max(0, width));
}

export function fitStreamLine(line: string, width: number): string {
  return visibleWidth(line) <= width ? line : truncateToWidth(line, width);
}

export function rightPadVisible(line: string, width: number): string {
  const clipped = fitStreamLine(line, width);
  const remaining = width - visibleWidth(clipped);
  return remaining > 0 ? `${clipped}${" ".repeat(remaining)}` : clipped;
}
