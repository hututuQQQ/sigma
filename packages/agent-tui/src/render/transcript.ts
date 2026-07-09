import { redactSecretText } from "agent-core";
import type { ActivityStatus, TranscriptEntry } from "../view-model.js";
import { oneLine } from "../components/formatting.js";
import { fitStreamLine, muted, roleColor, streamGlyphs } from "./theme.js";
import { rgb, truncateToWidth, wrapText } from "../ui/theme.js";

function statusMarker(status: ActivityStatus | "ok" | "failed" | "aborted" | undefined, color: boolean): string {
  const g = streamGlyphs();
  if (status === "queued") return muted(g.info, color);
  if (status === "running") return roleColor("warning", g.running, color);
  if (status === "ok") return roleColor("success", g.ok, color);
  if (status === "failed") return roleColor("danger", g.fail, color);
  if (status === "aborted") return roleColor("warning", g.fail, color);
  if (status === "waiting") return roleColor("warning", g.info, color);
  if (status === "info") return muted(g.info, color);
  return "";
}

function joinParts(parts: Array<string | undefined>): string {
  const g = streamGlyphs();
  return parts.filter((part): part is string => Boolean(part)).join(` ${g.separator} `);
}

function missingApiKeyName(text: string): string | null {
  const normalized = text.toLowerCase();
  if (text.includes("DEEPSEEK_API_KEY") || /deepseek.*api key.*missing|deepseek api key is missing/.test(normalized)) {
    return "DEEPSEEK_API_KEY";
  }
  if (
    text.includes("ZAI_API_KEY")
    || text.includes("GLM_API_KEY")
    || text.includes("BIGMODEL_API_KEY")
    || /(?:glm|zai|zhipu|bigmodel).*api key.*missing/.test(normalized)
  ) {
    return "ZAI_API_KEY";
  }
  return null;
}

function missingApiKeyCard(keyName: string, color: boolean): string[] {
  const g = streamGlyphs();
  const alternate = keyName === "DEEPSEEK_API_KEY" ? "glm" : "deepseek";
  return [
    `${roleColor("danger", g.fail, color)} Missing ${keyName}`,
    `  Set it with: $env:${keyName}='...' on PowerShell`,
    `  Or switch provider: /provider ${alternate}`,
    "  Run /status or agent doctor --check-api"
  ];
}

function wrapIndented(text: string, width: number, indent = "  "): string[] {
  return wrapText(text, Math.max(10, width - indent.length)).map((line) => `${indent}${line}`);
}

const ICON_COLUMN_WIDTH = 18;
const ICON_TILE: [number, number, number] = [63, 65, 66];
const ICON_SIGMA: [number, number, number] = [84, 198, 190];
const TITLE_SIGMA: [number, number, number] = [84, 198, 190];

function colorWelcomeIcon(value: string, color: boolean): string {
  return Array.from(value).map((char) => {
    if (char === "\u25a3" || char === "[" || char === "]") {
      return rgb(char, ICON_TILE, color);
    }
    if (char === "\u2211" || char === "S" || char === "\u2588") return rgb(char, ICON_SIGMA, color);
    return char;
  }).join("");
}

function colorBrandTitle(value: string, color: boolean): string {
  const sigmaIndex = value.indexOf("\u2211");
  if (sigmaIndex >= 0) {
    return `${value.slice(0, sigmaIndex)}${rgb("\u2211", TITLE_SIGMA, color)}${value.slice(sigmaIndex + 1)}`;
  }
  const asciiIndex = value.indexOf("S Sigma");
  if (asciiIndex >= 0) {
    return `${value.slice(0, asciiIndex)}${rgb("S", TITLE_SIGMA, color)}${value.slice(asciiIndex + 1)}`;
  }
  return value;
}

function isWelcomeLine(text: string): boolean {
  return text.includes("Sigma Code")
    || text.includes("\u2588")
    || /^\s*(?:S{2,}|SS)/.test(text);
}

function welcomeLine(line: string, color: boolean): string {
  if (!color) return line;
  const logo = line.slice(0, ICON_COLUMN_WIDTH);
  const rest = line.slice(ICON_COLUMN_WIDTH);
  return `${colorWelcomeIcon(logo, color)}${colorBrandTitle(rest, color)}`;
}

function systemLines(text: string, width: number, color: boolean): string[] {
  const g = streamGlyphs();
  const lines = text.split(/\r?\n/);
  if (text.trim().length === 0) return [""];
  if (isWelcomeLine(text)) {
    return lines.map((line) => welcomeLine(line, color));
  }
  if (
    text.startsWith(g.sigma)
    || text.startsWith(g.topLeft)
    || text.startsWith(g.vertical)
    || text.startsWith(g.bottomLeft)
    || text.startsWith("  ")
  ) return lines;
  const [first = "", ...rest] = lines;
  return [
    `${muted(g.info, color)} ${truncateToWidth(first, Math.max(1, width - 2))}`,
    ...rest.map((line) => `  ${truncateToWidth(line.trimEnd(), Math.max(1, width - 2))}`)
  ];
}

function entryLines(entry: TranscriptEntry, width: number, color: boolean): string[] {
  const g = streamGlyphs();
  if (entry.kind === "tool") {
    const duration = typeof entry.durationMs === "number" ? `${entry.durationMs}ms` : "";
    const status = statusMarker(entry.status, color);
    return [joinParts([status, entry.name, entry.summary, duration])];
  }
  if (entry.kind === "test") {
    const duration = typeof entry.durationMs === "number" ? `${entry.durationMs}ms` : "";
    const status = statusMarker(entry.status, color);
    return [joinParts([status, truncateToWidth(oneLine(redactSecretText(entry.command)), Math.max(10, width - 16)), entry.summary, duration])];
  }
  if (entry.kind === "approval") {
    return [joinParts([roleColor("warning", "approval", color), entry.toolName, entry.risk, entry.summary])];
  }
  if (entry.kind === "subagent") {
    return [joinParts([statusMarker(entry.status, color), "subagent", entry.label, entry.detail])];
  }
  if (entry.kind === "diff") {
    return [joinParts([entry.mode, entry.summary])];
  }
  if (entry.kind === "changes") {
    const maxShown = 8;
    const files = entry.files.slice(0, maxShown);
    const lines = [
      `${statusMarker("ok", color)} Changed ${entry.files.length} file${entry.files.length === 1 ? "" : "s"}`,
      ...files.map((file) => `  ${truncateToWidth(redactSecretText(file), Math.max(10, width - 2))}`)
    ];
    if (entry.files.length > files.length) lines.push(`  ${g.ellipsis} ${entry.files.length - files.length} more`);
    lines.push("");
    lines.push("Next: run tests?  [enter] yes  [esc] no  [d] diff");
    return lines.map((line) => truncateToWidth(line, width));
  }
  if (entry.kind === "assistant") {
    return wrapIndented(redactSecretText(entry.text), width);
  }
  if (entry.kind === "summary") {
    const text = redactSecretText(entry.text);
    if (entry.status === "error") {
      const keyName = missingApiKeyName(text);
      if (keyName) return missingApiKeyCard(keyName, color);
      return [`${roleColor("danger", g.fail, color)} ${truncateToWidth(text, width - 2)}`];
    }
    const marker = entry.status === "completed" ? statusMarker("ok", color) : entry.status === "failed" ? statusMarker("failed", color) : g.info;
    return [joinParts([marker, redactSecretText(entry.text)])];
  }
  if (entry.kind === "user") {
    const lines = wrapText(redactSecretText(entry.text), Math.max(10, width - 2));
    return lines.map((line, index) => index === 0 ? `${g.pointer} ${line}` : `  ${line}`);
  }
  const text = redactSecretText(entry.text);
  return systemLines(text, width, color);
}

export function renderTranscript(entries: TranscriptEntry[], width: number, height: number, color = false, scrollOffset = 0): string {
  const lines: string[] = [];

  for (const entry of entries) {
    const body = entryLines(entry, width, color);
    lines.push(...body.map((line) => fitStreamLine(line, width)));
    if (entry.kind === "assistant" || entry.kind === "user" || (entry.kind === "summary" && entry.status === "error")) lines.push("");
  }

  const compact = lines.filter((line, index) => !(line === "" && lines[index - 1] === ""));
  const safeHeight = Math.max(1, height);
  const maxOffset = Math.max(0, compact.length - safeHeight);
  const offset = Math.max(0, Math.min(maxOffset, Math.floor(scrollOffset)));
  const start = Math.max(0, compact.length - safeHeight - offset);
  const visible = compact.slice(start, start + safeHeight);
  return visible.map((line) => fitStreamLine(line, width)).join("\n");
}
