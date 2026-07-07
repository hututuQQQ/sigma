import { redactSecretText, type PermissionRequest } from "agent-core";
import { glyphs, truncateToWidth, wrapText } from "../ui/theme.js";
import { oneLine, summarizeToolArguments, toolArgsObject } from "./formatting.js";

export interface ApprovalPromptOptions {
  width?: number;
  height?: number;
  color?: boolean;
}

function safeJson(value: unknown): string {
  try {
    return redactSecretText(JSON.stringify(value));
  } catch {
    return redactSecretText(String(value));
  }
}

function stringList(value: unknown): string[] {
  if (typeof value === "string") return [redactSecretText(value)];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string").map((item) => redactSecretText(item));
  return [];
}

function affectedPaths(args: Record<string, unknown> | null): string[] {
  if (!args) return [];
  return [
    ...stringList(args.path),
    ...stringList(args.file),
    ...stringList(args.files),
    ...stringList(args.expectedFiles)
  ];
}

function commandLine(args: Record<string, unknown> | null): string | null {
  if (!args) return null;
  const command = typeof args.command === "string" ? args.command : typeof args.input === "string" ? args.input : null;
  return command ? oneLine(redactSecretText(command)) : null;
}

export function approvalPromptLines(request: PermissionRequest | null, width = 80): string[] {
  if (!request) return [];
  const g = glyphs();
  const innerWidth = Math.max(20, width);
  const args = toolArgsObject(request.arguments);
  const summary = summarizeToolArguments(request.toolName, request.arguments);
  const paths = affectedPaths(args);
  const command = commandLine(args);
  const mutates = ["write", "edit", "apply_patch"].includes(request.toolName);
  const lines = [
    `${request.toolName}  ${request.risk}  ${request.reason}`,
    `workspace: ${redactSecretText(request.workspacePath)}`
  ];

  if (command) {
    lines.push("command:");
    lines.push(...wrapText(command, innerWidth).map((line) => `  ${line}`));
  }
  if (paths.length > 0) lines.push(`paths: ${truncateToWidth(paths.join(", "), innerWidth - 7)}`);
  if (mutates) lines.push("risk: mutates files in the workspace");
  lines.push(`args: ${truncateToWidth(summary || safeJson(request.arguments), innerWidth - 6)}`);
  lines.push(`[y] allow once   [a] always allow ${request.toolName} this session   [n] deny   [e] edit command   [esc] deny`);
  if (mutates) lines.push(`${g.blocked} review paths before allowing writes`);
  return lines;
}

export function ApprovalPrompt(request: PermissionRequest | null, options: ApprovalPromptOptions = {}): string {
  const width = options.width ?? 80;
  return approvalPromptLines(request, Math.max(20, width)).slice(0, options.height).join("\n");
}
