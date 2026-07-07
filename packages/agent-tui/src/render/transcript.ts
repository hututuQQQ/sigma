import { redactSecretText } from "agent-core";
import type { TranscriptEntry } from "../view-model.js";
import { oneLine } from "../components/formatting.js";
import { fitStreamLine, muted, roleColor, streamGlyphs } from "./theme.js";
import { truncateToWidth, wrapText } from "../ui/theme.js";

function labelFor(entry: TranscriptEntry): string {
  if (entry.kind === "system") return "system";
  if (entry.kind === "user") return "user";
  if (entry.kind === "assistant") return "assistant";
  if (entry.kind === "tool") return "tool";
  if (entry.kind === "approval") return "approval";
  if (entry.kind === "diff") return "diff";
  if (entry.kind === "test") return "test";
  return "summary";
}

function statusMarker(status: "running" | "ok" | "failed" | undefined, color: boolean): string {
  const g = streamGlyphs();
  if (status === "running") return roleColor("warning", g.running, color);
  if (status === "ok") return roleColor("success", g.ok, color);
  if (status === "failed") return roleColor("danger", g.fail, color);
  return "";
}

function labelColor(entry: TranscriptEntry, label: string, color: boolean): string {
  if (entry.kind === "user") return roleColor("accent", label, color);
  if (entry.kind === "approval") return roleColor("warning", label, color);
  if (entry.kind === "tool" && entry.status === "failed") return roleColor("danger", label, color);
  if (entry.kind === "test" && entry.status === "failed") return roleColor("danger", label, color);
  return muted(label, color);
}

function entryText(entry: TranscriptEntry, width: number, color: boolean): string[] {
  const g = streamGlyphs();
  if (entry.kind === "tool") {
    const duration = typeof entry.durationMs === "number" ? `${entry.durationMs}ms` : "";
    const status = statusMarker(entry.status, color);
    return [[status, entry.name, entry.summary, duration].filter(Boolean).join("  ")];
  }
  if (entry.kind === "test") {
    const duration = typeof entry.durationMs === "number" ? `${entry.durationMs}ms` : "";
    const status = statusMarker(entry.status, color);
    return [[status, truncateToWidth(oneLine(redactSecretText(entry.command)), Math.max(10, width - 18)), entry.summary, duration].filter(Boolean).join("  ")];
  }
  if (entry.kind === "approval") {
    return [[roleColor("warning", "required", color), entry.toolName, entry.risk, entry.summary].filter(Boolean).join("  ")];
  }
  if (entry.kind === "diff") {
    return [`${entry.mode} ${g.separator} ${entry.summary}`];
  }
  if (entry.kind === "assistant") {
    return wrapText(redactSecretText(entry.text), width);
  }
  if (entry.kind === "summary") {
    const status = entry.status ? `${entry.status} ${g.separator} ` : "";
    return wrapText(`${status}${redactSecretText(entry.text)}`, width);
  }
  return wrapText(redactSecretText(entry.text), width);
}

export function renderTranscript(entries: TranscriptEntry[], width: number, height: number, color = false): string {
  const labelWidth = width < 72 ? 7 : 9;
  const bodyWidth = Math.max(10, width - labelWidth - 2);
  const lines: string[] = [];

  for (const entry of entries) {
    const label = labelFor(entry);
    const body = entryText(entry, bodyWidth, color);
    const coloredLabel = labelColor(entry, label.padEnd(labelWidth), color);
    if (entry.kind === "assistant" || entry.kind === "user") {
      lines.push(fitStreamLine(`${coloredLabel} ${body[0] ?? ""}`, width));
      for (const continuation of body.slice(1)) {
        lines.push(fitStreamLine(`${" ".repeat(labelWidth)}  ${continuation}`, width));
      }
      lines.push("");
      continue;
    }
    lines.push(fitStreamLine(`${coloredLabel} ${body[0] ?? ""}`, width));
    for (const continuation of body.slice(1)) {
      lines.push(fitStreamLine(`${" ".repeat(labelWidth)}  ${continuation}`, width));
    }
  }

  const compact = lines.filter((line, index) => !(line === "" && lines[index - 1] === ""));
  const visible = compact.slice(Math.max(0, compact.length - Math.max(1, height)));
  return visible.map((line) => fitStreamLine(line, width)).join("\n");
}
