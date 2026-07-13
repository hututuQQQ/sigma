import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { chmod, cp, lstat, mkdir, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

export const defaultRootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const pinnedNodeVersion = "v26.4.0";
export const supportedTargetPlatforms = new Set(["linux", "win32"]);
export const supportedTargetArchitectures = new Set(["x64"]);
export const supportedReleaseTargets = new Set(["linux-x64", "win32-x64"]);
export const v3PortablePackages = Object.freeze([
  "agent-execution",
  "agent-code-intel",
  "agent-checkpoint",
  "agent-extensions"
]);
const require = createRequire(import.meta.url);
const portableLanguageAssets = Object.freeze({
  typescriptServer: "node_modules/agent-code-intel/dist/typescript-server.mjs",
  typescriptEngine: "node_modules/typescript/lib/typescript.js",
  pyrightServer: "node_modules/pyright/langserver.index.js"
});

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

function assertReleaseTarget(targetPlatform, targetArch) {
  const target = `${targetPlatform}-${targetArch}`;
  if (!supportedReleaseTargets.has(target)) {
    throw new Error(`Unsupported Sigma Code release target '${target}'. Tier 1 targets: ${[...supportedReleaseTargets].join(", ")}.`);
  }
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

async function workspaceRelease(rootDir) {
  const candidates = [path.join(rootDir, "package.json"), path.join(rootDir, "packages", "agent-cli", "package.json")];
  for (const manifestPath of candidates) {
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const version = String(manifest.version ?? "");
    if (version) return { version, isV3: /^3\./.test(version) };
  }
  throw new Error(`Could not determine the Sigma Code release version below ${rootDir}.`);
}

async function v3RuntimePackages(rootDir, discovered, isV3) {
  if (!isV3) return discovered;
  const result = new Set(discovered);
  for (const packageName of v3PortablePackages) {
    const manifestPath = path.join(rootDir, "packages", packageName, "package.json");
    if (!existsSync(manifestPath)) throw new Error(`V3 portable package '${packageName}' is missing.`);
    result.add(packageName);
  }
  return [...result].sort((left, right) => left.localeCompare(right, "en"));
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

function parseExpectedSha256(value, label, archiveName) {
  const line = String(value ?? "").split(/\r?\n/).find((candidate) => candidate.includes(archiveName))
    ?? String(value ?? "").trim();
  const match = line.match(/\b([a-fA-F0-9]{64})\b/);
  if (!match) throw new Error(`${label} does not contain a SHA-256 digest for ${archiveName}.`);
  return match[1].toLowerCase();
}

async function verifyNodeRuntimeArchive(nodeRuntime, env, checksumDownloader = async (url) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`download failed with HTTP ${response.status}`);
  return await response.text();
}) {
  const archiveName = path.basename(nodeRuntime.runtimeArchive);
  const configured = env.NODE_RUNTIME_SHA256;
  const sidecarPath = `${nodeRuntime.runtimeArchive}.sha256`;
  let expected;
  let verificationSource;
  if (configured) {
    expected = parseExpectedSha256(configured, "NODE_RUNTIME_SHA256", archiveName);
    verificationSource = "env";
  } else if (existsSync(sidecarPath)) {
    expected = parseExpectedSha256(await readFile(sidecarPath, "utf8"), sidecarPath, archiveName);
    verificationSource = "sidecar";
  } else if (nodeRuntime.runtimeUrl) {
    const checksumUrl = new URL("SHASUMS256.txt", nodeRuntime.runtimeUrl).href;
    expected = parseExpectedSha256(await checksumDownloader(checksumUrl), checksumUrl, archiveName);
    verificationSource = checksumUrl;
  } else {
    throw new Error([
      `No trusted SHA-256 was provided for Node runtime archive ${archiveName}.`,
      "Set NODE_RUNTIME_SHA256 or create an adjacent .sha256 sidecar."
    ].join("\n"));
  }
  const actual = await sha256File(nodeRuntime.runtimeArchive);
  if (actual !== expected) throw new Error(`Node runtime archive SHA-256 mismatch for ${archiveName}: expected ${expected}, received ${actual}.`);
  return { sha256: actual, verificationSource };
}

function sigmaExecFileName(targetPlatform) {
  return targetPlatform === "win32" ? "sigma-exec.exe" : "sigma-exec";
}

function defaultSigmaExecPath(rootDir, targetPlatform) {
  return path.join(rootDir, "native", "sigma-exec", "target", "release", sigmaExecFileName(targetPlatform));
}

async function readExecutableBytes(handle, length, position, filePath) {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  if (bytesRead !== length) {
    throw new Error(`sigma-exec has a truncated executable header: ${filePath}`);
  }
  return buffer;
}

function executableArchitecture(machine, format) {
  const architectures = format === "PE"
    ? new Map([[0x8664, "x64"], [0xaa64, "arm64"], [0x014c, "x86"]])
    : new Map([[0x003e, "x64"], [0x00b7, "arm64"], [0x0003, "x86"]]);
  return architectures.get(machine) ?? `unknown-0x${machine.toString(16).padStart(4, "0")}`;
}

export async function inspectSigmaExecBinary(filePath) {
  const handle = await open(filePath, "r");
  try {
    const prefix = await readExecutableBytes(handle, 20, 0, filePath);
    if (prefix.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
      const elfClass = prefix[4];
      const byteOrder = prefix[5];
      if (elfClass !== 2) throw new Error(`sigma-exec ELF binary must be 64-bit: ${filePath}`);
      if (byteOrder !== 1 && byteOrder !== 2) throw new Error(`sigma-exec ELF binary has an invalid byte order: ${filePath}`);
      const elfType = byteOrder === 1 ? prefix.readUInt16LE(16) : prefix.readUInt16BE(16);
      if (elfType !== 2 && elfType !== 3) {
        throw new Error(`sigma-exec ELF binary is not an executable or shared-object image: ${filePath}`);
      }
      const machine = byteOrder === 1 ? prefix.readUInt16LE(18) : prefix.readUInt16BE(18);
      return {
        format: "ELF",
        machine: `0x${machine.toString(16).padStart(4, "0")}`,
        targetPlatform: "linux",
        targetArch: executableArchitecture(machine, "ELF")
      };
    }
    if (prefix[0] === 0x4d && prefix[1] === 0x5a) {
      const dosHeader = await readExecutableBytes(handle, 64, 0, filePath);
      const peOffset = dosHeader.readUInt32LE(0x3c);
      if (peOffset < 64) throw new Error(`sigma-exec has an invalid PE header offset: ${filePath}`);
      const peHeader = await readExecutableBytes(handle, 26, peOffset, filePath);
      if (!peHeader.subarray(0, 4).equals(Buffer.from([0x50, 0x45, 0x00, 0x00]))) {
        throw new Error(`sigma-exec has an invalid PE signature: ${filePath}`);
      }
      const machine = peHeader.readUInt16LE(4);
      const optionalHeaderSize = peHeader.readUInt16LE(20);
      const characteristics = peHeader.readUInt16LE(22);
      const optionalHeaderMagic = peHeader.readUInt16LE(24);
      if (optionalHeaderSize < 2 || (characteristics & 0x0002) === 0 || optionalHeaderMagic !== 0x020b) {
        throw new Error(`sigma-exec PE binary is not a 64-bit executable image: ${filePath}`);
      }
      return {
        format: "PE",
        machine: `0x${machine.toString(16).padStart(4, "0")}`,
        targetPlatform: "win32",
        targetArch: executableArchitecture(machine, "PE")
      };
    }
    throw new Error(`sigma-exec is not a recognized ELF or PE executable: ${filePath}`);
  } finally {
    await handle.close();
  }
}

async function copySigmaExec(rootDir, bundleDir, targetPlatform, targetArch, env) {
  const configured = env.SIGMA_EXEC_BINARY;
  const source = configured ? path.resolve(rootDir, configured) : defaultSigmaExecPath(rootDir, targetPlatform);
  if (!existsSync(source)) {
    throw new Error([
      `The required ${sigmaExecFileName(targetPlatform)} broker is missing: ${source}`,
      "Run pnpm build:native:sigma-exec on the target platform or set SIGMA_EXEC_BINARY to a target-native binary."
    ].join("\n"));
  }
  const destination = path.join(bundleDir, "bin", sigmaExecFileName(targetPlatform));
  await cp(source, destination);
  let binaryTarget;
  try {
    binaryTarget = await inspectSigmaExecBinary(destination);
  } catch (error) {
    await rm(destination, { force: true });
    throw error;
  }
  if (binaryTarget.targetPlatform !== targetPlatform || binaryTarget.targetArch !== targetArch) {
    await rm(destination, { force: true });
    throw new Error([
      `sigma-exec binary target mismatch: expected ${targetPlatform}-${targetArch},`,
      `detected ${binaryTarget.targetPlatform}-${binaryTarget.targetArch} (${binaryTarget.format} machine ${binaryTarget.machine}): ${source}`
    ].join(" "));
  }
  if (targetPlatform !== "win32") await chmod(destination, 0o755).catch(() => undefined);
  return { source, sourceKind: configured ? "env" : "workspace-build", destination, binaryTarget };
}

async function copyTokenizerAssets(rootDir, bundleDir) {
  const source = path.join(rootDir, "assets", "tokenizers");
  if (!existsSync(source)) throw new Error(`Required tokenizer assets are missing: ${source}`);
  const destination = path.join(bundleDir, "assets", "tokenizers");
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true });
  return destination;
}

async function sha256File(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

async function integrityEntries(bundleDir, roots) {
  const entries = [];
  async function visit(absolute) {
    const stats = await lstat(absolute);
    if (stats.isSymbolicLink()) {
      throw new Error(`Portable integrity roots must not contain symbolic links: ${path.relative(bundleDir, absolute)}`);
    }
    if (stats.isDirectory()) {
      for (const entry of (await readdir(absolute, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
        await visit(path.join(absolute, entry.name));
      }
      return;
    }
    if (!stats.isFile()) return;
    entries.push({
      path: path.relative(bundleDir, absolute).replaceAll(path.sep, "/"),
      size: stats.size,
      sha256: await sha256File(absolute)
    });
  }
  for (const relative of roots) {
    const absolute = path.join(bundleDir, ...relative.split("/"));
    if (!existsSync(absolute)) throw new Error(`Required portable asset is missing: ${relative}`);
    await visit(absolute);
  }
  return entries.sort((left, right) => left.path.localeCompare(right.path, "en"));
}

function portableAssetComponent(entry, targetPlatform, targetArch, options) {
  return {
    type: "file",
    "bom-ref": `sigma:file:${entry.path}`,
    name: options.name,
    ...(options.version ? { version: options.version } : {}),
    scope: "required",
    hashes: [{ alg: "SHA-256", content: entry.sha256 }],
    properties: [
      { name: "sigma:asset-kind", value: options.kind },
      { name: "sigma:path", value: entry.path },
      { name: "sigma:target-platform", value: targetPlatform },
      { name: "sigma:target-arch", value: targetArch },
      ...(options.properties ?? [])
    ]
  };
}

async function writePortableSbom(
  rootDir,
  bundleDir,
  packageNames,
  targetPlatform,
  targetArch,
  sigmaExec,
  nodeArchiveIntegrity
) {
  const components = new Map();
  for (const packageName of packageNames) {
    const manifest = JSON.parse(await readFile(path.join(rootDir, "packages", packageName, "package.json"), "utf8"));
    components.set(`${manifest.name}@${manifest.version}`, {
      type: packageName === "agent-cli" ? "application" : "library",
      name: manifest.name,
      version: String(manifest.version),
      scope: "required"
    });
  }
  const graph = await runtimeDependencyGraph(rootDir, packageNames, targetPlatform, targetArch);
  for (const node of graph.nodes) {
    components.set(`${node.name}@${node.version}`, {
      type: "library",
      name: node.name,
      version: node.version,
      scope: "required"
    });
  }
  const releaseVersion = (JSON.parse(await readFile(path.join(rootDir, "package.json"), "utf8"))).version;
  const nodePath = `bin/${targetPlatform === "win32" ? "node.exe" : "node"}`;
  const brokerPath = `bin/${sigmaExecFileName(targetPlatform)}`;
  const assetEntries = await integrityEntries(bundleDir, [
    nodePath,
    brokerPath,
    ...Object.values(portableLanguageAssets),
    "assets/tokenizers"
  ]);
  const assetsByPath = new Map(assetEntries.map((entry) => [entry.path, entry]));
  components.set("sigma:bundled-node", portableAssetComponent(
    assetsByPath.get(nodePath),
    targetPlatform,
    targetArch,
    {
      kind: "node-runtime",
      name: "node-runtime",
      version: pinnedNodeVersion,
      properties: [{ name: "sigma:archive-sha256", value: nodeArchiveIntegrity.sha256 }]
    }
  ));
  components.set("sigma:sigma-exec", portableAssetComponent(
    assetsByPath.get(brokerPath),
    targetPlatform,
    targetArch,
    {
      kind: "native-broker",
      name: "sigma-exec",
      version: releaseVersion,
      properties: [
        { name: "sigma:binary-format", value: sigmaExec.binaryTarget.format },
        { name: "sigma:machine", value: sigmaExec.binaryTarget.machine }
      ]
    }
  ));
  const codeIntelManifest = JSON.parse(await readFile(
    path.join(rootDir, "packages", "agent-code-intel", "package.json"),
    "utf8"
  ));
  for (const asset of [
    {
      path: portableLanguageAssets.typescriptServer,
      kind: "language-server",
      name: "sigma-typescript-language-server",
      version: String(codeIntelManifest.version)
    },
    {
      path: portableLanguageAssets.typescriptEngine,
      kind: "language-service-engine",
      name: "typescript",
      version: String(codeIntelManifest.dependencies?.typescript ?? "")
    },
    {
      path: portableLanguageAssets.pyrightServer,
      kind: "language-server",
      name: "pyright",
      version: String(codeIntelManifest.dependencies?.pyright ?? "")
    }
  ]) {
    components.set(`sigma:language-asset:${asset.path}`, portableAssetComponent(
      assetsByPath.get(asset.path),
      targetPlatform,
      targetArch,
      { kind: asset.kind, name: asset.name, version: asset.version }
    ));
  }
  for (const entry of assetEntries.filter((candidate) => candidate.path.startsWith("assets/tokenizers/"))) {
    components.set(`sigma:tokenizer:${entry.path}`, portableAssetComponent(
      entry,
      targetPlatform,
      targetArch,
      { kind: "tokenizer", name: path.posix.basename(entry.path) }
    ));
  }
  const sbom = {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    version: 1,
    metadata: {
      component: {
        type: "application",
        name: `sigma-agent-cli-${targetPlatform}-${targetArch}`,
        version: releaseVersion
      },
      properties: [
        { name: "sigma:target-platform", value: targetPlatform },
        { name: "sigma:target-arch", value: targetArch }
      ]
    },
    components: [...components.values()].sort((left, right) => {
      const leftId = left["bom-ref"] ?? `${left.name}@${left.version}`;
      const rightId = right["bom-ref"] ?? `${right.name}@${right.version}`;
      return leftId.localeCompare(rightId, "en");
    })
  };
  const sbomPath = path.join(bundleDir, "sbom.cdx.json");
  await writeFile(sbomPath, `${JSON.stringify(sbom, null, 2)}\n`, "utf8");
  return sbomPath;
}

async function writeIntegrityManifest(bundleDir, targetPlatform, targetArch, tokenizerAssets) {
  const nodePath = `bin/${targetPlatform === "win32" ? "node.exe" : "node"}`;
  const brokerPath = `bin/${sigmaExecFileName(targetPlatform)}`;
  const roots = [
    nodePath,
    brokerPath,
    portableLanguageAssets.typescriptServer,
    "node_modules/typescript",
    "node_modules/pyright",
    "sbom.cdx.json",
    ...(tokenizerAssets ? ["assets/tokenizers"] : [])
  ];
  const manifest = {
    schemaVersion: 1,
    algorithm: "sha256",
    targetPlatform,
    targetArch,
    entries: await integrityEntries(bundleDir, roots)
  };
  const manifestPath = path.join(bundleDir, "integrity-manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const byPath = new Map(manifest.entries.map((entry) => [entry.path, entry]));
  return {
    manifest,
    manifestPath,
    manifestSha256: await sha256File(manifestPath),
    node: byPath.get(nodePath),
    sigmaExec: byPath.get(brokerPath),
    languageServerAssets: Object.fromEntries(
      Object.entries(portableLanguageAssets).map(([name, assetPath]) => [name, byPath.get(assetPath)])
    )
  };
}

function windowsAuthenticode(nodePath, brokerPath, targetPlatform) {
  if (targetPlatform !== "win32") return { required: false, authenticodeVerified: true, status: "not-applicable" };
  if (process.platform !== "win32") {
    return { required: true, authenticodeVerified: false, status: "not-verified-cross-platform" };
  }
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$node = Get-AuthenticodeSignature -LiteralPath ${psQuote(nodePath)}`,
    `$broker = Get-AuthenticodeSignature -LiteralPath ${psQuote(brokerPath)}`,
    "[pscustomobject]@{ node = [string]$node.Status; sigmaExec = [string]$broker.Status } | ConvertTo-Json -Compress"
  ].join("; ");
  try {
    const result = runPowerShell(script, "failed to inspect Authenticode signatures");
    const signatures = JSON.parse(result.stdout.trim());
    const authenticodeVerified = signatures.node === "Valid" && signatures.sigmaExec === "Valid";
    return {
      required: true,
      authenticodeVerified,
      status: authenticodeVerified ? "verified" : "unsigned-preview",
      signatures
    };
  } catch (error) {
    return {
      required: true,
      authenticodeVerified: false,
      status: "inspection-failed",
      detail: error instanceof Error ? error.message : String(error)
    };
  }
}

async function writeReleaseSidecars(outputPath, sbomPath, release, targetPlatform, targetArch, integrity, signing, nodeArchiveIntegrity) {
  const archiveSha256 = await sha256File(outputPath);
  const checksumPath = `${outputPath}.sha256`;
  const sbomOutputPath = outputPath.replace(/\.(?:zip|tgz)$/i, ".sbom.cdx.json");
  const provenancePath = outputPath.replace(/\.(?:zip|tgz)$/i, ".provenance.json");
  await writeFile(checksumPath, `${archiveSha256}  ${path.basename(outputPath)}\n`, "utf8");
  await cp(sbomPath, sbomOutputPath);
  const provenance = {
    _type: "https://in-toto.io/Statement/v1",
    subject: [{ name: path.basename(outputPath), digest: { sha256: archiveSha256 } }],
    predicateType: "https://slsa.dev/provenance/v1",
    predicate: {
      buildDefinition: {
        buildType: "https://sigma-code.dev/build-types/portable-cli/v3",
        externalParameters: { version: release.version, targetPlatform, targetArch },
        resolvedDependencies: [
          { uri: "pkg:generic/node-runtime-archive", digest: { sha256: nodeArchiveIntegrity.sha256 } },
          { uri: `file:bin/${targetPlatform === "win32" ? "node.exe" : "node"}`, digest: { sha256: integrity.node.sha256 } },
          { uri: "pkg:generic/sigma-exec", digest: { sha256: integrity.sigmaExec.sha256 } },
          { uri: "file:integrity-manifest.json", digest: { sha256: integrity.manifestSha256 } }
        ]
      },
      runDetails: {
        builder: { id: "https://sigma-code.dev/builders/local-portable-packager/v3" },
        metadata: { invocationId: `${release.version}:${targetPlatform}:${targetArch}`, signing }
      }
    }
  };
  await writeFile(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`, "utf8");
  return { archiveSha256, checksumPath, sbomOutputPath, provenancePath };
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

NODE="$SCRIPT_DIR/node"
if [ ! -x "$NODE" ]; then
  echo "Sigma Code cannot start: the bundled Node runtime is missing or not executable." >&2
  exit 126
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
if not exist "%NODE_EXE%" (
  echo Sigma Code cannot start: the bundled Node runtime is missing. 1>&2
  exit /b 126
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

The wrapper requires the pinned bundled Node runtime. It never falls back to a system \`node\` on PATH. The archive also includes the target-native \`sigma-exec\` broker, pinned TypeScript/Python language-server assets, and the versioned offline tokenizer-estimator asset; their SHA-256 values are recorded in \`integrity-manifest.json\`.

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
  const tarZip = spawnSync("tar", ["-a", "-cf", outputPath, "-C", artifactsDir, bundleName], {
    cwd: rootDir,
    encoding: "utf8"
  });
  if (!tarZip.error && tarZip.status === 0) return;
  try {
    runPowerShell(
      `$ErrorActionPreference = 'Stop'; Compress-Archive -LiteralPath ${psQuote(bundleDir)} -DestinationPath ${psQuote(outputPath)} -Force`,
      "failed to create agent-cli Windows zip with PowerShell Compress-Archive"
    );
  } catch (powerShellError) {
    runZip(["-qr", outputPath, bundleName], [
      "failed to create agent-cli Windows zip",
      tarZip.stderr || tarZip.stdout || tarZip.error?.message,
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
  assertReleaseTarget(targetPlatform, targetArch);
  const artifactsDir = options.artifactsDir ? path.resolve(options.artifactsDir) : path.join(rootDir, ".artifacts");
  const bundleName = agentCliBundleName(targetPlatform, targetArch);
  const bundleDir = path.join(artifactsDir, bundleName);
  const outputPath = archivePathForTarget(artifactsDir, bundleName, targetPlatform);
  const checksumPath = `${outputPath}.sha256`;
  const sbomOutputPath = outputPath.replace(/\.(?:zip|tgz)$/i, ".sbom.cdx.json");
  const provenancePath = outputPath.replace(/\.(?:zip|tgz)$/i, ".provenance.json");
  const release = await workspaceRelease(rootDir);
  const packages = await v3RuntimePackages(rootDir, await workspaceRuntimePackages(rootDir), release.isV3);

  for (const packageName of packages) {
    assertBuiltPackage(rootDir, packageName);
  }

  await rm(bundleDir, { recursive: true, force: true });
  await rm(outputPath, { force: true });
  await rm(checksumPath, { force: true });
  await rm(sbomOutputPath, { force: true });
  await rm(provenancePath, { force: true });
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
  const nodeArchiveIntegrity = release.isV3
    ? await verifyNodeRuntimeArchive(nodeRuntime, env, options.nodeChecksumDownloader)
    : null;
  const sigmaExec = release.isV3
    ? await copySigmaExec(rootDir, bundleDir, targetPlatform, targetArch, env)
    : null;
  const tokenizerAssets = release.isV3 ? await copyTokenizerAssets(rootDir, bundleDir) : null;
  const sbomPath = release.isV3
    ? await writePortableSbom(
        rootDir,
        bundleDir,
        packages,
        targetPlatform,
        targetArch,
        sigmaExec,
        nodeArchiveIntegrity
      )
    : null;
  const integrity = release.isV3
    ? await writeIntegrityManifest(bundleDir, targetPlatform, targetArch, tokenizerAssets)
    : null;
  const signing = release.isV3
    ? windowsAuthenticode(nodeRuntime.bundledNodePath, sigmaExec.destination, targetPlatform)
    : null;

  await writeFile(
    path.join(bundleDir, "package.json"),
    `${JSON.stringify(
      {
        name: `sigma-agent-cli-${targetPlatform}-${targetArch}`,
        version: release.version,
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
        schemaVersion: release.isV3 ? 3 : 2,
        productVersion: release.version,
        releaseChannel: release.version.includes("-") ? release.version.split("-")[1].split(".")[0] : "stable",
        tier: "tier1",
        targetPlatform,
        targetArch,
        node: {
          version: pinnedNodeVersion,
          runtimeUrl: nodeRuntime.runtimeUrl,
          archive: path.basename(nodeRuntime.runtimeArchive),
          archiveSha256: nodeArchiveIntegrity?.sha256,
          archiveVerificationSource: nodeArchiveIntegrity?.verificationSource,
          downloaded: nodeRuntime.downloaded,
          source: nodeRuntime.source,
          versionOutput: nodeRuntime.nodeVersionOutput,
          ...(integrity?.node ? { sha256: integrity.node.sha256, size: integrity.node.size } : {})
        },
        ...(integrity ? {
          sigmaExec: {
            path: `bin/${sigmaExecFileName(targetPlatform)}`,
            sha256: integrity.sigmaExec.sha256,
            size: integrity.sigmaExec.size,
            source: sigmaExec.sourceKind,
            targetPlatform: sigmaExec.binaryTarget.targetPlatform,
            targetArch: sigmaExec.binaryTarget.targetArch,
            format: sigmaExec.binaryTarget.format,
            machine: sigmaExec.binaryTarget.machine
          },
          assets: {
            languageServers: [
              {
                id: "typescript",
                implementation: "sigma-typescript-language-server",
                ...integrity.languageServerAssets.typescriptServer
              },
              {
                id: "python",
                implementation: "pyright",
                ...integrity.languageServerAssets.pyrightServer
              }
            ],
            languageServiceEngines: [
              {
                id: "typescript",
                implementation: "typescript",
                ...integrity.languageServerAssets.typescriptEngine
              }
            ],
            tokenizerAssets: tokenizerAssets !== null
          },
          integrity: {
            algorithm: "sha256",
            manifest: "integrity-manifest.json",
            manifestSha256: integrity.manifestSha256,
            entries: integrity.manifest.entries.length
          },
          sbom: {
            format: "CycloneDX",
            specVersion: "1.5",
            path: "sbom.cdx.json"
          },
          signing,
          sidecars: {
            checksum: path.basename(checksumPath),
            sbom: path.basename(sbomOutputPath),
            provenance: path.basename(provenancePath)
          }
        } : {})
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  createBundleArchive(outputPath, artifactsDir, bundleName, targetPlatform, rootDir);
  const sidecars = release.isV3
    ? await writeReleaseSidecars(outputPath, sbomPath, release, targetPlatform, targetArch, integrity, signing, nodeArchiveIntegrity)
    : null;
  return {
    artifactsDir,
    bundleName,
    bundleDir,
    outputPath,
    targetPlatform,
    targetArch,
    version: release.version,
    sigmaExec,
    integrity,
    signing,
    sidecars,
    ...nodeRuntime
  };
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
