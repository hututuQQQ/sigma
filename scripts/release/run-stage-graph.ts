import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  releaseSecretEnvironment,
  releaseStageGraph,
  type ReleaseStage,
} from "./stage-graph.ts";

export function releaseStageEnvironment(
  stage: Pick<ReleaseStage, "secretEnvironment">,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const allowed = new Set(stage.secretEnvironment);
  const environment = { ...source };
  for (const key of releaseSecretEnvironment) {
    if (!allowed.has(key)) delete environment[key];
  }
  return environment;
}

function run(stage: ReleaseStage): Promise<void> {
  const pnpmCli = stage.command === "pnpm" ? process.env.npm_execpath : undefined;
  const executable = pnpmCli ? process.execPath : stage.command;
  const executableArgs = pnpmCli ? [pnpmCli, ...stage.args] : [...stage.args];
  return new Promise((resolve, reject) => {
    const child = spawn(executable, executableArgs, {
      stdio: "inherit",
      shell: false,
      env: releaseStageEnvironment(stage),
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(
        `${stage.command} ${stage.args.join(" ")} failed (${signal ?? `exit ${String(code)}`}).`,
      ));
    });
  });
}

export async function runReleaseStageGraph(graphName: string): Promise<void> {
  for (const current of releaseStageGraph(graphName)) {
    process.stdout.write(`[release:${graphName}] ${current.id}\n`);
    await run(current);
  }
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const graphName = process.argv[2];
  if (!graphName) throw new Error("Usage: run-stage-graph.ts <graph-name>");
  await runReleaseStageGraph(graphName);
}
