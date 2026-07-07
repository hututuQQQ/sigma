import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProviderName } from "agent-ai";
import type {
  AgentFinalEvidenceMode,
  AgentHarnessValidationMode,
  AgentSkillsMode,
  ContextMode,
  PermissionMode
} from "agent-core";

export interface ParsedArgs {
  flags: Record<string, string | boolean>;
  positionals: string[];
}

export interface CliConfig {
  workspace: string;
  provider: ProviderName;
  model?: string;
  outputFormat: CliOutputFormat;
  quiet: boolean;
  maxTurns: number;
  maxWallTimeSec: number;
  commandTimeoutSec: number;
  permissionMode: PermissionMode;
  traceJsonl?: string;
  summaryJson?: string;
  sessionJsonl?: string;
  maxToolOutputChars: number;
  maxMessageHistoryChars?: number;
  messageHistoryRetain: number;
  compactionSummaryChars: number;
  validationMode: AgentHarnessValidationMode;
  validationCommands: string[];
  validationRetryLimit: number;
  validationTimeoutSec?: number;
  precheckCommand?: string;
  precheckTimeoutSec?: number;
  postRunCleanupGlobs: string[];
  harnessTimeoutSec?: number;
  retryMinBudgetSec?: number;
  attemptsDir?: string;
  allowedTools: string[];
  disabledTools: string[];
  noProjectInstructions: boolean;
  projectDocMaxBytes: number;
  contextMode: ContextMode;
  repoMapMaxChars: number;
  finalEvidenceMode: AgentFinalEvidenceMode;
  skillsMode: AgentSkillsMode;
  skillsMaxChars: number;
  enableMcp: boolean;
  mcpConfig?: string;
  noStreamUi: boolean;
}

export type CliOutputFormat = "text" | "json" | "stream-json";

const DEFAULTS = {
  maxTurns: 20,
  maxWallTimeSec: 900,
  commandTimeoutSec: 60,
  permissionMode: "ask" as PermissionMode,
  maxToolOutputChars: 12000,
  messageHistoryRetain: 24,
  compactionSummaryChars: 30000,
  projectDocMaxBytes: 32768,
  contextMode: "repo-map" as ContextMode,
  repoMapMaxChars: 20000,
  skillsMaxChars: 8000
};

const BOOLEAN_FLAGS = new Set([
  "enable-mcp",
  "json",
  "no-project-instructions",
  "no-stream-ui",
  "quiet",
  "stream-ui"
]);

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

    if (BOOLEAN_FLAGS.has(withoutPrefix)) {
      flags[withoutPrefix] = true;
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

function validationModeValue(value: unknown): AgentHarnessValidationMode {
  if (value === "off" || value === "auto") return value;
  throw new Error(`Unsupported validation mode '${String(value)}'. Use off or auto.`);
}

function outputFormatValue(value: unknown): CliOutputFormat {
  if (value === "text" || value === "json" || value === "stream-json") return value;
  throw new Error(`Unsupported output format '${String(value)}'. Use text, json, or stream-json.`);
}

function finalEvidenceModeValue(value: unknown): AgentFinalEvidenceMode {
  if (value === "off" || value === "auto") return value;
  throw new Error(`Unsupported final evidence mode '${String(value)}'. Use off or auto.`);
}

function skillsModeValue(value: unknown): AgentSkillsMode {
  if (value === "off" || value === "auto") return value;
  throw new Error(`Unsupported skills mode '${String(value)}'. Use off or auto.`);
}

function contextModeValue(value: unknown): ContextMode {
  if (value === "off" || value === "repo-map") return value;
  throw new Error(`Unsupported context mode '${String(value)}'. Use off or repo-map.`);
}

function stringListValue(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function validationCommandList(options: { singleValues: unknown[]; listValues: unknown[] }): string[] {
  const seen = new Set<string>();
  const items: string[] = [];
  const add = (values: string[]) => {
    for (const item of values.map((value) => value.trim()).filter(Boolean)) {
      if (seen.has(item)) continue;
      seen.add(item);
      items.push(item);
    }
  };
  for (const value of options.singleValues) {
    if (typeof value === "string") add([value]);
  }
  for (const value of options.listValues) {
    add(stringListValue(value));
  }
  return items;
}

function optionalNumberValue(value: unknown): number | undefined {
  if (value === undefined || value === null || value === true || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
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
  const outputFormat = flags.json !== undefined
    ? "json"
    : outputFormatValue(
        stringValue(flags["output-format"]) ??
          process.env.AGENT_OUTPUT_FORMAT ??
          stringValue(config.output_format) ??
          "text"
      );
  const quiet = boolValue(flags.quiet ?? process.env.AGENT_QUIET ?? config.quiet, false);
  const configuredNoStreamUi = boolValue(process.env.AGENT_NO_STREAM_UI ?? config.no_stream_ui, false);
  const configuredStreamUi =
    flags["stream-ui"] !== undefined
      ? true
      : flags["no-stream-ui"] !== undefined
        ? false
        : outputFormat !== "text" || quiet
          ? false
          : boolValue(process.env.AGENT_STREAM_UI ?? config.stream_ui, !configuredNoStreamUi);
  const validationMode = validationModeValue(
    stringValue(flags["validation-mode"]) ??
      process.env.AGENT_VALIDATION_MODE ??
      stringValue(config.validation_mode) ??
      "off"
  );

  return {
    workspace,
    provider,
    model,
    outputFormat,
    quiet,
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
    maxMessageHistoryChars:
      flags["max-message-history-chars"] !== undefined ||
      process.env.AGENT_MAX_MESSAGE_HISTORY_CHARS !== undefined ||
      config.max_message_history_chars !== undefined
        ? numberValue(
            flags["max-message-history-chars"] ??
              process.env.AGENT_MAX_MESSAGE_HISTORY_CHARS ??
              config.max_message_history_chars,
            0
          )
        : undefined,
    messageHistoryRetain: numberValue(
      flags["message-history-retain"] ?? process.env.AGENT_MESSAGE_HISTORY_RETAIN ?? config.message_history_retain,
      DEFAULTS.messageHistoryRetain
    ),
    compactionSummaryChars: numberValue(
      flags["compaction-summary-chars"] ??
        process.env.AGENT_COMPACTION_SUMMARY_CHARS ??
        config.compaction_summary_chars,
      DEFAULTS.compactionSummaryChars
    ),
    validationMode,
    validationCommands: validationCommandList({
      singleValues: [flags["validation-command"], process.env.AGENT_VALIDATION_COMMAND, config.validation_command],
      listValues: [flags["validation-commands"], process.env.AGENT_VALIDATION_COMMANDS, config.validation_command_list]
    }),
    validationRetryLimit: Math.max(
      0,
      Math.floor(
        numberValue(
          flags["validation-retry-limit"] ??
            process.env.AGENT_VALIDATION_RETRY_LIMIT ??
            config.validation_retry_limit,
          0
        )
      )
    ),
    validationTimeoutSec: optionalNumberValue(
      flags["validation-timeout-sec"] ?? process.env.AGENT_VALIDATION_TIMEOUT_SEC ?? config.validation_timeout_sec
    ),
    precheckCommand:
      stringValue(flags["precheck-command"]) ??
      process.env.AGENT_PRECHECK_COMMAND ??
      stringValue(config.precheck_command),
    precheckTimeoutSec: optionalNumberValue(
      flags["precheck-timeout-sec"] ?? process.env.AGENT_PRECHECK_TIMEOUT_SEC ?? config.precheck_timeout_sec
    ),
    postRunCleanupGlobs: stringListValue(
      flags["post-run-cleanup-globs"] ??
        process.env.AGENT_POST_RUN_CLEANUP_GLOBS ??
        config.post_run_cleanup_globs
    ),
    harnessTimeoutSec: optionalNumberValue(
      flags["harness-timeout-sec"] ?? process.env.AGENT_HARNESS_TIMEOUT_SEC ?? config.harness_timeout_sec
    ),
    retryMinBudgetSec: optionalNumberValue(
      flags["retry-min-budget-sec"] ?? process.env.AGENT_RETRY_MIN_BUDGET_SEC ?? config.retry_min_budget_sec
    ),
    attemptsDir:
      stringValue(flags["attempts-dir"]) ??
      process.env.AGENT_ATTEMPTS_DIR ??
      stringValue(config.attempts_dir),
    allowedTools: stringListValue(flags["allowed-tools"] ?? process.env.AGENT_ALLOWED_TOOLS ?? config.allowed_tools),
    disabledTools: stringListValue(flags["disabled-tools"] ?? process.env.AGENT_DISABLED_TOOLS ?? config.disabled_tools),
    noProjectInstructions: boolValue(
      flags["no-project-instructions"] ?? process.env.AGENT_NO_PROJECT_INSTRUCTIONS ?? config.no_project_instructions,
      false
    ),
    projectDocMaxBytes: numberValue(
      flags["project-doc-max-bytes"] ?? process.env.AGENT_PROJECT_DOC_MAX_BYTES ?? config.project_doc_max_bytes,
      DEFAULTS.projectDocMaxBytes
    ),
    contextMode: contextModeValue(
      stringValue(flags["context-mode"]) ??
        process.env.AGENT_CONTEXT_MODE ??
        stringValue(config.context_mode) ??
        DEFAULTS.contextMode
    ),
    repoMapMaxChars: numberValue(
      flags["repo-map-max-chars"] ?? process.env.AGENT_REPO_MAP_MAX_CHARS ?? config.repo_map_max_chars,
      DEFAULTS.repoMapMaxChars
    ),
    finalEvidenceMode: finalEvidenceModeValue(
      stringValue(flags["final-evidence-mode"]) ??
        process.env.AGENT_FINAL_EVIDENCE_MODE ??
        stringValue(config.final_evidence_mode) ??
        (validationMode === "auto" ? "auto" : "off")
    ),
    skillsMode: skillsModeValue(
      stringValue(flags["skills-mode"]) ??
        process.env.AGENT_SKILLS_MODE ??
        stringValue(config.skills_mode) ??
        "auto"
    ),
    skillsMaxChars: numberValue(
      flags["skills-max-chars"] ?? process.env.AGENT_SKILLS_MAX_CHARS ?? config.skills_max_chars,
      DEFAULTS.skillsMaxChars
    ),
    enableMcp: boolValue(flags["enable-mcp"] ?? process.env.AGENT_ENABLE_MCP ?? config.enable_mcp, false),
    mcpConfig:
      stringValue(flags["mcp-config"]) ??
      process.env.AGENT_MCP_CONFIG ??
      stringValue(config.mcp_config),
    noStreamUi: !configuredStreamUi
  };
}
