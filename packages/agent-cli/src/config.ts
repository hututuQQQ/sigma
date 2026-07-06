import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProviderName } from "agent-ai";
import type { PermissionMode } from "agent-core";

export interface ParsedArgs {
  flags: Record<string, string | boolean>;
  positionals: string[];
}

export interface CliConfig {
  workspace: string;
  provider: ProviderName;
  model?: string;
  maxTurns: number;
  maxWallTimeSec: number;
  commandTimeoutSec: number;
  permissionMode: PermissionMode;
  traceJsonl?: string;
  summaryJson?: string;
  sessionJsonl?: string;
  maxToolOutputChars: number;
  noStreamUi: boolean;
}

const DEFAULTS = {
  maxTurns: 20,
  maxWallTimeSec: 900,
  commandTimeoutSec: 60,
  permissionMode: "ask" as PermissionMode,
  maxToolOutputChars: 12000
};

export function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }

    const withoutPrefix = arg.slice(2);
    const equalsIndex = withoutPrefix.indexOf("=");
    if (equalsIndex !== -1) {
      flags[withoutPrefix.slice(0, equalsIndex)] = withoutPrefix.slice(equalsIndex + 1);
      continue;
    }

    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      flags[withoutPrefix] = next;
      index += 1;
    } else {
      flags[withoutPrefix] = true;
    }
  }

  return { flags, positionals };
}

function parseTomlScalar(raw: string): string | number | boolean {
  const trimmed = raw.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  const quoted = trimmed.match(/^["'](.*)["']$/);
  return quoted ? quoted[1] : trimmed;
}

function loadSimpleToml(filePath: string): Record<string, string | number | boolean> {
  if (!existsSync(filePath)) return {};
  const result: Record<string, string | number | boolean> = {};
  const lines = readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const withoutComment = line.replace(/#.*$/, "").trim();
    if (!withoutComment || withoutComment.startsWith("[")) continue;
    const match = withoutComment.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/);
    if (match) {
      result[match[1]] = parseTomlScalar(match[2]);
    }
  }
  return result;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function boolValue(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value === "true") return true;
    if (value === "false") return false;
  }
  return fallback;
}

function providerValue(value: unknown): ProviderName {
  if (value === "deepseek" || value === "glm") return value;
  throw new Error(`Unsupported provider '${String(value)}'. Use deepseek or glm.`);
}

function permissionModeValue(value: unknown): PermissionMode {
  if (value === "ask" || value === "yolo") return value;
  throw new Error(`Unsupported permission mode '${String(value)}'. Use ask or yolo.`);
}

export function loadCliConfig(flags: Record<string, string | boolean>): CliConfig {
  const cwdConfig = loadSimpleToml(path.join(process.cwd(), ".agent", "config.toml"));
  const homeConfig = loadSimpleToml(path.join(os.homedir(), ".agent", "config.toml"));
  const config = { ...homeConfig, ...cwdConfig };

  const workspace =
    stringValue(flags.workspace) ??
    process.env.AGENT_WORKSPACE ??
    stringValue(config.workspace) ??
    process.cwd();
  const provider = providerValue(
    stringValue(flags.provider) ?? process.env.AGENT_PROVIDER ?? stringValue(config.provider) ?? "deepseek"
  );
  const model = stringValue(flags.model) ?? process.env.AGENT_MODEL ?? stringValue(config.model);
  const traceJsonl =
    stringValue(flags["trace-jsonl"]) ??
    process.env.AGENT_TRACE_JSONL ??
    stringValue(config.trace_jsonl) ??
    path.join(workspace, ".agent", "trace.jsonl");
  const summaryJson =
    stringValue(flags["summary-json"]) ??
    process.env.AGENT_SUMMARY_JSON ??
    stringValue(config.summary_json) ??
    path.join(workspace, ".agent", "summary.json");
  const sessionJsonl =
    stringValue(flags["session-jsonl"]) ??
    process.env.AGENT_SESSION_JSONL ??
    stringValue(config.session_jsonl) ??
    path.join(workspace, ".agent", "session.jsonl");

  return {
    workspace,
    provider,
    model,
    maxTurns: numberValue(flags["max-turns"] ?? process.env.AGENT_MAX_TURNS ?? config.max_turns, DEFAULTS.maxTurns),
    maxWallTimeSec: numberValue(
      flags["max-wall-time-sec"] ?? process.env.AGENT_MAX_WALL_TIME_SEC ?? config.max_wall_time_sec,
      DEFAULTS.maxWallTimeSec
    ),
    commandTimeoutSec: numberValue(
      flags["command-timeout-sec"] ?? process.env.AGENT_COMMAND_TIMEOUT_SEC ?? config.command_timeout_sec,
      DEFAULTS.commandTimeoutSec
    ),
    permissionMode: permissionModeValue(
      stringValue(flags["permission-mode"]) ??
        process.env.AGENT_PERMISSION_MODE ??
        stringValue(config.permission_mode) ??
        DEFAULTS.permissionMode
    ),
    traceJsonl,
    summaryJson,
    sessionJsonl,
    maxToolOutputChars: numberValue(
      flags["max-tool-output-chars"] ?? process.env.AGENT_MAX_TOOL_OUTPUT_CHARS ?? config.max_tool_output_chars,
      DEFAULTS.maxToolOutputChars
    ),
    noStreamUi: boolValue(flags["no-stream-ui"], false)
  };
}
