import { redactSecretText } from "agent-core";
import type { TranscriptEntry } from "../view-model.js";
import { oneLine } from "../components/formatting.js";
import { fitStreamLine, muted, roleColor, streamGlyphs } from "./theme.js";
import { truncateToWidth, wrapText } from "../ui/theme.js";

function statusMarker(status: "running" | "ok" | "failed" | undefined, color: boolean): string {
  const g = streamGlyphs();
  if (status === "running") return roleColor("warning", g.running, color);
  if (status === "ok") return roleColor("success", g.ok, color);
  if (status === "failed") return roleColor("danger", g.fail, color);
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
  if (entry.kind === "diff") {
    return [joinParts([entry.mode, entry.summary])];
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
  if (text.startsWith(g.sigma) || text.startsWith("Try:") || text.startsWith("  ")) return [text];
  return [`${muted(g.info, color)} ${text}`];
}

export function renderTranscript(entries: TranscriptEntry[], width: number, height: number, color = false): string {
  const lines: string[] = [];

  for (const entry of entries) {
    const body = entryLines(entry, width, color);
    lines.push(...body.map((line) => fitStreamLine(line, width)));
    if (entry.kind === "assistant" || entry.kind === "user" || (entry.kind === "summary" && entry.status === "error")) lines.push("");
  }

  const compact = lines.filter((line, index) => !(line === "" && lines[index - 1] === ""));
  const visible = compact.slice(Math.max(0, compact.length - Math.max(1, height)));
  return visible.map((line) => fitStreamLine(line, width)).join("\n");
}
