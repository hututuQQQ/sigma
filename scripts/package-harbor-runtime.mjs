#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildHarborJobConfig,
  defaultAgentCliTarballForEnv,
  harborContainerComposePath as defaultHarborContainerComposePath,
  harborRuntimeDir as defaultHarborRuntimeDir,
  harborSandboxComposePath as defaultHarborSandboxComposePath,
  portableAgentImportPath,
  removedHarborDirectoryName,
  removedHarborPackageName,
  rootDir as defaultRootDir,
  terminalBenchDataset
} from "./bench-common.mjs";
import { sigmaManifest } from "./lib/sigma-manifest.mjs";

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
    provider: sigmaManifest.evaluation.provider,
    model: sigmaManifest.evaluation.model,
    maxTurns: 200,
    commandTimeoutSec: 180,
    validationMode: "auto",
    executionMode: "container",
    agentCliTarball,
    agentImportPath: portableAgentImportPath,
    env: {}
  };
}

function runtimeReadme(agentCliTarball, controlImage) {
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

Container execution loads a three-service Compose overlay with isolated roles:

- \`sigma-control\` holds the packaged CLI and provider credential, and shares only the task workspace with \`main\`.
- \`sigma-oci-broker\` is the only service with the Docker/Podman socket. It attests the unique Compose \`main\` target before every framed broker request.
- \`main\` receives only the read-only native execution helper and the shared workspace. It never receives the agent package, provider credential, or engine socket.

The control/broker image is \`${controlImage}\`. The adapter rejects a missing sidecar capability or a changed target identity; container mode never falls back to execution in the control or host process. Evaluation output is never passed back into the solving session.

Sandboxed execution instead loads only the minimal \`main\` hardening overlay. It does not create the control or broker services and does not mount the container-engine socket.
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
  const containerComposeSourcePath = options.containerComposeSourcePath
    ? path.resolve(options.containerComposeSourcePath)
    : path.join(rootDir, "portable", "harbor", "docker-compose-sigma-container.yaml");
  const brokerSourcePath = options.brokerSourcePath
    ? path.resolve(options.brokerSourcePath)
    : path.join(rootDir, "portable", "harbor", "sigma-oci-broker.mjs");
  const sandboxComposePath = options.harborRuntimeDir || options.artifactsDir
    ? path.join(harborRuntimeDir, "docker-compose-sigma-sandbox.yaml")
    : defaultHarborSandboxComposePath;
  const containerComposePath = options.harborRuntimeDir || options.artifactsDir
    ? path.join(harborRuntimeDir, "docker-compose-sigma-container.yaml")
    : defaultHarborContainerComposePath;
  const agentCliTarball = resolveAgentCliTarball(rootDir, artifactsDir, env, options);
  const controlImage = options.controlImage ?? env.SIGMA_HARBOR_CONTROL_IMAGE
    ?? "node:22-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3";
  const engineSocket = options.containerEngineSocket
    ?? env.SIGMA_CONTAINER_ENGINE_SOCKET
    ?? "/var/run/docker.sock";

  if (!existsSync(sourcePath)) {
    throw new Error(`Portable Harbor runtime source is missing: ${sourcePath}`);
  }
  if (!existsSync(sandboxComposeSourcePath)) {
    throw new Error(`Portable Harbor sandbox Compose overlay is missing: ${sandboxComposeSourcePath}`);
  }
  if (!existsSync(containerComposeSourcePath)) {
    throw new Error(`Portable Harbor container Compose overlay is missing: ${containerComposeSourcePath}`);
  }
  if (!existsSync(brokerSourcePath)) {
    throw new Error(`Portable Harbor OCI broker source is missing: ${brokerSourcePath}`);
  }
  if (!existsSync(agentCliTarball)) {
    throw new Error(`Packaged agent CLI is missing: ${agentCliTarball}. Run pnpm package:agent-cli first.`);
  }

  const sourceText = await readFile(sourcePath, "utf8");
  const sandboxComposeText = await readFile(sandboxComposeSourcePath, "utf8");
  const containerComposeTemplate = await readFile(containerComposeSourcePath, "utf8");
  const brokerSourceText = await readFile(brokerSourcePath, "utf8");
  const agentCliSha256 = createHash("sha256")
    .update(await readFile(agentCliTarball))
    .digest("hex");
  const renderedBrokerSourceText = brokerSourceText.replaceAll(
    "__SIGMA_AGENT_CLI_SHA256__",
    agentCliSha256
  );
  assertNoRemovedHarborAdapter(sourceText, "Portable Harbor runtime source");
  assertNoRemovedHarborAdapter(renderedBrokerSourceText, "Portable Harbor OCI broker source");

  await rm(harborRuntimeDir, { recursive: true, force: true });
  await mkdir(harborRuntimeDir, { recursive: true });

  const runtimePath = path.join(harborRuntimeDir, "sigma_harbor_agent.py");
  const brokerPath = path.join(harborRuntimeDir, "sigma-oci-broker.mjs");
  const dockerPath = (value) => path.resolve(value).replaceAll("\\", "/");
  const containerComposeText = containerComposeTemplate
    .replaceAll("__SIGMA_AGENT_CLI_TARBALL__", JSON.stringify(dockerPath(agentCliTarball)))
    .replaceAll("__SIGMA_OCI_BROKER_SOURCE__", JSON.stringify(dockerPath(brokerPath)))
    .replaceAll("__SIGMA_CONTAINER_ENGINE_SOCKET__", JSON.stringify(engineSocket.replaceAll("\\", "/")))
    .replaceAll("__SIGMA_CONTROL_IMAGE__", JSON.stringify(controlImage));
  for (const placeholder of [
    "__SIGMA_AGENT_CLI_TARBALL__", "__SIGMA_OCI_BROKER_SOURCE__",
    "__SIGMA_CONTAINER_ENGINE_SOCKET__", "__SIGMA_CONTROL_IMAGE__"
  ]) {
    if (containerComposeText.includes(placeholder)) {
      throw new Error(`Portable Harbor Compose placeholder was not rendered: ${placeholder}`);
    }
  }
  if (sandboxComposeText.includes("__SIGMA_")) {
    throw new Error("Portable Harbor sandbox Compose overlay must not require OCI package placeholders.");
  }
  await writeFile(runtimePath, sourceText, "utf8");
  if (renderedBrokerSourceText.includes("__SIGMA_AGENT_CLI_SHA256__")) {
    throw new Error("Portable Harbor broker package digest placeholder was not rendered.");
  }
  await writeFile(brokerPath, renderedBrokerSourceText, "utf8");
  await writeFile(sandboxComposePath, sandboxComposeText, "utf8");
  await writeFile(containerComposePath, containerComposeText, "utf8");

  const k5Config = buildHarborJobConfig(
    {
      ...baseBenchmarkOptions(agentCliTarball),
      mode: "k",
      k: 5,
      harborSandboxComposePath: sandboxComposePath,
      harborContainerComposePath: containerComposePath
    },
    path.join(harborRuntimeDir, "jobs", "deepseek-k5")
  );
  const readmeText = runtimeReadme(agentCliTarball, controlImage);
  const k5ConfigText = `${JSON.stringify(k5Config, null, 2)}\n`;

  assertNoRemovedHarborAdapter(readmeText, "Portable Harbor runtime README");
  assertNoRemovedHarborAdapter(k5ConfigText, "Portable Harbor k5 JobConfig");

  await writeFile(path.join(harborRuntimeDir, "README.md"), readmeText, "utf8");
  await writeFile(path.join(harborRuntimeDir, "jobconfig.deepseek.k5.json"), k5ConfigText, "utf8");

  return {
    artifactsDir,
    harborRuntimeDir,
    runtimePath,
    brokerPath,
    sandboxComposePath,
    containerComposePath,
    agentCliTarball,
    controlImage,
    engineSocket,
    k5ConfigPath: path.join(harborRuntimeDir, "jobconfig.deepseek.k5.json")
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
