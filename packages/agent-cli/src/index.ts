#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { TuiAppOptions } from "agent-tui";
import { runChatCommand } from "./commands/chat.js";
import { runDoctorCommand } from "./commands/doctor.js";
import { runInitCommand } from "./commands/init.js";
import { runReplayCommand } from "./commands/replay.js";
import {
  runArtifactsCommand,
  runCheckpointCommand,
  runCheckpointsCommand,
  runJobsCommand,
  runSessionCommand,
  runSessionsCommand
} from "./commands/session.js";
import { runRunCommand } from "./commands/run.js";
import { runVersionCommand } from "./commands/version.js";
import { loadCliConfig, parseArgs, type CliConfig } from "./config.js";

export interface AgentCliMainOptions {
  tuiRunner?: (options: TuiAppOptions) => Promise<void>;
}

function printHelp(): void {
  process.stdout.write(`agent <command> [flags]

Commands:
  run      Run the autonomous coding agent once
  init     Create a workspace .agent/config.toml
  tui      Start the interactive terminal UI
  chat     Start a minimal plain-terminal chat session
  sessions List recent durable sessions
  session  Show, search, resume, or fork sessions
  inspect  Inspect latest or selected session evidence
  jobs     Summarize recent session jobs
  artifacts Show artifacts for latest or selected session
  checkpoints List checkpoints for a session
  checkpoint  Show or restore a checkpoint
  version  Print CLI version and runtime metadata
  completion Generate shell completion for bash, zsh, or fish
  doctor   Check local configuration
  replay   Summarize a trace JSONL file

Run "agent run 'Fix failing tests'" to start.

Common run flags:
  --workspace <path>
  --provider <deepseek|glm>
  --permission-mode <ask|yolo>
  --sandbox <read-only|workspace-write|danger-full-access|policy-only|external>
  --sandbox-required
  --sandbox-network <default|restricted|disabled>
  --output-format <text|json|stream-json>
  --json
  --quiet
  --allowed-tools <comma-separated>
  --disabled-tools <comma-separated>
  --permission-rules <json>
  --loop-guard-mode <off|warn|stop>
  --context-mode <off|repo-map>
  --model-context-chars <number>
  --memory-scopes <comma-separated>
  --max-message-history-chars <number>
  --message-history-retain <number>
  --compaction-mode <off|deterministic|model-sub-session>
  --compaction-provider <deepseek|glm>
  --compaction-max-input-chars <number>
  --compaction-max-output-chars <number>
  --compaction-fallback <deterministic|fail>
  --final-evidence-mode <off|auto>
  --skills-mode <off|auto>
  --no-subagents
  --no-subagent-background
  --review-anti-gaming / --no-review-anti-gaming
  --enable-mcp
  --stream-ui / --no-stream-ui
`);
}

function completionScript(shell: string): string {
  const commands = [
    "run",
    "init",
    "tui",
    "chat",
    "sessions",
    "session",
    "inspect",
    "jobs",
    "artifacts",
    "checkpoints",
    "checkpoint",
    "version",
    "completion",
    "doctor",
    "replay"
  ];
  const flags = [
    "--workspace",
    "--limit",
    "--check-api",
    "--strict",
    "--instruction",
    "--instruction-clipboard",
    "--instruction-file",
    "--provider",
    "--model",
    "--permission-mode",
    "--sandbox",
    "--sandbox-backend",
    "--sandbox-required",
    "--sandbox-network",
    "--sandbox-add-read",
    "--sandbox-add-write",
    "--sandbox-deny-read",
    "--sandbox-deny-write",
    "--sandbox-external-command",
    "--sandbox-external-args",
    "--max-turns",
    "--max-wall-time-sec",
    "--command-timeout-sec",
    "--validation-mode",
    "--validation-command",
    "--validation-commands",
    "--validation-retry-limit",
    "--precheck-command",
    "--allowed-tools",
    "--disabled-tools",
    "--permission-rules",
    "--loop-guard-mode",
    "--model-context-chars",
    "--memory-scopes",
    "--context-mode",
    "--compaction-mode",
    "--compaction-model",
    "--compaction-provider",
    "--compaction-max-input-chars",
    "--compaction-max-output-chars",
    "--compaction-timeout-sec",
    "--compaction-fallback",
    "--max-message-history-chars",
    "--message-history-retain",
    "--final-evidence-mode",
    "--no-subagents",
    "--no-subagent-background",
    "--subagent-background-enabled",
    "--subagent-heartbeat-timeout-sec",
    "--subagent-max-turns",
    "--subagent-max-output-chars",
    "--review-anti-gaming",
    "--no-review-anti-gaming",
    "--enable-mcp",
    "--mcp-config",
    "--output-format",
    "--json",
    "--quiet",
    "--stream-ui",
    "--no-stream-ui",
    "--help"
  ];
  if (shell === "bash") {
    return `_agent_completion() {
  local cur prev
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "${commands.join(" ")}" -- "$cur") )
    return 0
  fi
  COMPREPLY=( $(compgen -W "${flags.join(" ")}" -- "$cur") )
}
complete -F _agent_completion agent
`;
  }
  if (shell === "zsh") {
    return `#compdef agent
_agent() {
  local -a commands flags
  commands=(${commands.map((item) => `"${item}"`).join(" ")})
  flags=(${flags.map((item) => `"${item}"`).join(" ")})
  if (( CURRENT == 2 )); then
    _describe 'command' commands
  else
    _describe 'flag' flags
  fi
}
_agent "$@"
`;
  }
  if (shell === "fish") {
    return [
      ...commands.map((command) => `complete -c agent -f -n "__fish_is_first_arg" -a ${command}`),
      ...flags.map((flag) => `complete -c agent -f -l ${flag.slice(2)}`)
    ].join("\n") + "\n";
  }
  throw new Error("completion shell must be bash, zsh, or fish");
}

function tuiOptionsFromCliConfig(config: CliConfig): TuiAppOptions {
  return {
    workspace: config.workspace,
    provider: config.provider,
    model: config.model,
    permissionMode: config.permissionMode,
    maxTurns: config.maxTurns,
    maxWallTimeSec: config.maxWallTimeSec,
    commandTimeoutSec: config.commandTimeoutSec,
    sandbox: config.sandbox,
    validationMode: config.validationMode,
    validationCommands: config.validationCommands,
    validationRetryLimit: config.validationRetryLimit,
    validationTimeoutSec: config.validationTimeoutSec,
    precheckCommand: config.precheckCommand,
    precheckTimeoutSec: config.precheckTimeoutSec,
    postRunCleanupGlobs: config.postRunCleanupGlobs,
    harnessTimeoutSec: config.harnessTimeoutSec,
    retryMinBudgetSec: config.retryMinBudgetSec,
    attemptsDir: config.attemptsDir,
    allowedTools: config.allowedTools,
    disabledTools: config.disabledTools,
    permissionRules: config.permissionRules,
    loopGuardMode: config.loopGuardMode,
    memoryScopes: config.memoryScopes,
    contextMode: config.contextMode,
    repoMapMaxChars: config.repoMapMaxChars,
    modelContextLimits: config.modelContextLimits,
    compactionMode: config.compactionMode,
    compactionModel: config.compactionModel,
    compactionProvider: config.compactionProvider,
    compactionMaxInputChars: config.compactionMaxInputChars,
    compactionMaxOutputChars: config.compactionMaxOutputChars,
    compactionTimeoutSec: config.compactionTimeoutSec,
    compactionFallback: config.compactionFallback,
    finalEvidenceMode: config.finalEvidenceMode,
    skillsMode: config.skillsMode,
    skillsMaxChars: config.skillsMaxChars,
    subagentsEnabled: config.subagentsEnabled,
    subagentBackgroundEnabled: config.subagentBackgroundEnabled,
    subagentHeartbeatTimeoutSec: config.subagentHeartbeatTimeoutSec,
    subagentMaxTurns: config.subagentMaxTurns,
    subagentMaxOutputChars: config.subagentMaxOutputChars,
    reviewAntiGaming: config.reviewAntiGaming,
    enableMcp: config.enableMcp,
    mcpConfig: config.mcpConfig,
    traceJsonl: config.traceJsonl,
    sessionJsonl: config.sessionJsonl,
    summaryJson: config.summaryJson
  };
}

async function runTuiCommand(argv: string[], options: AgentCliMainOptions): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    const tui = await import("agent-tui");
    return await tui.main(argv);
  }
  const { flags } = parseArgs(argv);
  const cliConfig = loadCliConfig(flags);
  const tuiOptions = tuiOptionsFromCliConfig(cliConfig);
  if (options.tuiRunner) {
    await options.tuiRunner(tuiOptions);
  } else {
    const tui = await import("agent-tui");
    await tui.runTuiApp(tuiOptions);
  }
  return 0;
}

function inspectArgs(argv: string[]): string[] {
  const parsed = parseArgs(argv);
  const hasTarget = parsed.positionals.length > 0 || parsed.flags.latest === true;
  return ["show", ...(hasTarget ? argv : ["--latest", ...argv])];
}

export async function runAgentCommand(args = process.argv.slice(2), options: AgentCliMainOptions = {}): Promise<number> {
  if (args[0] === "--") {
    args.shift();
  }
  const [command, ...rest] = args;
  if (command === "--version" || command === "-v") return await runVersionCommand([]);
  if (!command || command === "--help" || command === "-h") {
    printHelp();
    return 0;
  }

  if (command === "run") return await runRunCommand(rest);
  if (command === "init") return await runInitCommand(rest);
  if (command === "tui") return await runTuiCommand(rest, options);
  if (command === "chat") return await runChatCommand(rest);
  if (command === "sessions") return await runSessionsCommand(rest);
  if (command === "session") return await runSessionCommand(rest);
  if (command === "inspect") return await runSessionCommand(inspectArgs(rest));
  if (command === "jobs") return await runJobsCommand(rest);
  if (command === "artifacts") return await runArtifactsCommand(rest);
  if (command === "checkpoints") return await runCheckpointsCommand(rest);
  if (command === "checkpoint") return await runCheckpointCommand(rest);
  if (command === "version") return await runVersionCommand(rest);
  if (command === "completion") {
    process.stdout.write(completionScript(rest[0] ?? ""));
    return 0;
  }
  if (command === "doctor") return await runDoctorCommand(rest);
  if (command === "replay") return await runReplayCommand(rest);

  process.stderr.write(`Unknown command: ${command}\n`);
  printHelp();
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runAgentCommand()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
