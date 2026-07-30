#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";

type VersionCommandModule = Pick<
  typeof import("./commands/version.js"),
  "runVersionCommand"
>;
type AgentCommandModule = Pick<typeof import("./index.js"), "runAgentCommand">;

export interface AgentCliBootstrapDeps {
  loadVersionCommand?: () => Promise<VersionCommandModule>;
  loadAgentCommand?: () => Promise<AgentCommandModule>;
  stderr?: NodeJS.WritableStream;
}

const loadVersionCommand = (): Promise<VersionCommandModule> =>
  import("./commands/version.js");
const loadAgentCommand = (): Promise<AgentCommandModule> => import("./index.js");

export async function runAgentCli(
  args = process.argv.slice(2),
  deps: AgentCliBootstrapDeps = {}
): Promise<number> {
  const normalized = args[0] === "--" ? args.slice(1) : args;
  const [command, ...rest] = normalized;

  if (command === "--version" || command === "-v" || command === "version") {
    const version = await (deps.loadVersionCommand ?? loadVersionCommand)();
    return await version.runVersionCommand(command === "version" ? rest : []);
  }

  const agent = await (deps.loadAgentCommand ?? loadAgentCommand)();
  return await agent.runAgentCommand(args);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await runAgentCli();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
