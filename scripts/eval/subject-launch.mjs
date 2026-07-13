import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { digest } from "./common.mjs";

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

function normalizeBundleRelative(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\\") || path.win32.isAbsolute(value)) {
    throw new Error(`${label} must be a portable relative bundle path.`);
  }
  const withoutDot = value.startsWith("./") ? value.slice(2) : value;
  if (!withoutDot || path.posix.isAbsolute(withoutDot) || path.posix.normalize(withoutDot) !== withoutDot
    || withoutDot.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`${label} must stay inside the bundle.`);
  }
  return withoutDot;
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function regularBundleFile(bundleRoot, canonicalRoot, relativePath, label) {
  const filePath = path.resolve(bundleRoot, ...relativePath.split("/"));
  if (!isInside(path.resolve(bundleRoot), filePath)) throw new Error(`${label} escapes the bundle.`);
  const stats = await lstat(filePath);
  if (stats.isSymbolicLink() || !stats.isFile()) throw new Error(`${label} must be a regular, non-link file.`);
  const canonicalPath = await realpath(filePath);
  if (!isInside(canonicalRoot, canonicalPath)) throw new Error(`${label} resolves outside the bundle.`);
  return { filePath, bytes: await readFile(filePath), stats };
}

function runtimeEnvironment(value) {
  if (value === undefined) return {};
  if (!record(value)) throw new Error("Package runtimeEnvironment must be an object of string values.");
  const result = {};
  const names = new Set();
  for (const [key, item] of Object.entries(value)) {
    const normalized = key.toUpperCase();
    if (!/^[A-Z_][A-Z0-9_]*$/u.test(key) || names.has(normalized) || typeof item !== "string") {
      throw new Error("Package runtimeEnvironment must use unique portable names and string values.");
    }
    names.add(normalized);
    result[key] = item;
  }
  return result;
}

function assertNodeRuntimeEnvironment(value, targetPlatform) {
  const environment = runtimeEnvironment(value);
  const entries = Object.entries(environment);
  if (targetPlatform !== "win32") {
    if (entries.length !== 0) throw new Error("Non-Windows packaged Node must not declare runtime environment overrides.");
    return environment;
  }
  if (entries.length !== 1 || entries[0][0].toUpperCase() !== "NODE_OPTIONS"
    || entries[0][1] !== "--preserve-symlinks-main") {
    throw new Error("Windows packaged Node must declare only its approved NODE_OPTIONS compatibility setting.");
  }
  return { NODE_OPTIONS: entries[0][1] };
}

function samePath(left, right, platform) {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function setEnvironmentValue(env, key, value) {
  const normalized = key.toUpperCase();
  for (const existing of Object.keys(env)) {
    if (existing.toUpperCase() === normalized) delete env[existing];
  }
  env[key] = value;
}

function environmentValue(env, key) {
  const normalized = key.toUpperCase();
  const match = Object.keys(env).find((candidate) => candidate.toUpperCase() === normalized);
  return match === undefined ? undefined : env[match];
}

export function applySubjectLaunchEnvironment(base, launch) {
  if (!record(launch) || launch.kind !== "node" || launch.shell !== false) {
    throw new Error("Subject launch descriptor must declare a direct Node process with shell disabled.");
  }
  const env = Object.fromEntries(Object.entries(base ?? {}).filter(([, value]) => typeof value === "string"));
  const declared = runtimeEnvironment(launch.environment);
  for (const [key, value] of Object.entries(declared)) setEnvironmentValue(env, key, value);
  if (launch.binDirectory) {
    if (!path.isAbsolute(launch.binDirectory)) throw new Error("Subject bundle bin directory must be absolute.");
    const currentPath = environmentValue(env, "PATH");
    const value = currentPath
      ? `${launch.binDirectory}${launch.pathDelimiter}${currentPath}`
      : launch.binDirectory;
    setEnvironmentValue(env, "PATH", value);
  }
  return env;
}

export function createDevNodeLaunch(nodePath, entryPath) {
  if (!path.isAbsolute(nodePath) || !path.isAbsolute(entryPath)) {
    throw new Error("Development subject Node and CLI paths must be absolute.");
  }
  return {
    kind: "node",
    runtime: "host-dev",
    targetPlatform: process.platform,
    executablePath: nodePath,
    entryPath,
    shell: false,
    binDirectory: null,
    pathDelimiter: path.delimiter,
    environment: {}
  };
}

export function subjectNodeLaunch(subject) {
  if (!record(subject) || !new Set(["dev", "package"]).has(subject.subjectKind)) {
    throw new Error("CLI subject must explicitly declare subjectKind as 'dev' or 'package'.");
  }
  const launch = subject.launch;
  if (!validDirectNodeLaunch(launch)) {
    throw new Error("CLI subject must provide an explicit direct Node launch descriptor.");
  }
  const expectedRuntime = expectedSubjectRuntime(subject.subjectKind);
  if (launch.runtime !== expectedRuntime) {
    throw new Error(`${subject.subjectKind} subject must use the ${expectedRuntime} runtime contract.`);
  }
  const targetPlatform = launch.targetPlatform ?? process.platform;
  if (!new Set(["linux", "win32", "darwin"]).has(targetPlatform)) {
    throw new Error("Subject launch descriptor has an unsupported target platform.");
  }
  if (![typeof subject.nodePath === "string", typeof subject.cliEntry === "string",
    samePath(subject.nodePath, launch.executablePath, targetPlatform),
    samePath(subject.cliEntry, launch.entryPath, targetPlatform)].every(Boolean)) {
    throw new Error("Subject launch descriptor disagrees with its prepared Node or CLI path.");
  }
  if (subject.subjectKind === "package" && samePath(launch.executablePath, process.execPath, targetPlatform)) {
    throw new Error("Packaged subjects must not run through the evaluator host Node runtime.");
  }
  return launch;
}

function validDirectNodeLaunch(launch) {
  if (!record(launch)) return false;
  return [launch.kind === "node", launch.shell === false,
    path.isAbsolute(launch.executablePath), path.isAbsolute(launch.entryPath)].every(Boolean);
}

function expectedSubjectRuntime(subjectKind) {
  return subjectKind === "package" ? "bundled" : "host-dev";
}

async function packagedBundleReader(bundleRoot) {
  const rootStats = await lstat(bundleRoot);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new Error("Packaged subject root must be a real directory.");
  }
  const canonicalRoot = await realpath(bundleRoot);
  return async (relativePath, label) => {
    const loaded = await regularBundleFile(bundleRoot, canonicalRoot, relativePath, label);
    return { ...loaded, value: parseJson(loaded.bytes, label) };
  };
}

function assertPackageTarget(packageJson, metadata, targetPlatform, targetArch) {
  const checks = [
    metadata.value.targetPlatform === targetPlatform,
    metadata.value.targetArch === targetArch,
    metadata.value.node?.targetPlatform === undefined || metadata.value.node.targetPlatform === targetPlatform,
    metadata.value.node?.targetArch === undefined || metadata.value.node.targetArch === targetArch
  ];
  if (!checks.every(Boolean)) throw new Error("Packaged subject metadata target does not match the evaluator host target.");
  const expectedName = `sigma-agent-cli-${targetPlatform}-${targetArch}`;
  if (packageJson.value.name !== expectedName) throw new Error("Package manifest target name does not match package metadata.");
}

function integrityEntryMap(integrity) {
  const entries = new Map();
  for (const entry of integrity.value.entries) {
    const relative = normalizeBundleRelative(entry?.path, "Integrity entry");
    const valid = !entries.has(relative) && /^[a-f0-9]{64}$/u.test(String(entry?.sha256 ?? ""))
      && Number.isSafeInteger(entry?.size) && entry.size >= 0;
    if (!valid) throw new Error("Package integrity manifest contains an invalid or duplicate entry.");
    entries.set(relative, entry);
  }
  return entries;
}

function assertIntegrityManifest(metadata, integrity, targetPlatform, targetArch) {
  if (metadata.value.integrity?.algorithm !== "sha256"
    || metadata.value.integrity.manifestSha256 !== digest(integrity.bytes)) {
    throw new Error("Package integrity manifest digest does not match package metadata.");
  }
  const checks = [integrity.value.schemaVersion === 1, integrity.value.algorithm === "sha256",
    integrity.value.targetPlatform === targetPlatform, integrity.value.targetArch === targetArch,
    Array.isArray(integrity.value.entries)];
  if (!checks.every(Boolean)) throw new Error("Package integrity manifest target or schema is invalid.");
}

function manifestedFileLoader(bundleRoot, entries) {
  return async (relative, label) => {
    const declared = entries.get(relative);
    if (!declared) throw new Error(`${label} is not covered by the package integrity manifest.`);
    const loaded = await regularBundleFile(bundleRoot, await realpath(bundleRoot), relative, label);
    if (loaded.stats.size !== declared.size || digest(loaded.bytes) !== declared.sha256) {
      throw new Error(`${label} does not match the package integrity manifest.`);
    }
    return { ...loaded, declared };
  };
}

function bundlePaths(packageJson, metadata, targetPlatform) {
  const declaredBin = normalizeBundleRelative(
    typeof packageJson.value.bin === "string" ? packageJson.value.bin : packageJson.value.bin?.agent,
    "Package agent executable"
  );
  const expectedBin = `bin/${targetPlatform === "win32" ? "agent.cmd" : "agent"}`;
  if (declaredBin !== expectedBin) throw new Error("Package agent executable does not match the target wrapper contract.");
  return {
    declaredBin,
    node: normalizeBundleRelative(
      metadata.value.node?.path ?? `bin/${targetPlatform === "win32" ? "node.exe" : "node"}`,
      "Bundled Node runtime"
    ),
    cli: "packages/agent-cli/dist/index.js",
    broker: normalizeBundleRelative(metadata.value.sigmaExec?.path, "Bundled sigma-exec broker")
  };
}

function assertCompatibilityMetadata(metadata, integrity) {
  const metadataCompatibility = metadata.value.node?.compatibility;
  const manifestCompatibility = integrity.value.nodeCompatibility;
  const declared = metadataCompatibility !== undefined || manifestCompatibility !== undefined;
  if (declared && digest(metadataCompatibility ?? null) !== digest(manifestCompatibility ?? null)) {
    throw new Error("Node compatibility metadata disagrees with the integrity manifest.");
  }
  return metadataCompatibility;
}

function packagedLaunchResult(targetPlatform, metadata, integrity, files) {
  const environment = assertNodeRuntimeEnvironment(files.compatibility?.runtimeEnvironment, targetPlatform);
  const launch = {
    kind: "node", runtime: "bundled", targetPlatform,
    executablePath: files.node.filePath, entryPath: files.cli.filePath,
    declaredExecutablePath: files.wrapper.filePath, shell: false,
    binDirectory: path.dirname(files.node.filePath),
    pathDelimiter: targetPlatform === "win32" ? ";" : ":", environment
  };
  return {
    nodePath: files.node.filePath, cliEntry: files.cli.filePath, brokerPath: files.broker.filePath, launch,
    packageMetadataDigest: digest(metadata.bytes), integrityManifestDigest: digest(integrity.bytes)
  };
}

function assertRuntimeEntries(metadata, node, broker) {
  if (metadata.value.node?.sha256 !== node.declared.sha256
    || (metadata.value.node?.size !== undefined && metadata.value.node.size !== node.declared.size)) {
    throw new Error("Bundled Node metadata does not match its integrity entry.");
  }
  if (metadata.value.sigmaExec?.sha256 !== broker.declared.sha256
    || (metadata.value.sigmaExec?.size !== undefined && metadata.value.sigmaExec.size !== broker.declared.size)) {
    throw new Error("Bundled sigma-exec metadata does not match its integrity entry.");
  }
}

export async function loadPackagedSubjectLaunch(bundleRoot, options = {}) {
  const targetPlatform = options.targetPlatform ?? process.platform;
  const targetArch = options.targetArch ?? process.arch;
  if (!new Set(["linux", "win32"]).has(targetPlatform)) throw new Error("Unsupported packaged subject platform.");
  const readBundleJson = await packagedBundleReader(bundleRoot);
  const packageJson = await readBundleJson("package.json", "Package manifest");
  const metadata = await readBundleJson("package-metadata.json", "Package metadata");
  assertPackageTarget(packageJson, metadata, targetPlatform, targetArch);
  const integrityRelative = normalizeBundleRelative(metadata.value.integrity?.manifest, "Integrity manifest");
  const integrity = await readBundleJson(integrityRelative, "Integrity manifest");
  assertIntegrityManifest(metadata, integrity, targetPlatform, targetArch);
  const entries = integrityEntryMap(integrity);
  const relative = bundlePaths(packageJson, metadata, targetPlatform);
  const manifestedFile = manifestedFileLoader(bundleRoot, entries);
  const [node, cli, broker, wrapper] = await Promise.all([
    manifestedFile(relative.node, "Bundled Node runtime"),
    manifestedFile(relative.cli, "Bundled CLI entry"),
    manifestedFile(relative.broker, "Bundled sigma-exec broker"),
    manifestedFile(relative.declaredBin, "Declared package executable")
  ]);
  assertRuntimeEntries(metadata, node, broker);
  const compatibility = assertCompatibilityMetadata(metadata, integrity);
  return packagedLaunchResult(targetPlatform, metadata, integrity, { node, cli, broker, wrapper, compatibility });
}
