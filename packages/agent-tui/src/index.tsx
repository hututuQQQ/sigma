#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ProviderName } from "agent-ai";
import type {
  AgentFinalEvidenceMode,
  AgentHarnessValidationMode,
  AgentSkillsMode,
  CompactionFallbackMode,
  CompactionMode,
  ContextMode,
  LoopGuardMode,
  MemoryScope,
  PermissionMode,
  PermissionRule,
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
import { runTuiApp, type TuiAppOptions } from "./app.js";

type CliOptions = TuiAppOptions;

export { runTuiApp, type TuiAppOptions } from "./app.js";

function printHelp(): void {
  process.stdout.write(`agent tui [flags]

Flags:
  --workspace <path>             Workspace directory (default: current directory)
  --provider <deepseek|glm>      Model provider (default: deepseek)
  --model <name>                 Model name
  --permission-mode <ask|yolo>   Permission handling (default: ask)
  --sandbox <read-only|workspace-write|danger-full-access|policy-only|external>
  --sandbox-backend <auto|bubblewrap|seatbelt|windows|external|policy-only>
  --sandbox-required
  --sandbox-network <default|restricted|disabled>
  --max-turns <number>
  --max-wall-time-sec <number>
  --command-timeout-sec <number>
  --validation-mode <off|auto>
  --validation-command <command>
  --validation-commands <comma-separated-commands>
  --validation-retry-limit <number>
  --validation-timeout-sec <number>
  --precheck-command <command>
  --precheck-timeout-sec <number>
  --post-run-cleanup-globs <comma-separated-globs>
  --harness-timeout-sec <number>
  --retry-min-budget-sec <number>
  --attempts-dir <path>
  --allowed-tools <comma-separated-tools>
  --disabled-tools <comma-separated-tools>
  --context-mode <off|repo-map>
  --repo-map-max-chars <number>
  --max-message-history-chars <number>
  --message-history-retain <number>
  --compaction-summary-chars <number>
  --compaction-mode <off|deterministic|model-sub-session>
  --compaction-model <model>
  --compaction-provider <deepseek|glm>
  --compaction-max-input-chars <number>
  --compaction-max-output-chars <number>
  --compaction-timeout-sec <number>
  --compaction-fallback <deterministic|fail>
  --final-evidence-mode <off|auto>
  --skills-mode <off|auto>
  --skills-max-chars <number>
  --no-subagents
  --subagent-max-turns <number>
  --subagent-max-output-chars <number>
  --enable-mcp
  --mcp-config <path>
  --trace-jsonl <path>
  --session-jsonl <path>
  --summary-json <path>
  --help                         Show this help

Inside the TUI:
  Type / to open the compact command palette; aliases resolve to canonical commands.
  /help (/h, /?)
  /status (/s)
  /tokens (/tk)
  /context (/c)
  /files (/f)
  /tools (/t)
  /sessions
  /session <id>
  /resume <id> <instruction>
  /fork <id> <instruction>
  /search <query>
  /history <query>
  /diff (/d)
  /diff stat (/ds)
  /diff patch (/dp)
  /test <command>
  /shell <command> or !<command>
  /mode plan
  /mode build
  /exit (/q)
  /clear (/cl)
  /model <name>
  /provider <deepseek|glm>
  /permission <ask|yolo>
  /workspace <path> (/w)

Shortcuts:
  Esc close palette/detail, then clear draft
  Ctrl+L clear timeline/result
  Ctrl+D toggle diff
  Ctrl+T toggle tools
  F1 open help
  Ctrl+J insert newline
  Ctrl+A/E move to start/end
  Ctrl+U/K kill to start/end
  Ctrl+W delete previous word
  Ctrl+Y yank killed text
  Left/Right move cursor
  Tab accepts command/file suggestions or opens the workbench
  Shift+Tab toggles plan/build mode
  Up/Down cycle prompt history
  @prefix suggests workspace files
`);
}

function stringList(value: string | true | undefined): string[] {
  if (typeof value !== "string") return [];
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function numberFlag(flags: Map<string, string | true>, name: string): number | undefined {
  const value = flags.get(name);
  if (typeof value !== "string" || value.length === 0) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`--${name} must be a number.`);
  return parsed;
}

function providerValue(value: string | true | undefined): ProviderName {
  if (value === undefined || value === true) return "deepseek";
  if (value === "deepseek" || value === "glm") return value;
  throw new Error("Unsupported provider. Use deepseek or glm.");
}

function permissionModeValue(value: string | true | undefined): PermissionMode {
  if (value === undefined || value === true) return "ask";
  if (value === "ask" || value === "yolo") return value;
  throw new Error("Unsupported permission mode. Use ask or yolo.");
}

function sandboxModeValue(value: string | true | undefined): SandboxMode | undefined {
  if (value === undefined || value === true) return undefined;
  if (
    value === "read-only" ||
    value === "workspace-write" ||
    value === "danger-full-access" ||
    value === "policy-only" ||
    value === "policy_only" ||
    value === "external" ||
    value === "disabled"
  ) return value;
  if (value === "read_only") return "read-only";
  if (value === "workspace_write") return "workspace-write";
  throw new Error("Unsupported sandbox mode.");
}

function sandboxBackendValue(value: string | true | undefined): SandboxBackend | undefined {
  if (value === undefined || value === true) return undefined;
  if (
    value === "auto" ||
    value === "bubblewrap" ||
    value === "seatbelt" ||
    value === "windows" ||
    value === "external" ||
    value === "policy-only" ||
    value === "policy_only"
  ) return value;
  throw new Error("Unsupported sandbox backend.");
}

function sandboxNetworkValue(value: string | true | undefined): SandboxNetworkMode | undefined {
  if (value === undefined || value === true) return undefined;
  if (value === "default" || value === "restricted" || value === "disabled") return value;
  throw new Error("Unsupported sandbox network mode.");
}

function boolFlag(flags: Map<string, string | true>, name: string, fallback: boolean): boolean {
  if (!flags.has(name)) return fallback;
  const value = flags.get(name);
  if (value === true) return true;
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

function sandboxConfig(flags: Map<string, string | true>): SandboxConfig {
  const defaults = createDefaultSandboxConfig();
  const mode = sandboxModeValue(flags.get("sandbox")) ?? defaults.mode;
  const backend = sandboxBackendValue(flags.get("sandbox-backend")) ?? defaults.backend;
  const network = sandboxNetworkValue(flags.get("sandbox-network")) ?? "restricted";
  const externalCommand = flags.get("sandbox-external-command");
  return {
    mode,
    backend,
    required: boolFlag(flags, "sandbox-required", defaults.required ?? false),
    network: { mode: network, allowLocalhost: true },
    filesystem: {
      readRoots: stringList(flags.get("sandbox-add-read")),
      writeRoots: stringList(flags.get("sandbox-add-write")),
      denyRead: stringList(flags.get("sandbox-deny-read")),
      denyWrite: stringList(flags.get("sandbox-deny-write"))
    },
    external: typeof externalCommand === "string"
      ? { command: externalCommand, args: stringList(flags.get("sandbox-external-args")) }
      : defaults.external
  };
}

function validationModeValue(value: string | true | undefined): AgentHarnessValidationMode | undefined {
  if (value === undefined || value === true) return DEFAULT_VALIDATION_MODE;
  if (value === "off" || value === "auto") return value;
  throw new Error("Unsupported validation mode. Use off or auto.");
}

function evidenceModeValue(value: string | true | undefined): AgentFinalEvidenceMode | undefined {
  if (value === undefined || value === true) return DEFAULT_FINAL_EVIDENCE_MODE;
  if (value === "off" || value === "auto") return value;
  throw new Error("Unsupported final evidence mode. Use off or auto.");
}

function skillsModeValue(value: string | true | undefined): AgentSkillsMode | undefined {
  if (value === undefined || value === true) return undefined;
  if (value === "off" || value === "auto") return value;
  throw new Error("Unsupported skills mode. Use off or auto.");
}

function contextModeValue(value: string | true | undefined): ContextMode | undefined {
  if (value === undefined || value === true) return undefined;
  if (value === "off" || value === "repo-map") return value;
  throw new Error("Unsupported context mode. Use off or repo-map.");
}

function compactionModeValue(value: string | true | undefined): CompactionMode | undefined {
  if (value === undefined || value === true) return DEFAULT_COMPACTION_MODE;
  if (value === "off" || value === "deterministic") return value;
  if (value === "model-sub-session" || value === "model_sub_session") return "model_sub_session";
  throw new Error("Unsupported compaction mode. Use off, deterministic, or model-sub-session.");
}

function compactionFallbackValue(value: string | true | undefined): CompactionFallbackMode | undefined {
  if (value === undefined || value === true) return undefined;
  if (value === "deterministic" || value === "fail") return value;
  throw new Error("Unsupported compaction fallback. Use deterministic or fail.");
}

function loopGuardModeValue(value: string | true | undefined): LoopGuardMode | undefined {
  if (value === undefined || value === true) return undefined;
  if (value === "off" || value === "warn" || value === "stop") return value;
  throw new Error("Unsupported loop guard mode. Use off, warn, or stop.");
}

function memoryScopesValue(value: string | true | undefined): MemoryScope[] | undefined {
  const scopes = stringList(value).filter((item): item is MemoryScope =>
    item === "user" ||
    item === "feedback" ||
    item === "project" ||
    item === "reference" ||
    item === "agent" ||
    item === "subagent"
  );
  return scopes.length > 0 ? scopes : undefined;
}

function permissionRulesValue(value: string | true | undefined): PermissionRule[] | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = JSON.parse(value) as unknown;
  const raw = Array.isArray(parsed) ? parsed : [parsed];
  return raw.filter((item): item is PermissionRule => Boolean(item) && typeof item === "object");
}

function validationCommands(flags: Map<string, string | true>): string[] | undefined {
  const commands = [
    ...(typeof flags.get("validation-command") === "string" ? [flags.get("validation-command") as string] : []),
    ...stringList(flags.get("validation-commands"))
  ].map((item) => item.trim()).filter(Boolean);
  return commands.length > 0 ? [...new Set(commands)] : undefined;
}

function invocationCwd(): string {
  const initCwd = process.env.INIT_CWD;
  return initCwd && path.isAbsolute(initCwd) ? initCwd : process.cwd();
}

export function parseTuiArgs(argv: string[]): CliOptions | "help" {
  const flags = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") return "help";
    if (!arg.startsWith("--")) continue;
    const rawName = arg.slice(2);
    const equalsIndex = rawName.indexOf("=");
    if (equalsIndex !== -1) {
      flags.set(rawName.slice(0, equalsIndex), rawName.slice(equalsIndex + 1));
      continue;
    }
    const name = rawName;
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      flags.set(name, next);
      index += 1;
    } else {
      flags.set(name, true);
    }
  }

  const workspace = flags.get("workspace");
  const model = flags.get("model");
  return {
    workspace: path.resolve(invocationCwd(), typeof workspace === "string" ? workspace : "."),
    provider: providerValue(flags.get("provider")),
    model: typeof model === "string" ? model : undefined,
    permissionMode: permissionModeValue(flags.get("permission-mode")),
    sandbox: sandboxConfig(flags),
    maxTurns: numberFlag(flags, "max-turns"),
    maxWallTimeSec: numberFlag(flags, "max-wall-time-sec"),
    commandTimeoutSec: numberFlag(flags, "command-timeout-sec"),
    validationMode: validationModeValue(flags.get("validation-mode")),
    validationCommands: validationCommands(flags),
    validationRetryLimit: numberFlag(flags, "validation-retry-limit"),
    validationTimeoutSec: numberFlag(flags, "validation-timeout-sec"),
    precheckCommand: typeof flags.get("precheck-command") === "string" ? flags.get("precheck-command") as string : undefined,
    precheckTimeoutSec: numberFlag(flags, "precheck-timeout-sec"),
    postRunCleanupGlobs: stringList(flags.get("post-run-cleanup-globs")),
    harnessTimeoutSec: numberFlag(flags, "harness-timeout-sec"),
    retryMinBudgetSec: numberFlag(flags, "retry-min-budget-sec"),
    attemptsDir: typeof flags.get("attempts-dir") === "string" ? flags.get("attempts-dir") as string : undefined,
    allowedTools: stringList(flags.get("allowed-tools")),
    disabledTools: stringList(flags.get("disabled-tools")),
    permissionRules: permissionRulesValue(flags.get("permission-rules")),
    loopGuardMode: loopGuardModeValue(flags.get("loop-guard-mode")),
    memoryScopes: memoryScopesValue(flags.get("memory-scopes")),
    contextMode: contextModeValue(flags.get("context-mode")),
    repoMapMaxChars: numberFlag(flags, "repo-map-max-chars"),
    modelContextLimits: numberFlag(flags, "model-context-chars")
      ? { contextChars: numberFlag(flags, "model-context-chars") }
      : undefined,
    maxMessageHistoryChars: numberFlag(flags, "max-message-history-chars") ?? DEFAULT_MAX_MESSAGE_HISTORY_CHARS,
    messageHistoryRetain: numberFlag(flags, "message-history-retain"),
    compactionSummaryChars: numberFlag(flags, "compaction-summary-chars"),
    compactionMode: compactionModeValue(flags.get("compaction-mode")),
    compactionModel: typeof flags.get("compaction-model") === "string" ? flags.get("compaction-model") as string : undefined,
    compactionProvider: typeof flags.get("compaction-provider") === "string"
      ? providerValue(flags.get("compaction-provider"))
      : undefined,
    compactionMaxInputChars: numberFlag(flags, "compaction-max-input-chars"),
    compactionMaxOutputChars: numberFlag(flags, "compaction-max-output-chars"),
    compactionTimeoutSec: numberFlag(flags, "compaction-timeout-sec"),
    compactionFallback: compactionFallbackValue(flags.get("compaction-fallback")),
    finalEvidenceMode: evidenceModeValue(flags.get("final-evidence-mode")),
    skillsMode: skillsModeValue(flags.get("skills-mode")),
    skillsMaxChars: numberFlag(flags, "skills-max-chars"),
    subagentsEnabled: flags.has("no-subagents") ? false : DEFAULT_SUBAGENTS_ENABLED,
    subagentBackgroundEnabled: flags.has("no-subagent-background") ? false : undefined,
    subagentHeartbeatTimeoutSec: numberFlag(flags, "subagent-heartbeat-timeout-sec"),
    subagentMaxTurns: numberFlag(flags, "subagent-max-turns"),
    subagentMaxOutputChars: numberFlag(flags, "subagent-max-output-chars"),
    enableMcp: flags.has("enable-mcp"),
    mcpConfig: typeof flags.get("mcp-config") === "string" ? flags.get("mcp-config") as string : undefined,
    traceJsonl: typeof flags.get("trace-jsonl") === "string" ? flags.get("trace-jsonl") as string : undefined,
    sessionJsonl: typeof flags.get("session-jsonl") === "string" ? flags.get("session-jsonl") as string : undefined,
    summaryJson: typeof flags.get("summary-json") === "string" ? flags.get("summary-json") as string : undefined
  };
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const parsed = parseTuiArgs(argv);
  if (parsed === "help") {
    printHelp();
    return 0;
  }
  await runTuiApp(parsed);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
