#!/usr/bin/env node
import path from "node:path";
import type { ProviderName } from "agent-ai";
import type { PermissionMode } from "agent-core";
import { runTuiApp } from "./app.js";

interface CliOptions {
  workspace: string;
  provider: ProviderName;
  model?: string;
  permissionMode: PermissionMode;
}

function printHelp(): void {
  process.stdout.write(`agent-tui [flags]

Flags:
  --workspace <path>             Workspace directory (default: current directory)
  --provider <deepseek|glm>      Model provider (default: deepseek)
  --model <name>                 Model name
  --permission-mode <ask|yolo>   Permission handling (default: ask)
  --help                         Show this help

Inside the TUI:
  /exit
  /clear
  /model <name>
  /provider <deepseek|glm>
  /permission <ask|yolo>
  /tools
  /diff
`);
}

function parseArgs(argv: string[]): CliOptions | "help" {
  const flags = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") return "help";
    if (!arg.startsWith("--")) continue;
    const name = arg.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      flags.set(name, next);
      index += 1;
    } else {
      flags.set(name, true);
    }
  }

  const provider = flags.get("provider") ?? "deepseek";
  if (provider !== "deepseek" && provider !== "glm") {
    throw new Error("Unsupported provider. Use deepseek or glm.");
  }
  const permissionMode = flags.get("permission-mode") ?? "ask";
  if (permissionMode !== "ask" && permissionMode !== "yolo") {
    throw new Error("Unsupported permission mode. Use ask or yolo.");
  }

  const workspace = flags.get("workspace");
  const model = flags.get("model");
  return {
    workspace: path.resolve(typeof workspace === "string" ? workspace : process.cwd()),
    provider,
    model: typeof model === "string" ? model : undefined,
    permissionMode
  };
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed === "help") {
    printHelp();
    return 0;
  }
  await runTuiApp(parsed);
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
