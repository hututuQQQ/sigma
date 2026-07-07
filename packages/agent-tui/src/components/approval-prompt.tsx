import { redactSecretText, type PermissionRequest } from "agent-core";
import { box } from "../ui/box.js";
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

export function ApprovalPrompt(request: PermissionRequest | null, options: ApprovalPromptOptions = {}): string {
  if (!request) return "";
  const g = glyphs();
  const width = options.width ?? 80;
  const innerWidth = Math.max(20, width - 4);
  const args = toolArgsObject(request.arguments);
  const summary = summarizeToolArguments(request.toolName, request.arguments);
  const paths = affectedPaths(args);
  const command = commandLine(args);
  const mutates = ["write", "edit", "apply_patch"].includes(request.toolName);
  const lines = [
    "The run is paused for a permission decision.",
    "keys: y allow once  |  n deny  |  a always allow this tool/session",
    "",
    `tool: ${request.toolName}`,
    `risk: ${request.risk}`,
    `workspace: ${redactSecretText(request.workspacePath)}`,
    `reason: ${truncateToWidth(oneLine(redactSecretText(request.reason)), innerWidth)}`
  ];

  if (command) {
    lines.push("command:");
    lines.push(...wrapText(command, innerWidth).map((line) => `  ${line}`));
  }
  if (paths.length > 0) {
    lines.push(`paths: ${truncateToWidth(paths.join(", "), innerWidth - 7)}`);
  }
  if (mutates) lines.push("warning: this request mutates files in the workspace");
  lines.push(`arguments: ${truncateToWidth(summary || safeJson(request.arguments), innerWidth - 11)}`);

  return box({
    title: `${g.sigma} Approval`,
    width,
    height: options.height,
    variant: "danger",
    color: options.color,
    lines
  });
}
