export type ColorRole =
  | "accent"
  | "danger"
  | "dim"
  | "info"
  | "muted"
  | "success"
  | "warning";

const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

const ROLE_CODES: Record<ColorRole, [string, string]> = {
  accent: ["\x1b[36m", "\x1b[0m"],
  danger: ["\x1b[31m", "\x1b[0m"],
  dim: ["\x1b[2m", "\x1b[0m"],
  info: ["\x1b[34m", "\x1b[0m"],
  muted: ["\x1b[90m", "\x1b[0m"],
  success: ["\x1b[32m", "\x1b[0m"],
  warning: ["\x1b[33m", "\x1b[0m"]
};

export interface Glyphs {
  sigma: string;
  separator: string;
  pointer: string;
  ellipsis: string;
  ok: string;
  fail: string;
  running: string;
  blocked: string;
  info: string;
  topLeft: string;
  topRight: string;
  bottomLeft: string;
  bottomRight: string;
  horizontal: string;
  vertical: string;
}

export function supportsColor(stream: NodeJS.WriteStream = process.stdout): boolean {
  return Boolean(stream.isTTY) && !process.env.NO_COLOR && process.env.TERM !== "dumb";
}

export function supportsUnicode(): boolean {
  if (process.env.SIGMA_ASCII === "1" || process.env.TERM === "dumb") return false;
  if (process.platform !== "win32") return true;
  return Boolean(process.env.WT_SESSION || process.env.TERMINAL_EMULATOR || process.env.ConEmuANSI === "ON");
}

export function glyphs(): Glyphs {
  if (!supportsUnicode()) {
    return {
      sigma: "S",
      separator: "|",
      pointer: ">",
      ellipsis: "...",
      ok: "ok",
      fail: "x",
      running: "*",
      blocked: "!",
      info: "i",
      topLeft: "+",
      topRight: "+",
      bottomLeft: "+",
      bottomRight: "+",
      horizontal: "-",
      vertical: "|"
    };
  }
  return {
    sigma: "∑",
    separator: "·",
    pointer: "›",
    ellipsis: "…",
    ok: "✓",
    fail: "✕",
    running: "◌",
    blocked: "!",
    info: "•",
    topLeft: "╭",
    topRight: "╮",
    bottomLeft: "╰",
    bottomRight: "╯",
    horizontal: "─",
    vertical: "│"
  };
}

export function color(text: string, role: ColorRole, enabled = supportsColor()): string {
  if (!enabled || text.length === 0) return text;
  const [open, close] = ROLE_CODES[role];
  return `${open}${text}${close}`;
}

export function bold(text: string, enabled = supportsColor()): string {
  return enabled && text.length > 0 ? `\x1b[1m${text}\x1b[0m` : text;
}

export function dim(text: string, enabled = supportsColor()): string {
  return color(text, "dim", enabled);
}

export function danger(text: string, enabled = supportsColor()): string {
  return color(text, "danger", enabled);
}

export function success(text: string, enabled = supportsColor()): string {
  return color(text, "success", enabled);
}

export function accent(text: string, enabled = supportsColor()): string {
  return color(text, "accent", enabled);
}

export function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, "");
}

function isCombining(codePoint: number): boolean {
  return (codePoint >= 0x0300 && codePoint <= 0x036f)
    || (codePoint >= 0x1ab0 && codePoint <= 0x1aff)
    || (codePoint >= 0x1dc0 && codePoint <= 0x1dff)
    || (codePoint >= 0x20d0 && codePoint <= 0x20ff)
    || (codePoint >= 0xfe20 && codePoint <= 0xfe2f);
}

function isWide(codePoint: number): boolean {
  return (codePoint >= 0x1100 && codePoint <= 0x115f)
    || codePoint === 0x2329
    || codePoint === 0x232a
    || (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f)
    || (codePoint >= 0xac00 && codePoint <= 0xd7a3)
    || (codePoint >= 0xf900 && codePoint <= 0xfaff)
    || (codePoint >= 0xfe10 && codePoint <= 0xfe19)
    || (codePoint >= 0xfe30 && codePoint <= 0xfe6f)
    || (codePoint >= 0xff00 && codePoint <= 0xff60)
    || (codePoint >= 0xffe0 && codePoint <= 0xffe6);
}

export function charWidth(char: string): number {
  const codePoint = char.codePointAt(0) ?? 0;
  if (codePoint === 0 || codePoint < 32 || (codePoint >= 0x7f && codePoint < 0xa0)) return 0;
  if (isCombining(codePoint)) return 0;
  return isWide(codePoint) ? 2 : 1;
}

export function visibleWidth(value: string): number {
  let width = 0;
  for (const char of stripAnsi(value)) width += charWidth(char);
  return width;
}

export function sliceVisible(value: string, maxWidth: number): string {
  const plain = stripAnsi(value);
  if (maxWidth <= 0) return "";
  let width = 0;
  let output = "";
  for (const char of plain) {
    const next = charWidth(char);
    if (width + next > maxWidth) break;
    output += char;
    width += next;
  }
  return output;
}

export function truncateToWidth(value: string, maxWidth: number, marker = glyphs().ellipsis): string {
  const plain = stripAnsi(value).replace(/\s+$/g, "");
  if (visibleWidth(plain) <= maxWidth) return plain;
  if (maxWidth <= visibleWidth(marker)) return sliceVisible(marker, maxWidth);
  return `${sliceVisible(plain, maxWidth - visibleWidth(marker))}${marker}`;
}

export function padRight(value: string, width: number): string {
  const current = visibleWidth(value);
  if (current >= width) return truncateToWidth(value, width);
  return `${value}${" ".repeat(width - current)}`;
}

export function wrapText(value: string, width: number): string[] {
  if (width <= 0) return [""];
  const lines: string[] = [];
  for (const rawLine of stripAnsi(value).split(/\r?\n/)) {
    const words = rawLine.trimEnd().split(/(\s+)/).filter((part) => part.length > 0);
    let current = "";
    for (const word of words) {
      const candidate = current.length === 0 ? word.trimStart() : `${current}${word}`;
      if (visibleWidth(candidate) <= width) {
        current = candidate;
        continue;
      }
      if (current.trim().length > 0) lines.push(current.trimEnd());
      let rest = word.trim();
      while (visibleWidth(rest) > width) {
        const chunk = sliceVisible(rest, width);
        lines.push(chunk);
        rest = rest.slice(chunk.length);
      }
      current = rest;
    }
    lines.push(current.trimEnd());
  }
  return lines.length > 0 ? lines : [""];
}
