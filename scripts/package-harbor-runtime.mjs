#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  buildHarborJobConfig,
  defaultAgentCliTarballForEnv,
  harborRuntimeDir as defaultHarborRuntimeDir,
  portableAgentImportPath,
  rootDir as defaultRootDir,
  terminalBenchDataset
} from "./bench-common.mjs";

function resolveArtifactsDir(rootDir, options) {
  return options.artifactsDir ? path.resolve(options.artifactsDir) : path.join(rootDir, ".artifacts");
}

function resolveHarborRuntimeDir(rootDir, options) {
  if (options.harborRuntimeDir) return path.resolve(options.harborRuntimeDir);
  if (options.artifactsDir) return path.join(resolveArtifactsDir(rootDir, options), "harbor-runtime");
  return defaultHarborRuntimeDir;
}

function resolveAgentCliTarball(rootDir, artifactsDir, env, options) {
  if (options.agentCliTarball) return path.resolve(options.agentCliTarball);
  if (env.AGENT_CLI_TARBALL) return path.resolve(rootDir, env.AGENT_CLI_TARBALL);
  const defaultPath = defaultAgentCliTarballForEnv(env);
  if (artifactsDir === path.join(defaultRootDir, ".artifacts")) return path.resolve(defaultPath);
  const targetArch = env.AGENT_TARGET_ARCH || "x64";
  return path.join(artifactsDir, `agent-cli-linux-${targetArch}.tgz`);
}

function baseBenchmarkOptions(agentCliTarball) {
  return {
    provider: "deepseek",
    model: "deepseek-v4-pro",
    maxTurns: 200,
    commandTimeoutSec: 180,
    genericValidationEnabled: true,
    agentCliTarball,
    agentImportPath: portableAgentImportPath,
    env: {}
  };
}

function runtimeReadme(agentCliTarball) {
  return `# Portable Harbor Runtime

This directory is a portable host-side Harbor runtime for Sigma. It lets Harbor import \`${portableAgentImportPath}\` without putting the Sigma repo root on \`PYTHONPATH\`.

## Build

\`\`\`bash
pnpm build
pnpm package:agent-cli
pnpm package:harbor-runtime
\`\`\`

The generated JobConfig files point at this agent CLI tarball:

\`\`\`text
${agentCliTarball}
\`\`\`

## Run

Set your provider key on the host, then point Harbor at this directory:

\`\`\`bash
export DEEPSEEK_API_KEY=...
PYTHONPATH="$PWD/.artifacts/harbor-runtime" \\
harbor run --config .artifacts/harbor-runtime/jobconfig.deepseek.k5.json
\`\`\`

For a single task example:

\`\`\`bash
export DEEPSEEK_API_KEY=...
PYTHONPATH="$PWD/.artifacts/harbor-runtime" \\
harbor run --config .artifacts/harbor-runtime/jobconfig.deepseek.task.example.json
\`\`\`

The task example uses \`openssl-selfsigned-cert\`; edit the task name in the JSON to target another Terminal-Bench task.

The Python adapter only depends on the Python standard library and Harbor. It uploads the packaged Sigma CLI, installs it as \`/usr/local/bin/agent\` in the task container, invokes \`agent solve\`, and downloads \`summary.json\`, \`trace.jsonl\`, and best-effort attempt artifacts.
`;
}

export async function packageHarborRuntime(options = {}) {
  const rootDir = options.rootDir ? path.resolve(options.rootDir) : defaultRootDir;
  const env = options.env ?? process.env;
  const artifactsDir = resolveArtifactsDir(rootDir, options);
  const harborRuntimeDir = resolveHarborRuntimeDir(rootDir, options);
  const sourcePath = options.sourcePath
    ? path.resolve(options.sourcePath)
    : path.join(rootDir, "portable", "harbor", "sigma_harbor_agent.py");
  const agentCliTarball = resolveAgentCliTarball(rootDir, artifactsDir, env, options);

  if (!existsSync(sourcePath)) {
    throw new Error(`Portable Harbor runtime source is missing: ${sourcePath}`);
  }

  const sourceText = await readFile(sourcePath, "utf8");
  if (sourceText.includes("integrations.harbor")) {
    throw new Error("Portable Harbor runtime source must not reference integrations.harbor.");
  }

  await rm(harborRuntimeDir, { recursive: true, force: true });
  await mkdir(harborRuntimeDir, { recursive: true });

  const runtimePath = path.join(harborRuntimeDir, "sigma_harbor_agent.py");
  await writeFile(runtimePath, sourceText, "utf8");

  const k5Config = buildHarborJobConfig(
    {
      ...baseBenchmarkOptions(agentCliTarball),
      mode: "k",
      k: 5
    },
    path.join(harborRuntimeDir, "jobs", "deepseek-k5")
  );
  const taskConfig = buildHarborJobConfig(
    {
      ...baseBenchmarkOptions(agentCliTarball),
      mode: "task",
      taskId: "openssl-selfsigned-cert"
    },
    path.join(harborRuntimeDir, "jobs", "deepseek-task-example")
  );

  await writeFile(path.join(harborRuntimeDir, "README.md"), runtimeReadme(agentCliTarball), "utf8");
  await writeFile(path.join(harborRuntimeDir, "jobconfig.deepseek.k5.json"), `${JSON.stringify(k5Config, null, 2)}\n`, "utf8");
  await writeFile(
    path.join(harborRuntimeDir, "jobconfig.deepseek.task.example.json"),
    `${JSON.stringify(taskConfig, null, 2)}\n`,
    "utf8"
  );

  return {
    artifactsDir,
    harborRuntimeDir,
    runtimePath,
    agentCliTarball,
    k5ConfigPath: path.join(harborRuntimeDir, "jobconfig.deepseek.k5.json"),
    taskExampleConfigPath: path.join(harborRuntimeDir, "jobconfig.deepseek.task.example.json")
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await packageHarborRuntime();
    console.log(`Created ${path.relative(defaultRootDir, result.harborRuntimeDir)}`);
    console.log(`Runtime import: ${portableAgentImportPath}`);
    console.log(`Agent CLI tarball: ${result.agentCliTarball}`);
    console.log(`Dataset: ${terminalBenchDataset}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
