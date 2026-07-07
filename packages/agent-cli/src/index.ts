#!/usr/bin/env node
import { runChatCommand } from "./commands/chat.js";
import { runDoctorCommand } from "./commands/doctor.js";
import { runReplayCommand } from "./commands/replay.js";
import { runRunCommand, runSolveCommand } from "./commands/solve.js";

function printHelp(): void {
  process.stdout.write(`agent <command> [flags]

Commands:
  run      Run the autonomous coding agent once
  solve    Compatibility alias for run
  chat     Start a minimal plain-terminal chat session
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
