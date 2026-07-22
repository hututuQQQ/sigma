#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  defaultAgentCliTarballForEnv,
  harborRuntimeDir as defaultHarborRuntimeDir,
  harborSandboxComposePath as defaultHarborSandboxComposePath,
  portableAgentImportPath,
  removedHarborDirectoryName,
  removedHarborPackageName,
  rootDir as defaultRootDir
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

function runtimeReadme(agentCliTarball) {
  return `# Portable Harbor Runtime

This directory is a portable host-side Harbor runtime for Sigma. It lets Harbor import \`${portableAgentImportPath}\` without putting the Sigma repo root on \`PYTHONPATH\`.

## Build

\`\`\`bash
pnpm build
pnpm package:agent-cli
pnpm package:harbor-runtime
\`\`\`

Formal JobConfig files bind this agent CLI tarball by SHA-256:

\`\`\`text
${agentCliTarball}
\`\`\`

## Run

Formal runs create source-free per-task JobConfig files from their SHA-bound
\`SigmaFormalRunPreregistrationV1\`. This portable package deliberately contains
no dataset, provider, model, task count, retry, or score-threshold defaults.

\`\`\`bash
pnpm bench:tb:formal -- \\
  --preregistration-file formal-run.json \\
  --expected-preregistration-sha256 <sha256> \\
  --batch <batch-id>
\`\`\`

The Python adapter only depends on the Python standard library and Harbor. It uploads the packaged Sigma CLI, installs it as \`/usr/local/bin/agent\` in the task container, invokes \`agent run\`, and records its structured result after the run. Evaluation output is never passed back into the solving session.
`;
}

function assertNoRemovedHarborAdapter(text, description) {
  if (text.includes(removedHarborPackageName) || text.includes(removedHarborDirectoryName)) {
    throw new Error(`${description} must not reference the removed Harbor adapter.`);
  }
}

export async function packageHarborRuntime(options = {}) {
  const rootDir = options.rootDir ? path.resolve(options.rootDir) : defaultRootDir;
  const env = options.env ?? process.env;
  const artifactsDir = resolveArtifactsDir(rootDir, options);
  const harborRuntimeDir = resolveHarborRuntimeDir(rootDir, options);
  const sourcePath = options.sourcePath
    ? path.resolve(options.sourcePath)
    : path.join(rootDir, "portable", "harbor", "sigma_harbor_agent.py");
  const sandboxComposeSourcePath = options.sandboxComposeSourcePath
    ? path.resolve(options.sandboxComposeSourcePath)
    : path.join(rootDir, "portable", "harbor", "docker-compose-sigma-sandbox.yaml");
  const sandboxComposePath = options.harborRuntimeDir || options.artifactsDir
    ? path.join(harborRuntimeDir, "docker-compose-sigma-sandbox.yaml")
    : defaultHarborSandboxComposePath;
  const agentCliTarball = resolveAgentCliTarball(rootDir, artifactsDir, env, options);

  if (!existsSync(sourcePath)) {
    throw new Error(`Portable Harbor runtime source is missing: ${sourcePath}`);
  }
  if (!existsSync(sandboxComposeSourcePath)) {
    throw new Error(`Portable Harbor sandbox Compose overlay is missing: ${sandboxComposeSourcePath}`);
  }
  if (!existsSync(agentCliTarball)) {
    throw new Error(`Packaged agent CLI is missing: ${agentCliTarball}. Run pnpm package:agent-cli first.`);
  }

  const sourceText = await readFile(sourcePath, "utf8");
  const sandboxComposeText = await readFile(sandboxComposeSourcePath, "utf8");
  assertNoRemovedHarborAdapter(sourceText, "Portable Harbor runtime source");

  await rm(harborRuntimeDir, { recursive: true, force: true });
  await mkdir(harborRuntimeDir, { recursive: true });

  const runtimePath = path.join(harborRuntimeDir, "sigma_harbor_agent.py");
  await writeFile(runtimePath, sourceText, "utf8");
  await writeFile(sandboxComposePath, sandboxComposeText, "utf8");

  const readmeText = runtimeReadme(agentCliTarball);

  assertNoRemovedHarborAdapter(readmeText, "Portable Harbor runtime README");

  await writeFile(path.join(harborRuntimeDir, "README.md"), readmeText, "utf8");

  return {
    artifactsDir,
    harborRuntimeDir,
    runtimePath,
    sandboxComposePath,
    agentCliTarball
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await packageHarborRuntime();
    console.log(`Created ${path.relative(defaultRootDir, result.harborRuntimeDir)}`);
    console.log(`Runtime import: ${portableAgentImportPath}`);
    console.log(`Agent CLI tarball: ${result.agentCliTarball}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
