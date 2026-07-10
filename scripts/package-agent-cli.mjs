import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { chmod, cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

export const defaultRootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const pinnedNodeVersion = "v26.4.0";
export const supportedTargetPlatforms = new Set(["linux", "win32"]);
export const supportedTargetArchitectures = new Set(["x64", "arm64"]);
const require = createRequire(import.meta.url);

export function normalizeTargetArch(value = "x64") {
  const targetArch = String(value || "x64").trim();
  if (!supportedTargetArchitectures.has(targetArch)) {
    throw new Error(`AGENT_TARGET_ARCH must be one of: ${[...supportedTargetArchitectures].join(", ")}.`);
  }
  return targetArch;
}

export function normalizeTargetPlatform(value = "linux") {
  const targetPlatform = String(value || "linux").trim();
  if (!supportedTargetPlatforms.has(targetPlatform)) {
    throw new Error(`AGENT_TARGET_PLATFORM must be one of: ${[...supportedTargetPlatforms].join(", ")}.`);
  }
  return targetPlatform;
}

function resolvePlatformArch(targetPlatform = "linux", targetArch = "x64") {
  const platformValue = String(targetPlatform || "linux").trim();
  if (supportedTargetPlatforms.has(platformValue)) {
    return {
      targetPlatform: normalizeTargetPlatform(platformValue),
      targetArch: normalizeTargetArch(targetArch)
    };
  }

  return {
    targetPlatform: "linux",
    targetArch: normalizeTargetArch(platformValue)
  };
}

export function agentCliBundleName(targetPlatform = "linux", targetArch = "x64") {
  const resolved = resolvePlatformArch(targetPlatform, targetArch);
  return `agent-cli-${resolved.targetPlatform}-${resolved.targetArch}`;
}

export function nodeRuntimeTarballName(targetArch = "x64") {
  return `node-${pinnedNodeVersion}-linux-${normalizeTargetArch(targetArch)}.tar.xz`;
}

export function defaultNodeRuntimeTarballPath(artifactsDir, targetArch = "x64") {
  return path.join(artifactsDir, "cache", nodeRuntimeTarballName(targetArch));
}

export function nodeRuntimeArchiveName(targetPlatform = "linux", targetArch = "x64") {
  const resolved = resolvePlatformArch(targetPlatform, targetArch);
  if (resolved.targetPlatform === "linux") return nodeRuntimeTarballName(resolved.targetArch);
  return `node-${pinnedNodeVersion}-win-${resolved.targetArch}.zip`;
}

export function defaultNodeRuntimeArchivePath(artifactsDir, targetPlatform = "linux", targetArch = "x64") {
  const resolved = resolvePlatformArch(targetPlatform, targetArch);
  if (resolved.targetPlatform === "linux") return defaultNodeRuntimeTarballPath(artifactsDir, resolved.targetArch);
  return path.join(artifactsDir, "cache", nodeRuntimeArchiveName(resolved.targetPlatform, resolved.targetArch));
}

export function nodeRuntimeDownloadUrl(targetPlatform = "linux", targetArch = "x64") {
  const resolved = resolvePlatformArch(targetPlatform, targetArch);
  return `https://nodejs.org/dist/${pinnedNodeVersion}/${nodeRuntimeArchiveName(resolved.targetPlatform, resolved.targetArch)}`;
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

export async function workspaceRuntimePackages(rootDir, entryPackage = "agent-cli") {
  const discovered = new Set();
  const pending = [entryPackage];
  while (pending.length > 0) {
    const packageName = pending.shift();
    if (discovered.has(packageName)) continue;
    const manifestPath = path.join(rootDir, "packages", packageName, "package.json");
    if (!existsSync(manifestPath)) throw new Error(`Workspace dependency '${packageName}' has no package.json.`);
    discovered.add(packageName);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    for (const [name, version] of Object.entries(manifest.dependencies ?? {})) {
      if (workspaceDependencyName(version)) pending.push(name);
    }
  }
  return [...discovered].sort((left, right) => left.localeCompare(right, "en"));
}

function packageJsonPath(packageName, ownerManifest) {
  const packageParts = packageName.split("/");
  let cursor = path.dirname(ownerManifest);
  while (true) {
    const candidates = [path.join(cursor, "node_modules", ...packageParts, "package.json")];
    if (path.basename(cursor) === "node_modules") {
      candidates.push(path.join(cursor, ...packageParts, "package.json"));
    }
    for (const candidate of candidates) {
      if (!existsSync(candidate)) continue;
      const manifest = require(candidate);
      if (manifest.name === packageName) return realpathSync(candidate);
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }

  const ownerRequire = createRequire(ownerManifest);
  let resolvedManifest;
  try {
    resolvedManifest = ownerRequire.resolve(`${packageName}/package.json`);
  } catch {
    try {
      cursor = path.dirname(ownerRequire.resolve(packageName));
      while (cursor !== path.dirname(cursor)) {
        const candidate = path.join(cursor, "package.json");
        if (existsSync(candidate)) {
          const manifest = require(candidate);
          if (manifest.name === packageName) return realpathSync(candidate);
        }
        cursor = path.dirname(cursor);
      }
    } catch { /* dependency may expose import-only entry points */ }
  }
  if (!resolvedManifest) throw new Error(`Could not locate package root for dependency ${packageName}`);
  return realpathSync(resolvedManifest);
}

function targetMatches(values, target) {
  if (!Array.isArray(values) || values.length === 0) return true;
  const denied = values.filter((value) => typeof value === "string" && value.startsWith("!")).map((value) => value.slice(1));
  const allowed = values.filter((value) => typeof value === "string" && !value.startsWith("!"));
  return !denied.includes(target) && (allowed.length === 0 || allowed.includes(target));
}

function compatiblePackage(manifest, targetPlatform, targetArch) {
  const libc = targetPlatform === "linux" ? "glibc" : "none";
  return targetMatches(manifest.os, targetPlatform)
    && targetMatches(manifest.cpu, targetArch)
    && targetMatches(manifest.libc, libc);
}

async function dependencyNode(packageName, ownerManifest, targetPlatform, targetArch, cache, optional = false) {
  let manifestPath;
  try { manifestPath = packageJsonPath(packageName, ownerManifest); }
  catch (error) { if (optional) return undefined; throw error; }
  if (cache.has(manifestPath)) return cache.get(manifestPath);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (!compatiblePackage(manifest, targetPlatform, targetArch)) return undefined;
  const node = { name: packageName, version: String(manifest.version ?? "0.0.0"), manifestPath, sourceDir: path.dirname(manifestPath), dependencies: [] };
  cache.set(manifestPath, node);
  const required = Object.keys(manifest.dependencies ?? {});
  const optionalNames = Object.keys(manifest.optionalDependencies ?? {});
  for (const name of required) {
    const child = await dependencyNode(name, manifestPath, targetPlatform, targetArch, cache);
    if (child) node.dependencies.push(child);
  }
  for (const name of optionalNames) {
    const child = await dependencyNode(name, manifestPath, targetPlatform, targetArch, cache, true);
    if (child && !node.dependencies.includes(child)) node.dependencies.push(child);
  }
  return node;
}

async function runtimeDependencyGraph(rootDir, packageNames, targetPlatform, targetArch) {
  const cache = new Map();
  const roots = [];
  for (const workspacePackage of packageNames) {
    const ownerManifest = path.join(rootDir, "packages", workspacePackage, "package.json");
    const manifest = JSON.parse(await readFile(ownerManifest, "utf8"));
    for (const [name, version] of Object.entries(manifest.dependencies ?? {})) {
      if (workspaceDependencyName(version)) continue;
      const node = await dependencyNode(name, ownerManifest, targetPlatform, targetArch, cache);
      if (node && !roots.includes(node)) roots.push(node);
    }
  }
  return { roots, nodes: [...cache.values()] };
}

async function deployDependency(node, targetDir, preferred, deployed) {
  const destinationKey = `${targetDir}\0${node.name}@${node.version}`;
  if (deployed.has(destinationKey)) return;
  deployed.add(destinationKey);
  await rm(targetDir, { recursive: true, force: true });
  await mkdir(path.dirname(targetDir), { recursive: true });
  await cp(node.sourceDir, targetDir, {
    recursive: true,
    filter: (source) => {
      const relative = path.relative(node.sourceDir, source);
      return relative === "" || relative.split(path.sep)[0] !== "node_modules";
    }
  });
  for (const child of node.dependencies) {
    if (preferred.get(child.name)?.version === child.version) continue;
    await deployDependency(child, path.join(targetDir, "node_modules", child.name), preferred, deployed);
  }
}

async function deployRuntimeDependencies(rootDir, packageNames, targetNodeModules, targetPlatform, targetArch) {
  const graph = await runtimeDependencyGraph(rootDir, packageNames, targetPlatform, targetArch);
  const preferred = new Map();
  for (const node of [...graph.roots, ...graph.nodes]) if (!preferred.has(node.name)) preferred.set(node.name, node);
  const deployed = new Set();
  for (const node of [...preferred.values()].sort((left, right) => left.name.localeCompare(right.name, "en"))) {
    await deployDependency(node, path.join(targetNodeModules, node.name), preferred, deployed);
  }
  if (preferred.has("@opentui/core")) {
    const nativeName = `@opentui/core-${targetPlatform}-${targetArch}`;
    if (!preferred.has(nativeName) || !existsSync(path.join(targetNodeModules, nativeName, "package.json"))) {
      throw new Error(`OpenTUI native runtime is missing for ${targetPlatform}-${targetArch}: ${nativeName}`);
    }
  }
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

function psQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function runPowerShell(script, errorMessage) {
  const candidates = process.platform === "win32"
    ? ["powershell.exe", "powershell", "pwsh"]
    : ["pwsh", "powershell"];
  let last = null;
  for (const command of candidates) {
    const result = spawnSync(command, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
      encoding: "utf8"
    });
    last = result;
    if (!result.error && result.status === 0) return result;
  }
  throw new Error([
    errorMessage,
    last?.error?.message ? `error: ${last.error.message}` : null,
    last?.stdout ? `stdout:\n${last.stdout}` : null,
    last?.stderr ? `stderr:\n${last.stderr}` : null
  ].filter(Boolean).join("\n"));
}

function runZip(args, errorMessage, cwd) {
  const result = spawnSync("zip", args, {
    cwd,
    encoding: "utf8"
  });

  if (result.status !== 0) {
    throw new Error(`${errorMessage}: ${result.stderr || result.stdout}`);
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

async function resolveNodeRuntimeArchive(rootDir, artifactsDir, targetPlatform, targetArch, env, downloader = defaultDownloader) {
  if (env.NODE_RUNTIME_ARCHIVE || (targetPlatform === "linux" && env.NODE_RUNTIME_TARBALL)) {
    const configuredPath = path.resolve(rootDir, env.NODE_RUNTIME_ARCHIVE ?? env.NODE_RUNTIME_TARBALL);
    if (!existsSync(configuredPath)) {
      throw new Error(`NODE_RUNTIME_ARCHIVE does not exist: ${configuredPath}`);
    }
    return {
      runtimeArchive: configuredPath,
      runtimeTarball: targetPlatform === "linux" ? configuredPath : null,
      cachePath: configuredPath,
      runtimeUrl: null,
      downloaded: false,
      source: "env"
    };
  }

  const cachedPath = defaultNodeRuntimeArchivePath(artifactsDir, targetPlatform, targetArch);
  if (existsSync(cachedPath)) {
    return {
      runtimeArchive: cachedPath,
      runtimeTarball: targetPlatform === "linux" ? cachedPath : null,
      cachePath: cachedPath,
      runtimeUrl: nodeRuntimeDownloadUrl(targetPlatform, targetArch),
      downloaded: false,
      source: "cache"
    };
  }

  const runtimeUrl = nodeRuntimeDownloadUrl(targetPlatform, targetArch);
  try {
    await downloader(runtimeUrl, cachedPath, { targetArch, pinnedNodeVersion });
  } catch (error) {
    throw new Error(
      [
        `Failed to download Node runtime ${runtimeUrl} to ${cachedPath}.`,
        `${error instanceof Error ? error.message : String(error)}`,
        `Set NODE_RUNTIME_ARCHIVE to a pre-downloaded Node runtime archive or pre-fill the cache for offline packaging.`
      ].join("\n"),
      { cause: error }
    );
  }
  if (!existsSync(cachedPath)) {
    throw new Error(`Downloader completed but did not create ${cachedPath}`);
  }
  return {
    runtimeArchive: cachedPath,
    runtimeTarball: targetPlatform === "linux" ? cachedPath : null,
    cachePath: cachedPath,
    runtimeUrl,
    downloaded: true,
    source: "download"
  };
}

async function findFileByName(rootDir, fileName) {
  const entries = await readdir(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(rootDir, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === fileName.toLowerCase()) return entryPath;
    if (entry.isDirectory()) {
      const found = await findFileByName(entryPath, fileName);
      if (found) return found;
    }
  }
  return null;
}

async function extractZipArchive(archive, destination) {
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  try {
    runPowerShell(
      `$ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath ${psQuote(archive)} -DestinationPath ${psQuote(destination)} -Force`,
      `failed to extract ${archive} with PowerShell Expand-Archive`
    );
    return;
  } catch (powerShellError) {
    const result = spawnSync("unzip", ["-q", archive, "-d", destination], { encoding: "utf8" });
    if (result.status === 0) return;
    throw new Error([
      `failed to extract ${archive} as zip archive`,
      powerShellError instanceof Error ? powerShellError.message : String(powerShellError),
      result.stderr || result.stdout
    ].filter(Boolean).join("\n"), { cause: powerShellError });
  }
}

function inspectBundledNodeVersion(nodePath) {
  const version = spawnSync(nodePath, ["--version"], { encoding: "utf8" });
  if (version.status !== 0) {
    throw new Error(`bundled node did not run --version: ${version.stderr || version.stdout}`);
  }
  return (version.stdout || version.stderr).trim();
}

async function copyNodeRuntime(rootDir, artifactsDir, bundleDir, targetPlatform, targetArch, env, downloader, nodeVersionProbe) {
  const resolvedRuntime = await resolveNodeRuntimeArchive(rootDir, artifactsDir, targetPlatform, targetArch, env, downloader);
  const extractDir = path.join(artifactsDir, `.node-runtime-${targetPlatform}-${targetArch}-${process.pid}`);
  await rm(extractDir, { recursive: true, force: true });
  await mkdir(extractDir, { recursive: true });

  try {
    if (targetPlatform === "linux") {
      const nodeEntry = findNodeTarEntry(listTarEntries(resolvedRuntime.runtimeArchive, rootDir));
      if (!nodeEntry) {
        throw new Error(`Node runtime tarball did not contain node-v*/bin/node: ${resolvedRuntime.runtimeArchive}`);
      }

      runTar(
        ["-xf", resolvedRuntime.runtimeArchive, "-C", extractDir, nodeEntry],
        "failed to extract node-v*/bin/node from Node runtime tarball with tar",
        rootDir
      );
      const nodePath = tarEntryToLocalPath(extractDir, nodeEntry);
      const bundledNodePath = path.join(bundleDir, "bin", "node");
      await cp(nodePath, bundledNodePath);
      await chmod(bundledNodePath, 0o755).catch(() => undefined);
      let nodeVersionOutput = null;
      if (process.platform !== "win32") {
        nodeVersionOutput = await nodeVersionProbe(bundledNodePath);
        if (nodeVersionOutput !== pinnedNodeVersion) {
          throw new Error(`bundled node version ${nodeVersionOutput} does not match pinned ${pinnedNodeVersion}`);
        }
      }
      return { ...resolvedRuntime, bundledNodePath, nodeVersionOutput };
    }

    await extractZipArchive(resolvedRuntime.runtimeArchive, extractDir);
    const nodePath = await findFileByName(extractDir, "node.exe");
    if (!nodePath) {
      throw new Error(`Node runtime archive did not contain node.exe: ${resolvedRuntime.runtimeArchive}`);
    }
    const bundledNodePath = path.join(bundleDir, "bin", "node.exe");
    await cp(nodePath, bundledNodePath);
    let nodeVersionOutput = null;
    if (process.platform === "win32") {
      nodeVersionOutput = await nodeVersionProbe(bundledNodePath);
      if (nodeVersionOutput !== pinnedNodeVersion) {
        throw new Error(`bundled node version ${nodeVersionOutput} does not match pinned ${pinnedNodeVersion}`);
      }
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

if [ "\${1:-}" = "tui" ]; then
  exec "$NODE" --experimental-ffi --disable-warning=ExperimentalWarning "$SCRIPT_DIR/../packages/agent-cli/dist/index.js" "$@"
fi
exec "$NODE" "$SCRIPT_DIR/../packages/agent-cli/dist/index.js" "$@"
`;
}

function createAgentCmdWrapper() {
  return `@echo off
setlocal
set "SCRIPT_DIR=%~dp0"
set "NODE_EXE=%SCRIPT_DIR%node.exe"
if exist "%NODE_EXE%" goto run
where node >nul 2>nul
if errorlevel 1 (
  echo Sigma agent cannot start: no bundled node.exe and no system node found. 1>&2
  exit /b 127
)
for /f "delims=" %%i in ('where node') do (
  set "NODE_EXE=%%i"
  goto run
)
:run
if /I "%~1"=="tui" goto run_tui
"%NODE_EXE%" "%SCRIPT_DIR%..\\packages\\agent-cli\\dist\\index.js" %*
exit /b %ERRORLEVEL%
:run_tui
"%NODE_EXE%" --experimental-ffi --disable-warning=ExperimentalWarning "%SCRIPT_DIR%..\\packages\\agent-cli\\dist\\index.js" %*
exit /b %ERRORLEVEL%
`;
}

function createBundleReadme(targetPlatform, targetArch, nodeRuntime) {
  const isWindows = targetPlatform === "win32";
  const agent = isWindows ? String.raw`.\bin\agent.cmd` : "./bin/agent";
  const workspace = isWindows ? String.raw`D:\path\to\repo` : "/path/to/repo";
  const platformLabel = isWindows ? `Windows ${targetArch}` : `Linux ${targetArch}`;
  return `# Sigma Code CLI Bundle

This archive contains a portable Sigma Code CLI for ${platformLabel}.

## Start

\`\`\`${isWindows ? "powershell" : "sh"}
${agent} init --workspace ${workspace}
${agent} version --json
${agent} doctor --workspace ${workspace}
${agent} doctor --workspace ${workspace} --json --strict
${agent} tui --workspace ${workspace}
\`\`\`

For non-interactive use:

\`\`\`${isWindows ? "powershell" : "sh"}
${agent} run "Fix failing tests" --workspace ${workspace} --permission-mode auto
${agent} inspect "Review the architecture" --workspace ${workspace}
${agent} sessions --workspace ${workspace}
\`\`\`

The wrapper uses the bundled Node runtime when available and falls back to a system \`node\` on PATH.

## Provider Keys

- DeepSeek: set \`DEEPSEEK_API_KEY\`
- GLM / Z.ai: set \`ZAI_API_KEY\`, \`GLM_API_KEY\`, or \`BIGMODEL_API_KEY\`

## Product Boundary

This bundle is the product CLI runtime. It should be used through user-facing commands such as \`version\`, \`init\`, \`doctor\`, \`tui\`, \`run\`, \`inspect\`, \`sessions\`, and \`replay\`. External benchmark adapters may launch this bundle and collect outputs after a run, but benchmark identity, verifier output, rewards, scores, and hidden test details must not be fed back into the solving agent.

## Metadata

- targetArch: ${targetArch}
- targetPlatform: ${targetPlatform}
- nodeVersion: ${pinnedNodeVersion}
- nodeRuntimeSource: ${nodeRuntime.source}
`;
}

function archivePathForTarget(artifactsDir, bundleName, targetPlatform) {
  return path.join(artifactsDir, targetPlatform === "win32" ? `${bundleName}.zip` : `${bundleName}.tgz`);
}

function createBundleArchive(outputPath, artifactsDir, bundleName, targetPlatform, rootDir) {
  if (targetPlatform === "linux") {
    runTar(["-czf", outputPath, "-C", artifactsDir, bundleName], "failed to create agent-cli Linux tarball with tar", rootDir);
    return;
  }

  const bundleDir = path.join(artifactsDir, bundleName);
  try {
    runPowerShell(
      `$ErrorActionPreference = 'Stop'; Compress-Archive -LiteralPath ${psQuote(bundleDir)} -DestinationPath ${psQuote(outputPath)} -Force`,
      "failed to create agent-cli Windows zip with PowerShell Compress-Archive"
    );
  } catch (powerShellError) {
    runZip(["-qr", outputPath, bundleName], [
      "failed to create agent-cli Windows zip",
      powerShellError instanceof Error ? powerShellError.message : String(powerShellError)
    ].join("\n"), artifactsDir);
  }
}

function parsePackageArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--target-platform" && next) {
      options.targetPlatform = next;
      index += 1;
    } else if (arg === "--target-arch" && next) {
      options.targetArch = next;
      index += 1;
    }
  }
  return options;
}

export async function packageAgentCli(options = {}) {
  const rootDir = options.rootDir ? path.resolve(options.rootDir) : defaultRootDir;
  const env = options.env ?? process.env;
  const targetPlatform = normalizeTargetPlatform(env.AGENT_TARGET_PLATFORM ?? options.targetPlatform ?? "linux");
  const targetArch = normalizeTargetArch(env.AGENT_TARGET_ARCH ?? options.targetArch ?? "x64");
  const artifactsDir = options.artifactsDir ? path.resolve(options.artifactsDir) : path.join(rootDir, ".artifacts");
  const bundleName = agentCliBundleName(targetPlatform, targetArch);
  const bundleDir = path.join(artifactsDir, bundleName);
  const outputPath = archivePathForTarget(artifactsDir, bundleName, targetPlatform);
  const packages = await workspaceRuntimePackages(rootDir);

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

  for (const packageName of packages.filter((name) => name !== "agent-cli")) {
    await copyRuntimePackage(rootDir, packageName, path.join(bundleDir, "node_modules"));
  }
  await deployRuntimeDependencies(
    rootDir, packages, path.join(bundleDir, "node_modules"), targetPlatform, targetArch
  );

  const nodeRuntime = await copyNodeRuntime(
    rootDir,
    artifactsDir,
    bundleDir,
    targetPlatform,
    targetArch,
    env,
    options.downloader,
    options.nodeVersionProbe ?? inspectBundledNodeVersion
  );

  await writeFile(
    path.join(bundleDir, "package.json"),
    `${JSON.stringify(
      {
        name: `sigma-agent-cli-${targetPlatform}-${targetArch}`,
        version: "2.0.0",
        private: true,
        type: "module",
        bin: {
          agent: targetPlatform === "win32" ? "./bin/agent.cmd" : "./bin/agent"
        }
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  if (targetPlatform === "win32") {
    await writeFile(path.join(bundleDir, "bin", "agent.cmd"), createAgentCmdWrapper(), "utf8");
  } else {
    const agentBin = path.join(bundleDir, "bin", "agent");
    await writeFile(agentBin, createAgentWrapper(), "utf8");
    await chmod(agentBin, 0o755).catch(() => undefined);
  }

  await writeFile(
    path.join(bundleDir, "README.md"),
    createBundleReadme(targetPlatform, targetArch, nodeRuntime),
    "utf8"
  );
  await writeFile(
    path.join(bundleDir, "package-metadata.json"),
    `${JSON.stringify(
      {
        targetPlatform,
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

  createBundleArchive(outputPath, artifactsDir, bundleName, targetPlatform, rootDir);
  return { artifactsDir, bundleName, bundleDir, outputPath, targetPlatform, targetArch, ...nodeRuntime };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await packageAgentCli(parsePackageArgs(process.argv.slice(2)));
    console.log(`Created ${path.relative(defaultRootDir, result.outputPath)}`);
    console.log(`Bundled Node from ${path.relative(defaultRootDir, result.runtimeArchive)}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
