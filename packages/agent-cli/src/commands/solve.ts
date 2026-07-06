import { readFile } from "node:fs/promises";
import { stdin as processStdin } from "node:process";
import type { ModelClient, ProviderName, ProviderOptions } from "agent-ai";
import { createModelClient } from "agent-ai";
import { runAgent } from "agent-core";
import { loadCliConfig, parseArgs } from "../config.js";
import { printRunResult } from "../output.js";

export interface SolveCommandDeps {
  modelClientFactory?: (provider: ProviderName, options: ProviderOptions) => ModelClient;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  stdin?: NodeJS.ReadableStream & { isTTY?: boolean };
}

async function readStdin(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function resolveInstruction(
  flags: Record<string, string | boolean>,
  deps: SolveCommandDeps
): Promise<string> {
  if (typeof flags.instruction === "string") {
    return flags.instruction;
  }

  if (typeof flags["instruction-file"] === "string") {
    return await readFile(flags["instruction-file"], "utf8");
  }

  const stdin = deps.stdin ?? processStdin;
  if (!stdin.isTTY) {
    const content = await readStdin(stdin);
    if (content.trim().length > 0) return content;
  }

  throw new Error("No instruction supplied. Use --instruction, --instruction-file, or pipe text on stdin.");
}

export async function runSolveCommand(argv: string[], deps: SolveCommandDeps = {}): Promise<number> {
  const stderr = deps.stderr ?? process.stderr;
  const factory = deps.modelClientFactory ?? createModelClient;

  try {
    const { flags } = parseArgs(argv);
    const cliConfig = loadCliConfig(flags);
    const instruction = await resolveInstruction(flags, deps);
    const modelClient = factory(cliConfig.provider, { model: cliConfig.model });

    const result = await runAgent({
      instruction,
      workspacePath: cliConfig.workspace,
      modelClient,
      maxTurns: cliConfig.maxTurns,
      maxWallTimeSec: cliConfig.maxWallTimeSec,
      commandTimeoutSec: cliConfig.commandTimeoutSec,
      permissionMode: cliConfig.permissionMode,
      traceJsonlPath: cliConfig.traceJsonl,
      sessionJsonlPath: cliConfig.sessionJsonl,
      summaryJsonPath: cliConfig.summaryJson,
      maxToolOutputChars: cliConfig.maxToolOutputChars
    });

    printRunResult(result);
    return result.status === "error" ? 1 : 0;
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
