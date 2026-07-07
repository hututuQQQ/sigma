#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ProviderName } from "agent-ai";
import type {
  AgentFinalEvidenceMode,
  AgentHarnessValidationMode,
  AgentSkillsMode,
  ContextMode,
  PermissionMode
} from "agent-core";
import { runTuiApp, type TuiAppOptions } from "./app.js";

type CliOptions = TuiAppOptions;

function printHelp(): void {
  process.stdout.write(`agent-tui [flags]

Flags:
  --workspace <path>             Workspace directory (default: current directory)
  --provider <deepseek|glm>      Model provider (default: deepseek)
  --model <name>                 Model name
  --permission-mode <ask|yolo>   Permission handling (default: ask)
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
  --final-evidence-mode <off|auto>
  --skills-mode <off|auto>
  --skills-max-chars <number>
  --enable-mcp
  --mcp-config <path>
  --trace-jsonl <path>
  --session-jsonl <path>
  --summary-json <path>
  --help                         Show this help

Inside the TUI:
  /help
  /status
  /tokens
  /context
  /test <command>
  /exit
  /clear
  /model <name>
  /provider <deepseek|glm>
  /permission <ask|yolo>
  /tools
  /diff
  /diff stat
  /diff patch
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

function validationModeValue(value: string | true | undefined): AgentHarnessValidationMode | undefined {
  if (value === undefined || value === true) return undefined;
  if (value === "off" || value === "auto") return value;
  throw new Error("Unsupported validation mode. Use off or auto.");
}

function evidenceModeValue(value: string | true | undefined): AgentFinalEvidenceMode | undefined {
  if (value === undefined || value === true) return undefined;
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

function validationCommands(flags: Map<string, string | true>): string[] | undefined {
  const commands = [
    ...(typeof flags.get("validation-command") === "string" ? [flags.get("validation-command") as string] : []),
    ...stringList(flags.get("validation-commands"))
  ].map((item) => item.trim()).filter(Boolean);
  return commands.length > 0 ? [...new Set(commands)] : undefined;
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
    workspace: path.resolve(typeof workspace === "string" ? workspace : process.cwd()),
    provider: providerValue(flags.get("provider")),
    model: typeof model === "string" ? model : undefined,
    permissionMode: permissionModeValue(flags.get("permission-mode")),
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
    contextMode: contextModeValue(flags.get("context-mode")),
    repoMapMaxChars: numberFlag(flags, "repo-map-max-chars"),
    finalEvidenceMode: evidenceModeValue(flags.get("final-evidence-mode")),
    skillsMode: skillsModeValue(flags.get("skills-mode")),
    skillsMaxChars: numberFlag(flags, "skills-max-chars"),
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
