import { createHash } from "node:crypto";
import { redactSecretText } from "./redaction.js";

export interface TruncationResult {
  text: string;
  truncated: boolean;
}

export function truncateMiddle(text: string, maxChars: number): TruncationResult {
  if (maxChars <= 0) {
    return { text: "", truncated: text.length > 0 };
  }

  if (text.length <= maxChars) {
    return { text, truncated: false };
  }

  const marker = "\n...[truncated]...\n";
  if (maxChars <= marker.length + 2) {
    return { text: text.slice(0, maxChars), truncated: true };
  }

  const remaining = maxChars - marker.length;
  const headChars = Math.ceil(remaining / 2);
  const tailChars = Math.floor(remaining / 2);
  return {
    text: `${text.slice(0, headChars)}${marker}${text.slice(text.length - tailChars)}`,
    truncated: true
  };
}

function sha256Prefix(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function lineCount(text: string): number {
  return text.length === 0 ? 0 : text.split(/\r?\n/).length;
}

function looksLikeHeredoc(text: string): boolean {
  return /<<\s*[-]?['"]?[A-Za-z0-9_./-]+['"]?/.test(text);
}

export function compactLargeText(
  text: string,
  options: {
    label?: string;
    maxChars?: number;
  } = {}
): TruncationResult {
  const maxChars = Math.max(1, Math.floor(options.maxChars ?? 4000));
  if (text.length <= maxChars) return { text, truncated: false };
  const safeText = redactSecretText(text);

  const label = options.label ?? "text";
  const details = [
    `${label} compacted`,
    `chars=${text.length}`,
    `lines=${lineCount(text)}`,
    `sha256=${sha256Prefix(safeText)}`,
    ...(looksLikeHeredoc(safeText) ? ["heredoc=true"] : [])
  ].join(" ");
  const header = `[${details}]`;
  const previewBudget = Math.max(1, maxChars - header.length - 1);
  const preview = truncateMiddle(safeText, previewBudget).text;
  return {
    text: `${header}\n${preview}`,
    truncated: true
  };
}

export function compactLargeCommand(command: string, maxChars = 4000): TruncationResult {
  return compactLargeText(command, { label: "large command", maxChars });
}
