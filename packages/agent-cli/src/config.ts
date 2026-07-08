import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import type { ProviderName } from "agent-ai";
import type {
  AgentFinalEvidenceMode,
  AgentHarnessValidationMode,
  AgentSkillsMode,
  CompactionFallbackMode,
  CompactionMode,
  ContextMode,
  PermissionMode,
  SandboxBackend,
  SandboxConfig,
  SandboxMode,
  SandboxNetworkMode
} from "agent-core";
import {
  DEFAULT_COMPACTION_MODE,
  DEFAULT_FINAL_EVIDENCE_MODE,
  DEFAULT_MAX_MESSAGE_HISTORY_CHARS,
  DEFAULT_SUBAGENTS_ENABLED,
  DEFAULT_VALIDATION_MODE,
  createDefaultSandboxConfig
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
  maxMessageHistoryChars: number;
  messageHistoryRetain: number;
  compactionSummaryChars: number;
  compactionMode: CompactionMode;
  compactionModel?: string;
  compactionProvider?: ProviderName;
  compactionMaxInputChars?: number;
  compactionMaxOutputChars?: number;
  compactionTimeoutSec: number;
  compactionFallback: CompactionFallbackMode;
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
  subagentsEnabled: boolean;
  subagentMaxTurns?: number;
  subagentMaxOutputChars?: number;
  reviewAntiGaming: boolean;
  sandbox: SandboxConfig;
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
  maxMessageHistoryChars: DEFAULT_MAX_MESSAGE_HISTORY_CHARS,
  messageHistoryRetain: 24,
  compactionSummaryChars: 30000,
  compactionMode: DEFAULT_COMPACTION_MODE,
  compactionTimeoutSec: 60,
  compactionFallback: "deterministic" as CompactionFallbackMode,
  projectDocMaxBytes: 32768,
  contextMode: "repo-map" as ContextMode,
  repoMapMaxChars: 20000,
  skillsMaxChars: 8000,
  validationMode: DEFAULT_VALIDATION_MODE,
  finalEvidenceMode: DEFAULT_FINAL_EVIDENCE_MODE,
  subagentsEnabled: DEFAULT_SUBAGENTS_ENABLED,
  subagentMaxTurns: 4,
  subagentMaxOutputChars: 12000,
  reviewAntiGaming: true
};

const BOOLEAN_FLAGS = new Set([
  "enable-mcp",
  "json",
  "no-review-anti-gaming",
  "no-project-instructions",
  "no-stream-ui",
  "no-subagents",
  "quiet",
  "review-anti-gaming",
  "sandbox-required",
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

type ConfigValues = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function flattenConfig(parsed: unknown): ConfigValues {
  if (!isRecord(parsed)) return {};
  const result: ConfigValues = {};
  const addSection = (section: string, mapping: Record<string, string>) => {
    const value = parsed[section];
    if (!isRecord(value)) return;
    for (const [key, configKey] of Object.entries(mapping)) {
      if (value[key] !== undefined) result[configKey] = value[key];
    }
  };

  addSection("run", {
    workspace: "workspace",
    provider: "provider",
    model: "model",
    max_turns: "max_turns",
    max_wall_time_sec: "max_wall_time_sec",
    command_timeout_sec: "command_timeout_sec",
    run_controller_timeout_sec: "run_controller_timeout_sec",
    permission_mode: "permission_mode",
    output_format: "output_format",
    quiet: "quiet"
  });
  addSection("validation", {
    mode: "validation_mode",
    command: "validation_command",
    commands: "validation_command_list",
    retry_limit: "validation_retry_limit",
    timeout_sec: "validation_timeout_sec",
    final_evidence_mode: "final_evidence_mode"
  });
  addSection("precheck", {
    command: "precheck_command",
    timeout_sec: "precheck_timeout_sec"
  });
  addSection("cleanup", {
    globs: "post_run_cleanup_globs"
  });
  addSection("tools", {
    allowed: "allowed_tools",
    disabled: "disabled_tools"
  });
  addSection("context", {
    mode: "context_mode",
    repo_map_max_chars: "repo_map_max_chars",
    project_doc_max_bytes: "project_doc_max_bytes",
    no_project_instructions: "no_project_instructions",
    max_message_history_chars: "max_message_history_chars",
    message_history_retain: "message_history_retain",
    compaction_summary_chars: "compaction_summary_chars",
    compaction_mode: "compaction_mode",
    compaction_model: "compaction_model",
    compaction_provider: "compaction_provider",
    compaction_max_input_chars: "compaction_max_input_chars",
    compaction_max_output_chars: "compaction_max_output_chars",
    compaction_timeout_sec: "compaction_timeout_sec",
    compaction_fallback: "compaction_fallback"
  });
  addSection("skills", {
    mode: "skills_mode",
    max_chars: "skills_max_chars"
  });
  addSection("subagents", {
    enabled: "subagents_enabled",
    max_turns: "subagent_max_turns",
    max_output_chars: "subagent_max_output_chars"
  });
  addSection("review", {
    anti_gaming: "review_anti_gaming"
  });
  addSection("sandbox", {
    mode: "sandbox_mode",
    backend: "sandbox_backend",
    required: "sandbox_required",
    external_command: "sandbox_external_command",
    external_args: "sandbox_external_args"
  });
  const sandbox = parsed.sandbox;
  if (isRecord(sandbox)) {
    const network = sandbox.network;
    if (isRecord(network)) {
      if (network.mode !== undefined) result.sandbox_network_mode = network.mode;
      if (network.allowed_hosts !== undefined) result.sandbox_network_allowed_hosts = network.allowed_hosts;
      if (network.denied_hosts !== undefined) result.sandbox_network_denied_hosts = network.denied_hosts;
      if (network.allow_localhost !== undefined) result.sandbox_network_allow_localhost = network.allow_localhost;
    }
    const filesystem = sandbox.filesystem;
    if (isRecord(filesystem)) {
      if (filesystem.read_roots !== undefined) result.sandbox_read_roots = filesystem.read_roots;
      if (filesystem.write_roots !== undefined) result.sandbox_write_roots = filesystem.write_roots;
      if (filesystem.deny_read !== undefined) result.sandbox_deny_read = filesystem.deny_read;
      if (filesystem.deny_write !== undefined) result.sandbox_deny_write = filesystem.deny_write;
      if (filesystem.temp_root !== undefined) result.sandbox_temp_root = filesystem.temp_root;
    }
  }
  addSection("mcp", {
    enabled: "enable_mcp",
    config: "mcp_config"
  });
  addSection("tui", {
    stream_ui: "stream_ui",
    no_stream_ui: "no_stream_ui"
  });
  addSection("paths", {
    trace_jsonl: "trace_jsonl",
    summary_json: "summary_json",
    session_jsonl: "session_jsonl",
    attempts_dir: "attempts_dir"
  });
  return result;
}

function loadTomlConfig(filePath: string): ConfigValues {
  if (!existsSync(filePath)) return {};
  try {
    return flattenConfig(parseToml(readFileSync(filePath, "utf8")));
  } catch (error) {
    throw new Error(`Failed to parse TOML config ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
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

function optionalProviderValue(value: unknown): ProviderName | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return providerValue(value);
}

function permissionModeValue(value: unknown): PermissionMode {
  if (value === "ask" || value === "yolo") return value;
  throw new Error(`Unsupported permission mode '${String(value)}'. Use ask or yolo.`);
}

function sandboxModeValue(value: unknown): SandboxMode {
  if (
    value === "read-only" ||
    value === "workspace-write" ||
    value === "danger-full-access" ||
    value === "policy-only" ||
    value === "policy_only" ||
    value === "external" ||
    value === "disabled"
  ) {
    return value;
  }
  if (value === "read_only") return "read-only";
  if (value === "workspace_write") return "workspace-write";
  throw new Error(`Unsupported sandbox mode '${String(value)}'. Use read-only, workspace-write, danger-full-access, policy-only, external, or disabled.`);
}

function sandboxBackendValue(value: unknown): SandboxBackend {
  if (
    value === "auto" ||
    value === "bubblewrap" ||
    value === "seatbelt" ||
    value === "windows" ||
    value === "external" ||
    value === "policy-only" ||
    value === "policy_only"
  ) {
    return value;
  }
  throw new Error(`Unsupported sandbox backend '${String(value)}'. Use auto, bubblewrap, seatbelt, windows, external, or policy-only.`);
}

function sandboxNetworkModeValue(value: unknown): SandboxNetworkMode {
  if (value === "default" || value === "restricted" || value === "disabled") return value;
  throw new Error(`Unsupported sandbox network mode '${String(value)}'. Use default, restricted, or disabled.`);
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

function compactionModeValue(value: unknown): CompactionMode {
  if (value === "off" || value === "deterministic") return value;
  if (value === "model_sub_session" || value === "model-sub-session") return "model_sub_session";
  throw new Error(`Unsupported compaction mode '${String(value)}'. Use off, deterministic, or model-sub-session.`);
}

function compactionFallbackValue(value: unknown): CompactionFallbackMode {
  if (value === "deterministic" || value === "fail") return value;
  throw new Error(`Unsupported compaction fallback '${String(value)}'. Use deterministic or fail.`);
}

function stringListValue(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
  }
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

function optionalStringList(value: unknown): string[] | undefined {
  const list = stringListValue(value);
  return list.length > 0 ? list : undefined;
}

function sandboxConfigFromValues(
  flags: Record<string, string | boolean>,
  config: ConfigValues
): SandboxConfig {
  const defaults = createDefaultSandboxConfig();
  const modeValue =
    stringValue(flags.sandbox) ??
    process.env.AGENT_SANDBOX ??
    stringValue(config.sandbox_mode);
  const backendValue =
    stringValue(flags["sandbox-backend"]) ??
    process.env.AGENT_SANDBOX_BACKEND ??
    stringValue(config.sandbox_backend);
  const networkModeValue =
    stringValue(flags["sandbox-network"]) ??
    process.env.AGENT_SANDBOX_NETWORK ??
    stringValue(config.sandbox_network_mode);
  const externalCommand =
    stringValue(flags["sandbox-external-command"]) ??
    process.env.AGENT_SANDBOX_EXTERNAL_COMMAND ??
    stringValue(config.sandbox_external_command);

  const sandbox: SandboxConfig = {
    mode: modeValue ? sandboxModeValue(modeValue) : defaults.mode,
    backend: backendValue ? sandboxBackendValue(backendValue) : defaults.backend,
    required: boolValue(
      flags["sandbox-required"] ?? process.env.AGENT_SANDBOX_REQUIRED ?? config.sandbox_required,
      defaults.required ?? false
    ),
    network: {
      mode: networkModeValue ? sandboxNetworkModeValue(networkModeValue) : "restricted",
      allowedHosts: optionalStringList(
        flags["sandbox-allowed-hosts"] ??
          process.env.AGENT_SANDBOX_ALLOWED_HOSTS ??
          config.sandbox_network_allowed_hosts
      ),
      deniedHosts: optionalStringList(
        flags["sandbox-denied-hosts"] ??
          process.env.AGENT_SANDBOX_DENIED_HOSTS ??
          config.sandbox_network_denied_hosts
      ),
      allowLocalhost: boolValue(
        flags["sandbox-allow-localhost"] ??
          process.env.AGENT_SANDBOX_ALLOW_LOCALHOST ??
          config.sandbox_network_allow_localhost,
        true
      )
    },
    filesystem: {
      readRoots: optionalStringList(
        flags["sandbox-add-read"] ??
          process.env.AGENT_SANDBOX_ADD_READ ??
          config.sandbox_read_roots
      ),
      writeRoots: optionalStringList(
        flags["sandbox-add-write"] ??
          process.env.AGENT_SANDBOX_ADD_WRITE ??
          config.sandbox_write_roots
      ),
      denyRead: optionalStringList(
        flags["sandbox-deny-read"] ??
          process.env.AGENT_SANDBOX_DENY_READ ??
          config.sandbox_deny_read
      ),
      denyWrite: optionalStringList(
        flags["sandbox-deny-write"] ??
          process.env.AGENT_SANDBOX_DENY_WRITE ??
          config.sandbox_deny_write
      ),
      tempRoot:
        stringValue(flags["sandbox-temp-root"]) ??
        process.env.AGENT_SANDBOX_TEMP_ROOT ??
        stringValue(config.sandbox_temp_root)
    },
    external: externalCommand
      ? {
          command: externalCommand,
          args: optionalStringList(
            flags["sandbox-external-args"] ??
              process.env.AGENT_SANDBOX_EXTERNAL_ARGS ??
              config.sandbox_external_args
          ) ?? []
        }
      : defaults.external
  };

  return sandbox;
}

export function loadCliConfig(flags: Record<string, string | boolean>): CliConfig {
  const homeConfig = loadTomlConfig(path.join(os.homedir(), ".agent", "config.toml"));
  const preliminaryWorkspace =
    stringValue(flags.workspace) ??
    process.env.AGENT_WORKSPACE ??
    stringValue(homeConfig.workspace) ??
    process.cwd();
  const workspaceConfig = loadTomlConfig(path.join(path.resolve(preliminaryWorkspace), ".agent", "config.toml"));
  const config = { ...homeConfig, ...workspaceConfig };

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
      DEFAULTS.validationMode
  );
  const sandbox = sandboxConfigFromValues(flags, config);

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
    sandbox,
    traceJsonl,
    summaryJson,
    sessionJsonl,
    maxToolOutputChars: numberValue(
      flags["max-tool-output-chars"] ?? process.env.AGENT_MAX_TOOL_OUTPUT_CHARS ?? config.max_tool_output_chars,
      DEFAULTS.maxToolOutputChars
    ),
    maxMessageHistoryChars: numberValue(
      flags["max-message-history-chars"] ??
        process.env.AGENT_MAX_MESSAGE_HISTORY_CHARS ??
        config.max_message_history_chars,
      DEFAULTS.maxMessageHistoryChars
    ),
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
    compactionMode: compactionModeValue(
      stringValue(flags["compaction-mode"]) ??
        process.env.AGENT_COMPACTION_MODE ??
        stringValue(config.compaction_mode) ??
        DEFAULTS.compactionMode
    ),
    compactionModel:
      stringValue(flags["compaction-model"]) ??
      process.env.AGENT_COMPACTION_MODEL ??
      stringValue(config.compaction_model),
    compactionProvider: optionalProviderValue(
      stringValue(flags["compaction-provider"]) ??
        process.env.AGENT_COMPACTION_PROVIDER ??
        stringValue(config.compaction_provider)
    ),
    compactionMaxInputChars: optionalNumberValue(
      flags["compaction-max-input-chars"] ??
        process.env.AGENT_COMPACTION_MAX_INPUT_CHARS ??
        config.compaction_max_input_chars
    ),
    compactionMaxOutputChars: optionalNumberValue(
      flags["compaction-max-output-chars"] ??
        process.env.AGENT_COMPACTION_MAX_OUTPUT_CHARS ??
        config.compaction_max_output_chars
    ),
    compactionTimeoutSec: numberValue(
      flags["compaction-timeout-sec"] ??
        process.env.AGENT_COMPACTION_TIMEOUT_SEC ??
        config.compaction_timeout_sec,
      DEFAULTS.compactionTimeoutSec
    ),
    compactionFallback: compactionFallbackValue(
      stringValue(flags["compaction-fallback"]) ??
        process.env.AGENT_COMPACTION_FALLBACK ??
        stringValue(config.compaction_fallback) ??
        DEFAULTS.compactionFallback
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
      flags["harness-timeout-sec"] ??
        process.env.AGENT_RUN_CONTROLLER_TIMEOUT_SEC ??
        config.run_controller_timeout_sec
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
        DEFAULTS.finalEvidenceMode
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
    subagentsEnabled: boolValue(
      flags["no-subagents"] !== undefined
        ? false
        : process.env.AGENT_SUBAGENTS_ENABLED ?? config.subagents_enabled,
      DEFAULTS.subagentsEnabled
    ),
    subagentMaxTurns: optionalNumberValue(
      flags["subagent-max-turns"] ?? process.env.AGENT_SUBAGENT_MAX_TURNS ?? config.subagent_max_turns
    ) ?? DEFAULTS.subagentMaxTurns,
    subagentMaxOutputChars: optionalNumberValue(
      flags["subagent-max-output-chars"] ??
        process.env.AGENT_SUBAGENT_MAX_OUTPUT_CHARS ??
        config.subagent_max_output_chars
    ) ?? DEFAULTS.subagentMaxOutputChars,
    reviewAntiGaming: flags["no-review-anti-gaming"] !== undefined
      ? false
      : boolValue(
          flags["review-anti-gaming"] ?? process.env.AGENT_REVIEW_ANTI_GAMING ?? config.review_anti_gaming,
          DEFAULTS.reviewAntiGaming
        ),
    enableMcp: boolValue(flags["enable-mcp"] ?? process.env.AGENT_ENABLE_MCP ?? config.enable_mcp, false),
    mcpConfig:
      stringValue(flags["mcp-config"]) ??
      process.env.AGENT_MCP_CONFIG ??
      stringValue(config.mcp_config),
    noStreamUi: !configuredStreamUi
  };
}
