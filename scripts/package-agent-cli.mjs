import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

export const defaultRootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const pinnedNodeVersion = "v22.16.0";
export const supportedTargetArchitectures = new Set(["x64", "arm64"]);
const require = createRequire(import.meta.url);

const packages = ["agent-ai", "agent-core", "agent-tui", "agent-cli"];

export function normalizeTargetArch(value = "x64") {
  const targetArch = String(value || "x64").trim();
  if (!supportedTargetArchitectures.has(targetArch)) {
    throw new Error(`AGENT_TARGET_ARCH must be one of: ${[...supportedTargetArchitectures].join(", ")}.`);
  }
  return targetArch;
}

export function agentCliBundleName(targetArch = "x64") {
  return `agent-cli-linux-${normalizeTargetArch(targetArch)}`;
}

export function nodeRuntimeTarballName(targetArch = "x64") {
  return `node-${pinnedNodeVersion}-linux-${normalizeTargetArch(targetArch)}.tar.xz`;
}

export function defaultNodeRuntimeTarballPath(artifactsDir, targetArch = "x64") {
  return path.join(artifactsDir, "cache", nodeRuntimeTarballName(targetArch));
}

export function nodeRuntimeDownloadUrl(targetArch = "x64") {
  return `https://nodejs.org/dist/${pinnedNodeVersion}/${nodeRuntimeTarballName(targetArch)}`;
}

function assertBuiltPackage(rootDir, packageName) {
  const distDir = path.join(rootDir, "packages", packageName, "dist");
  if (!existsSync(distDir)) {
    throw new Error(`packages/${packageName}/dist is missing. Run pnpm build first.`);
  }
}

async function copyRuntimePackage(rootDir, packageName, targetRoot) {
  const sourceRoot = path.join(rootDir, "packages", packageName);
  const targetDir = path.join(targetRoot, packageName);
  await mkdir(targetDir, { recursive: true });
  await cp(path.join(sourceRoot, "dist"), path.join(targetDir, "dist"), { recursive: true });
  await cp(path.join(sourceRoot, "package.json"), path.join(targetDir, "package.json"));
}

function workspaceDependencyName(value) {
  return typeof value === "string" && value.startsWith("workspace:");
}

async function runtimeExternalDependencies(rootDir) {
  const names = new Set();
  for (const packageName of packages) {
    const packageJson = JSON.parse(await readFile(path.join(rootDir, "packages", packageName, "package.json"), "utf8"));
    for (const [name, version] of Object.entries(packageJson.dependencies ?? {})) {
      if (!workspaceDependencyName(version)) names.add(name);
    }
  }
  return [...names].sort((a, b) => a.localeCompare(b, "en"));
}

async function copyNodeModule(rootDir, packageName, targetNodeModules) {
  const resolvePaths = [rootDir, path.join(rootDir, "packages", "agent-cli"), path.join(rootDir, "packages", "agent-core")];
  let packageJsonPath;
  try {
    packageJsonPath = require.resolve(`${packageName}/package.json`, { paths: resolvePaths });
  } catch {
    let cursor = path.dirname(require.resolve(packageName, { paths: resolvePaths }));
    while (cursor !== path.dirname(cursor)) {
      const candidate = path.join(cursor, "package.json");
      if (existsSync(candidate)) {
        packageJsonPath = candidate;
        break;
      }
      cursor = path.dirname(cursor);
    }
  }
  if (!packageJsonPath) throw new Error(`Could not locate package root for dependency ${packageName}`);
  const sourceDir = path.dirname(packageJsonPath);
  const targetDir = path.join(targetNodeModules, packageName);
  await rm(targetDir, { recursive: true, force: true });
  await mkdir(path.dirname(targetDir), { recursive: true });
  await cp(sourceDir, targetDir, { recursive: true });
}

function runTar(args, errorMessage, cwd) {
  const result = spawnSync("tar", args, {
    cwd,
    stdio: "inherit"
  });

  if (result.status !== 0) {
    throw new Error(errorMessage);
  }
}

function listTarEntries(tarball, cwd) {
  const result = spawnSync("tar", ["-tf", tarball], {
    cwd,
    encoding: "utf8"
  });

  if (result.status !== 0) {
    throw new Error(`failed to list Node runtime tarball with tar: ${result.stderr || result.stdout}`);
  }

  return result.stdout.split(/\r?\n/).filter(Boolean);
}

function findNodeTarEntry(entries) {
  return entries.find((entry) => /(^|\/)node-v[^/]+\/bin\/node$/.test(entry.replace(/\\/g, "/"))) ?? null;
}

function tarEntryToLocalPath(extractDir, entry) {
  const normalized = entry.replace(/\\/g, "/").replace(/^\.\/+/, "");
  return path.join(extractDir, ...normalized.split("/"));
}

async function defaultDownloader(url, destination) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`download failed with HTTP ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, buffer);
}

async function resolveNodeRuntimeTarball(rootDir, artifactsDir, targetArch, env, downloader = defaultDownloader) {
  if (env.NODE_RUNTIME_TARBALL) {
    const configuredPath = path.resolve(rootDir, env.NODE_RUNTIME_TARBALL);
    if (!existsSync(configuredPath)) {
      throw new Error(`NODE_RUNTIME_TARBALL does not exist: ${configuredPath}`);
    }
    return { runtimeTarball: configuredPath, cachePath: configuredPath, runtimeUrl: null, downloaded: false, source: "env" };
  }

  const cachedPath = defaultNodeRuntimeTarballPath(artifactsDir, targetArch);
  if (existsSync(cachedPath)) {
    return { runtimeTarball: cachedPath, cachePath: cachedPath, runtimeUrl: nodeRuntimeDownloadUrl(targetArch), downloaded: false, source: "cache" };
  }

  const runtimeUrl = nodeRuntimeDownloadUrl(targetArch);
  try {
    await downloader(runtimeUrl, cachedPath, { targetArch, pinnedNodeVersion });
  } catch (error) {
    throw new Error(
      [
        `Failed to download Node runtime ${runtimeUrl} to ${cachedPath}.`,
        `${error instanceof Error ? error.message : String(error)}`,
        `Set NODE_RUNTIME_TARBALL to a pre-downloaded Linux Node tarball or pre-fill the cache for offline packaging.`
      ].join("\n")
    );
  }
  if (!existsSync(cachedPath)) {
    throw new Error(`Downloader completed but did not create ${cachedPath}`);
  }
  return { runtimeTarball: cachedPath, cachePath: cachedPath, runtimeUrl, downloaded: true, source: "download" };
}

async function copyNodeRuntime(rootDir, artifactsDir, bundleDir, targetArch, env, downloader) {
  const resolvedRuntime = await resolveNodeRuntimeTarball(rootDir, artifactsDir, targetArch, env, downloader);
  const runtimeTarball = resolvedRuntime.runtimeTarball;
  const extractDir = path.join(artifactsDir, `.node-runtime-${targetArch}-${process.pid}`);
  await rm(extractDir, { recursive: true, force: true });
  await mkdir(extractDir, { recursive: true });

  try {
    const nodeEntry = findNodeTarEntry(listTarEntries(runtimeTarball, rootDir));
    if (!nodeEntry) {
      throw new Error(`Node runtime tarball did not contain node-v*/bin/node: ${runtimeTarball}`);
    }

    runTar(
      ["-xf", runtimeTarball, "-C", extractDir, nodeEntry],
      "failed to extract node-v*/bin/node from Node runtime tarball with tar",
      rootDir
    );
    const nodePath = tarEntryToLocalPath(extractDir, nodeEntry);
    const bundledNodePath = path.join(bundleDir, "bin", "node");
    await cp(nodePath, bundledNodePath);
    await chmod(bundledNodePath, 0o755).catch(() => undefined);
    let nodeVersionOutput = null;
    if (process.platform !== "win32") {
      const version = spawnSync(bundledNodePath, ["--version"], { encoding: "utf8" });
      if (version.status !== 0) {
        throw new Error(`bundled node did not run --version: ${version.stderr || version.stdout}`);
      }
      nodeVersionOutput = (version.stdout || version.stderr).trim();
    }
    return { ...resolvedRuntime, bundledNodePath, nodeVersionOutput };
  } finally {
    await rm(extractDir, { recursive: true, force: true });
  }
}

function createAgentWrapper() {
  return `#!/usr/bin/env sh
set -eu
PRG="$0"
if command -v readlink >/dev/null 2>&1; then
  RESOLVED=$(readlink -f "$PRG" 2>/dev/null || true)
  if [ -n "$RESOLVED" ]; then
    PRG="$RESOLVED"
  fi
fi
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$PRG")" && pwd)

if [ -x "$SCRIPT_DIR/node" ]; then
  NODE="$SCRIPT_DIR/node"
elif command -v node >/dev/null 2>&1; then
  NODE="$(command -v node)"
else
  echo "Sigma agent cannot start: no bundled node and no system node found." >&2
  exit 127
fi

exec "$NODE" "$SCRIPT_DIR/../packages/agent-cli/dist/index.js" "$@"
`;
}

export async function packageAgentCli(options = {}) {
  const rootDir = options.rootDir ? path.resolve(options.rootDir) : defaultRootDir;
  const env = options.env ?? process.env;
  const targetArch = normalizeTargetArch(env.AGENT_TARGET_ARCH ?? options.targetArch ?? "x64");
  const artifactsDir = options.artifactsDir ? path.resolve(options.artifactsDir) : path.join(rootDir, ".artifacts");
  const bundleName = agentCliBundleName(targetArch);
  const bundleDir = path.join(artifactsDir, bundleName);
  const outputPath = path.join(artifactsDir, `${bundleName}.tgz`);

  for (const packageName of packages) {
    assertBuiltPackage(rootDir, packageName);
  }

  await rm(bundleDir, { recursive: true, force: true });
  await rm(outputPath, { force: true });
  await mkdir(path.join(bundleDir, "bin"), { recursive: true });
  await mkdir(path.join(bundleDir, "packages"), { recursive: true });
  await mkdir(path.join(bundleDir, "node_modules"), { recursive: true });

  for (const packageName of packages) {
    await copyRuntimePackage(rootDir, packageName, path.join(bundleDir, "packages"));
  }

  await copyRuntimePackage(rootDir, "agent-ai", path.join(bundleDir, "node_modules"));
  await copyRuntimePackage(rootDir, "agent-core", path.join(bundleDir, "node_modules"));
  await copyRuntimePackage(rootDir, "agent-tui", path.join(bundleDir, "node_modules"));
  for (const dependency of await runtimeExternalDependencies(rootDir)) {
    await copyNodeModule(rootDir, dependency, path.join(bundleDir, "node_modules"));
  }

  const nodeRuntime = await copyNodeRuntime(rootDir, artifactsDir, bundleDir, targetArch, env, options.downloader);

  await writeFile(
    path.join(bundleDir, "package.json"),
    `${JSON.stringify(
      {
        name: `sigma-agent-cli-linux-${targetArch}`,
        version: "0.1.0",
        private: true,
        type: "module",
        bin: {
          agent: "./bin/agent"
        }
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const agentBin = path.join(bundleDir, "bin", "agent");
  await writeFile(agentBin, createAgentWrapper(), "utf8");
  await chmod(agentBin, 0o755).catch(() => undefined);

  await writeFile(
    path.join(bundleDir, "README.md"),
    "Bundled Sigma agent CLI artifact for Linux Harbor task containers. Extract it and run bin/agent.\n",
    "utf8"
  );
  await writeFile(
    path.join(bundleDir, "package-metadata.json"),
    `${JSON.stringify(
      {
        targetArch,
        node: {
          version: pinnedNodeVersion,
          runtimeUrl: nodeRuntime.runtimeUrl,
          cachePath: nodeRuntime.cachePath,
          runtimeTarball: nodeRuntime.runtimeTarball,
          downloaded: nodeRuntime.downloaded,
          source: nodeRuntime.source,
          versionOutput: nodeRuntime.nodeVersionOutput
        }
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  runTar(["-czf", outputPath, "-C", artifactsDir, bundleName], "failed to create agent-cli Linux tarball with tar", rootDir);
  return { artifactsDir, bundleName, bundleDir, outputPath, targetArch, ...nodeRuntime };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await packageAgentCli();
    console.log(`Created ${path.relative(defaultRootDir, result.outputPath)}`);
    console.log(`Bundled Node from ${path.relative(defaultRootDir, result.runtimeTarball)}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
