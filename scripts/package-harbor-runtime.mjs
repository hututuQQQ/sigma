#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  defaultAgentCliTarballForEnv,
  harborAptNetworkConfigPath as defaultHarborAptNetworkConfigPath,
  harborAptRetryWrapperPath as defaultHarborAptRetryWrapperPath,
  harborCurlRetryWrapperPath as defaultHarborCurlRetryWrapperPath,
  harborProxyComposePath as defaultHarborProxyComposePath,
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
\`SigmaFormalRunPreregistration\`. This portable package deliberately contains
no dataset, provider, model, task count, retry, or score-threshold defaults.

\`\`\`bash
pnpm bench:tb:formal -- \\
  --preregistration-file formal-run.json \\
  --expected-preregistration-sha256 <sha256> \\
  --batch <batch-id>
\`\`\`

The Python adapters only depend on the Python standard library and Harbor. The
Sigma adapter uploads the packaged Sigma CLI, installs it as
\`/usr/local/bin/agent\`, invokes \`agent run\`, and records its structured
result after the run. The optional \`codex_harbor_agent:PortableCodex\` adapter
inherits Harbor's stock Codex behavior while installing a caller-provided,
SHA-256-bound native Codex archive without live runtime downloads. Evaluation
output is never passed back into either solving session.
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
  const codexSourcePath = options.codexSourcePath
    ? path.resolve(options.codexSourcePath)
    : path.join(rootDir, "portable", "harbor", "codex_harbor_agent.py");
  const sandboxComposeSourcePath = options.sandboxComposeSourcePath
    ? path.resolve(options.sandboxComposeSourcePath)
    : path.join(rootDir, "portable", "harbor", "docker-compose-sigma-sandbox.yaml");
  const sandboxComposePath = options.harborRuntimeDir || options.artifactsDir
    ? path.join(harborRuntimeDir, "docker-compose-sigma-sandbox.yaml")
    : defaultHarborSandboxComposePath;
  const proxyComposeSourcePath = options.proxyComposeSourcePath
    ? path.resolve(options.proxyComposeSourcePath)
    : path.join(rootDir, "portable", "harbor", "docker-compose-sigma-proxy.yaml");
  const proxyComposePath = options.harborRuntimeDir || options.artifactsDir
    ? path.join(harborRuntimeDir, "docker-compose-sigma-proxy.yaml")
    : defaultHarborProxyComposePath;
  const aptNetworkConfigSourcePath = options.aptNetworkConfigSourcePath
    ? path.resolve(options.aptNetworkConfigSourcePath)
    : path.join(rootDir, "portable", "harbor", "apt-network-retries.conf");
  const aptNetworkConfigPath = options.harborRuntimeDir || options.artifactsDir
    ? path.join(harborRuntimeDir, "apt-network-retries.conf")
    : defaultHarborAptNetworkConfigPath;
  const aptRetryWrapperSourcePath = options.aptRetryWrapperSourcePath
    ? path.resolve(options.aptRetryWrapperSourcePath)
    : path.join(rootDir, "portable", "harbor", "apt-network-retry");
  const aptRetryWrapperPath = options.harborRuntimeDir || options.artifactsDir
    ? path.join(harborRuntimeDir, "apt-network-retry")
    : defaultHarborAptRetryWrapperPath;
  const curlRetryWrapperSourcePath = options.curlRetryWrapperSourcePath
    ? path.resolve(options.curlRetryWrapperSourcePath)
    : path.join(rootDir, "portable", "harbor", "curl-network-retry");
  const curlRetryWrapperPath = options.harborRuntimeDir || options.artifactsDir
    ? path.join(harborRuntimeDir, "curl-network-retry")
    : defaultHarborCurlRetryWrapperPath;
  const agentCliTarball = resolveAgentCliTarball(rootDir, artifactsDir, env, options);

  if (!existsSync(sourcePath)) {
    throw new Error(`Portable Harbor runtime source is missing: ${sourcePath}`);
  }
  if (!existsSync(codexSourcePath)) {
    throw new Error(`Portable Codex Harbor runtime source is missing: ${codexSourcePath}`);
  }
  if (!existsSync(sandboxComposeSourcePath)) {
    throw new Error(`Portable Harbor sandbox Compose overlay is missing: ${sandboxComposeSourcePath}`);
  }
  if (!existsSync(proxyComposeSourcePath)) {
    throw new Error(`Portable Harbor proxy Compose overlay is missing: ${proxyComposeSourcePath}`);
  }
  if (!existsSync(aptNetworkConfigSourcePath)) {
    throw new Error(`Portable Harbor APT network config is missing: ${aptNetworkConfigSourcePath}`);
  }
  if (!existsSync(aptRetryWrapperSourcePath)) {
    throw new Error(`Portable Harbor APT retry wrapper is missing: ${aptRetryWrapperSourcePath}`);
  }
  if (!existsSync(curlRetryWrapperSourcePath)) {
    throw new Error(`Portable Harbor curl retry wrapper is missing: ${curlRetryWrapperSourcePath}`);
  }
  if (options.requireAgentCliTarball !== false && !existsSync(agentCliTarball)) {
    throw new Error(`Packaged agent CLI is missing: ${agentCliTarball}. Run pnpm package:agent-cli first.`);
  }

  const sourceText = await readFile(sourcePath, "utf8");
  const codexSourceText = await readFile(codexSourcePath, "utf8");
  const sandboxComposeText = await readFile(sandboxComposeSourcePath, "utf8");
  const proxyComposeText = await readFile(proxyComposeSourcePath, "utf8");
  const aptNetworkConfigText = await readFile(aptNetworkConfigSourcePath, "utf8");
  const aptRetryWrapperText = await readFile(aptRetryWrapperSourcePath, "utf8");
  const curlRetryWrapperText = await readFile(curlRetryWrapperSourcePath, "utf8");
  assertNoRemovedHarborAdapter(sourceText, "Portable Harbor runtime source");
  assertNoRemovedHarborAdapter(codexSourceText, "Portable Codex Harbor runtime source");

  await rm(harborRuntimeDir, { recursive: true, force: true });
  await mkdir(harborRuntimeDir, { recursive: true });

  const runtimePath = path.join(harborRuntimeDir, "sigma_harbor_agent.py");
  const codexRuntimePath = path.join(harborRuntimeDir, "codex_harbor_agent.py");
  await writeFile(runtimePath, sourceText, "utf8");
  await writeFile(codexRuntimePath, codexSourceText, "utf8");
  await writeFile(sandboxComposePath, sandboxComposeText, "utf8");
  await writeFile(proxyComposePath, proxyComposeText, "utf8");
  await writeFile(aptNetworkConfigPath, aptNetworkConfigText, "utf8");
  await writeFile(aptRetryWrapperPath, aptRetryWrapperText, { encoding: "utf8", mode: 0o755 });
  await writeFile(curlRetryWrapperPath, curlRetryWrapperText, { encoding: "utf8", mode: 0o755 });

  const readmeText = runtimeReadme(agentCliTarball);

  assertNoRemovedHarborAdapter(readmeText, "Portable Harbor runtime README");

  await writeFile(path.join(harborRuntimeDir, "README.md"), readmeText, "utf8");

  return {
    artifactsDir,
    harborRuntimeDir,
    runtimePath,
    codexRuntimePath,
    sandboxComposePath,
    proxyComposePath,
    aptNetworkConfigPath,
    aptRetryWrapperPath,
    curlRetryWrapperPath,
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
