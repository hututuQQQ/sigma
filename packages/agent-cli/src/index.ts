#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CommandRegistry, SIGMA_CONFIG_SCHEMA, configHelp, type CommandDefinition } from "agent-config";
import type { RuntimeClient } from "agent-protocol";
import type { TuiAppOptions } from "agent-tui";
import { runDoctorCommand } from "./commands/doctor.js";
import { runSandboxCommand } from "./commands/sandbox.js";
import { runConfigCommand } from "./commands/config.js";
import { runInitCommand } from "./commands/init.js";
import { runReplayCommand } from "./commands/replay.js";
import { runCommand } from "./commands/run.js";
import { runSessionCommand, runSessionsCommand } from "./commands/session.js";
import { runVersionCommand } from "./commands/version.js";
import {
  loadCliConfig, parseArgs, workspaceCustomizationTrustMessage, workspaceMcpTrustMessage
} from "./config.js";
import { createConfiguredRuntime, type RuntimeFactoryDeps } from "agent-runtime";

export interface AgentCliMainOptions {
  tuiRunner?: (options: TuiAppOptions) => Promise<void>;
  stderr?: NodeJS.WritableStream;
  runtimeFactoryDeps?: RuntimeFactoryDeps;
  runtime?: RuntimeClient;
}

function printHelp(): void {
  const commands = new CommandRegistry().definitions();
  process.stdout.write(`Sigma Code 3.0\n\nUsage: agent <command> [options]\n\nCommands:\n${commands.map((item) => `  ${item.name.padEnd(10)} ${item.summary}`).join("\n")}\n\nConfiguration:\n${configHelp().join("\n")}\n`);
}

function completionScript(shell: string): string {
  const commands = new CommandRegistry().definitions().flatMap((item) => [item.name, ...(item.aliases ?? [])]);
  const flags = SIGMA_CONFIG_SCHEMA.map((item) => `--${item.flag}`);
  if (shell === "bash") return `_agent_completion() { COMPREPLY=( $(compgen -W "${[...commands, ...flags].join(" ")}" -- "\${COMP_WORDS[COMP_CWORD]}") ); }\ncomplete -F _agent_completion agent\n`;
  if (shell === "zsh") return `#compdef agent\n_arguments '*: :(${[...commands, ...flags].join(" ")})'\n`;
  if (shell === "fish") return [
    ...commands.map((command) => `complete -c agent -f -n "__fish_is_first_arg" -a ${command}`),
    ...flags.map((flag) => `complete -c agent -f -l ${flag.slice(2)}`)
  ].join("\n") + "\n";
  throw new Error("completion shell must be bash, zsh, or fish");
}

async function runTuiCommand(argv: string[], options: AgentCliMainOptions): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    const tui = await import("agent-tui");
    return await tui.main(argv);
  }
  const { flags } = parseArgs(argv);
  const cliConfig = loadCliConfig(flags);
  const trustMessage = workspaceMcpTrustMessage(cliConfig) ?? workspaceCustomizationTrustMessage(cliConfig);
  if (trustMessage) {
    (options.stderr ?? process.stderr).write(`${trustMessage}\n`);
    return 2;
  }
  const configured = await createConfiguredRuntime(cliConfig, options.runtimeFactoryDeps, { surface: "tui" });
  const tuiOptions: TuiAppOptions = {
    runtime: configured.runtime,
    workspace: configured.workspace,
    mode: "change",
    maxFps: cliConfig.tuiFps,
    sessionId: typeof flags.session === "string" ? flags.session : undefined
  };
  try {
    if (options.tuiRunner) await options.tuiRunner(tuiOptions);
    else {
      const tui = await import("agent-tui");
      await tui.runTuiApp(tuiOptions);
    }
  } finally {
    await configured.close();
  }
  return 0;
}

async function dispatchCommand(
  definition: CommandDefinition,
  argv: string[],
  options: AgentCliMainOptions
): Promise<number> {
  switch (definition.handler) {
    case "run": return await runCommand(argv, { mode: definition.mode });
    case "tui": return await runTuiCommand(argv, options);
    case "session": return definition.sessionAction === "list"
      ? await runSessionsCommand(argv, { runtime: options.runtime })
      : await runSessionCommand(definition.sessionAction ? [definition.sessionAction, ...argv] : argv, {
        runtime: options.runtime
      });
    case "replay": return await runReplayCommand(argv, { runtime: options.runtime });
    case "doctor": return await runDoctorCommand(argv);
    case "sandbox": return await runSandboxCommand(argv);
    case "version": return await runVersionCommand(argv);
    case "init": return await runInitCommand(argv);
    case "config": return await runConfigCommand(argv);
    case "completion":
      process.stdout.write(completionScript(argv[0] ?? ""));
      return 0;
  }
}

export async function runAgentCommand(args = process.argv.slice(2), options: AgentCliMainOptions = {}): Promise<number> {
  const normalized = args[0] === "--" ? args.slice(1) : args;
  const [command, ...rest] = normalized;
  if (command === "--version" || command === "-v") return await runVersionCommand([]);
  if (!command || command === "--help" || command === "-h") {
    printHelp();
    return 0;
  }
  const definition = new CommandRegistry().resolve(command);
  if (!definition) {
    process.stderr.write(`Unknown command: ${command}\n`);
    printHelp();
    return 1;
  }
  return await dispatchCommand(definition, rest, options);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runAgentCommand().then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
