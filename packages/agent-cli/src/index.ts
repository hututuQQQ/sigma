#!/usr/bin/env node
import { runChatCommand } from "./commands/chat.js";
import { runDoctorCommand } from "./commands/doctor.js";
import { runReplayCommand } from "./commands/replay.js";
import {
  runCheckpointCommand,
  runCheckpointsCommand,
  runSessionCommand,
  runSessionsCommand
} from "./commands/session.js";
import { runRunCommand, runSolveCommand } from "./commands/solve.js";

function printHelp(): void {
  process.stdout.write(`agent <command> [flags]

Commands:
  run      Run the autonomous coding agent once
  solve    Compatibility alias for run
  chat     Start a minimal plain-terminal chat session
  sessions List recent durable sessions
  history  Compatibility alias for sessions
  session  Show, search, resume, or fork sessions
  checkpoints List checkpoints for a session
  checkpoint  Show or restore a checkpoint
  doctor   Check local configuration
  replay   Summarize a trace JSONL file

Run "agent run 'Fix failing tests'" to start.

Common run flags:
  --workspace <path>
  --provider <deepseek|glm>
  --permission-mode <ask|yolo>
  --output-format <text|json|stream-json>
  --json
  --quiet
  --allowed-tools <comma-separated>
  --disabled-tools <comma-separated>
  --context-mode <off|repo-map>
  --final-evidence-mode <off|auto>
  --skills-mode <off|auto>
  --enable-mcp
  --stream-ui / --no-stream-ui
`);
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args[0] === "--") {
    args.shift();
  }
  const [command, ...rest] = args;
  if (!command || command === "--help" || command === "-h") {
    printHelp();
    return 0;
  }

  if (command === "run") return await runRunCommand(rest);
  if (command === "solve") return await runSolveCommand(rest);
  if (command === "chat") return await runChatCommand(rest);
  if (command === "sessions" || command === "history") return await runSessionsCommand(rest);
  if (command === "session") return await runSessionCommand(rest);
  if (command === "checkpoints") return await runCheckpointsCommand(rest);
  if (command === "checkpoint") return await runCheckpointCommand(rest);
  if (command === "doctor") return await runDoctorCommand(rest);
  if (command === "replay") return await runReplayCommand(rest);

  process.stderr.write(`Unknown command: ${command}\n`);
  printHelp();
  return 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
