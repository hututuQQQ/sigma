import { truncateMiddle } from "../compaction.js";
import type { EvidenceKind, EvidenceRecord, ToolResult } from "../types.js";

function textArg(args: unknown, key: string): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const value = (args as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function numberMetadata(result: ToolResult, key: string): number | null | undefined {
  const value = result.metadata?.[key];
  if (typeof value === "number") return value;
  if (value === null) return null;
  return undefined;
}

export function evidenceKindForCommand(command: string): EvidenceKind {
  const normalized = command.toLowerCase();
  if (/\b(pytest|go test|cargo test|mvn test|gradle test|npm test|pnpm test|yarn test|bun test|vitest|jest|mocha)\b/.test(normalized)) {
    return "test";
  }
  if (/\b(tsc|typecheck|type-check|check:types)\b/.test(normalized)) return "typecheck";
  if (/\b(eslint|lint|ruff|flake8)\b/.test(normalized)) return "lint";
  if (/\b(build|compile)\b/.test(normalized)) return "build";
  if (/\b(check|verify|validate)\b/.test(normalized)) return "unknown";
  return "unknown";
}

export function commandLooksExecutableVerification(command: string): boolean {
  const normalized = command.toLowerCase();
  return /\b(test|build|lint|check|verify|validate|pytest|go test|cargo test|mvn test|gradle test|tsc)\b/.test(normalized);
}

function summarizeResult(result: ToolResult): string {
  return truncateMiddle(result.content.replace(/\s+/g, " ").trim(), 300).text;
}

export function inferEvidenceRecord(options: {
  toolName: string;
  args: unknown;
  result: ToolResult;
  timestamp?: string;
}): EvidenceRecord | null {
  if (!options.result.ok) return null;
  const timestamp = options.timestamp ?? new Date().toISOString();
  if (options.toolName === "bash") {
    const command = textArg(options.args, "command") ?? "";
    if (!commandLooksExecutableVerification(command)) return null;
    return {
      kind: evidenceKindForCommand(command),
      toolName: options.toolName,
      ok: true,
      executable: true,
      command,
      exitCode: numberMetadata(options.result, "exitCode"),
      summary: summarizeResult(options.result),
      timestamp
    };
  }

  if (options.toolName === "shell_session") {
    const command = textArg(options.args, "input") ?? "";
    if (!commandLooksExecutableVerification(command)) return null;
    return {
      kind: evidenceKindForCommand(command),
      toolName: options.toolName,
      ok: true,
      executable: true,
      command,
      exitCode: numberMetadata(options.result, "exitCode"),
      summary: summarizeResult(options.result),
      timestamp
    };
  }

  if (options.toolName === "service") {
    const action = textArg(options.args, "action");
    if (action !== "start" && action !== "status" && action !== "logs") return null;
    return {
      kind: "service",
      toolName: options.toolName,
      ok: true,
      executable: true,
      command: textArg(options.args, "command"),
      summary: summarizeResult(options.result),
      timestamp
    };
  }

  if (options.toolName === "read" || options.toolName === "list" || options.toolName === "grep" || options.toolName === "repo_query") {
    return {
      kind: "file-check",
      toolName: options.toolName,
      ok: true,
      executable: false,
      relatedFiles: textArg(options.args, "path") ? [textArg(options.args, "path") as string] : undefined,
      summary: summarizeResult(options.result),
      timestamp
    };
  }

  if (options.toolName === "git_diff" || options.toolName === "git_status") {
    return {
      kind: "manual-check",
      toolName: options.toolName,
      ok: true,
      executable: false,
      relatedFiles: textArg(options.args, "path") ? [textArg(options.args, "path") as string] : undefined,
      summary: summarizeResult(options.result),
      timestamp
    };
  }

  if (options.toolName === "validate") {
    const command = typeof options.result.metadata?.command === "string" ? options.result.metadata.command : undefined;
    return {
      kind: command ? evidenceKindForCommand(command) : "unknown",
      toolName: options.toolName,
      ok: true,
      executable: true,
      command,
      relatedFiles: Array.isArray(options.result.metadata?.relatedFiles)
        ? options.result.metadata.relatedFiles.filter((item): item is string => typeof item === "string")
        : undefined,
      exitCode: numberMetadata(options.result, "exitCode"),
      summary: summarizeResult(options.result),
      timestamp
    };
  }

  return null;
}
