#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  agentCliBundleName,
  defaultRootDir,
  inspectSigmaExecBinary,
  normalizeTargetPlatform,
  pinnedNodeVersion,
  normalizeTargetArch,
  v3PortablePackages,
  workspaceRuntimePackages
} from "./package-agent-cli.mjs";

const portableLanguageAssets = Object.freeze({
  typescriptServer: "node_modules/agent-code-intel/dist/typescript-server.mjs",
  typescriptEngine: "node_modules/typescript/lib/typescript.js",
  pyrightServer: "node_modules/pyright/langserver.index.js"
});

function tarEntries(tarball, spawn = spawnSync) {
  const result = spawn("tar", ["-tzf", tarball], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`failed to list ${tarball} with tar: ${result.stderr || result.stdout}`);
  }
  return result.stdout.split(/\r?\n/).filter(Boolean);
}

function psQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function runPowerShell(script, spawn = spawnSync) {
  const candidates = process.platform === "win32"
    ? ["powershell.exe", "powershell", "pwsh"]
    : ["pwsh", "powershell"];
  let last = null;
  for (const command of candidates) {
    const result = spawn(command, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
      encoding: "utf8"
    });
    last = result;
    if (!result.error && result.status === 0) return result;
  }
  return last;
}

function zipEntries(archive, spawn = spawnSync) {
  const tar = spawn("tar", ["-tf", archive], { encoding: "utf8" });
  if (!tar.error && tar.status === 0) return tar.stdout.split(/\r?\n/).filter(Boolean);
  const powerShell = runPowerShell(
    `$ErrorActionPreference = 'Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; $zip = [System.IO.Compression.ZipFile]::OpenRead(${psQuote(archive)}); try { $zip.Entries | ForEach-Object { $_.FullName } } finally { $zip.Dispose() }`,
    spawn
  );
  if (powerShell && !powerShell.error && powerShell.status === 0) {
    return powerShell.stdout.split(/\r?\n/).filter(Boolean);
  }

  const result = spawn("unzip", ["-Z1", archive], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`failed to list ${archive} as zip: ${result.stderr || result.stdout || powerShell?.stderr || powerShell?.stdout || tar.stderr || tar.stdout}`);
  }
  return result.stdout.split(/\r?\n/).filter(Boolean);
}

function extractTarball(tarball, destination, spawn = spawnSync) {
  const result = spawn("tar", ["-xzf", tarball, "-C", destination], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`failed to extract ${tarball} with tar: ${result.stderr || result.stdout}`);
  }
}

function extractZipArchive(archive, destination, spawn = spawnSync) {
  const tar = spawn("tar", ["-xf", archive, "-C", destination], { encoding: "utf8" });
  if (!tar.error && tar.status === 0) return;
  const powerShell = runPowerShell(
    `$ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath ${psQuote(archive)} -DestinationPath ${psQuote(destination)} -Force`,
    spawn
  );
  if (powerShell && !powerShell.error && powerShell.status === 0) return;

  const result = spawn("unzip", ["-q", archive, "-d", destination], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`failed to extract ${archive} as zip: ${result.stderr || result.stdout || powerShell?.stderr || powerShell?.stdout || tar.stderr || tar.stdout}`);
  }
}

function requireEntries(entries, required) {
  const normalized = entries.map((entry) => entry.replace(/\\/g, "/"));
  const missing = required.filter((entry) => !normalized.includes(entry));
  if (missing.length > 0) {
    throw new Error(`agent CLI bundle is missing required entries:\n${missing.join("\n")}`);
  }
}

function assertContains(label, content, expected) {
  if (!content.includes(expected)) {
    throw new Error(`${label} is missing expected text: ${expected}`);
  }
}

function runHostCliVersion(bundleDir, spawn = spawnSync) {
  const cliEntry = path.join(bundleDir, "packages", "agent-cli", "dist", "index.js");
  const result = spawn(process.execPath, [cliEntry, "version", "--json"], {
    cwd: bundleDir,
    encoding: "utf8",
    env: {
      ...process.env,
      NO_COLOR: "1",
      SIGMA_NO_COLOR: "1"
    }
  });
  if (result.status !== 0) {
    throw new Error([
      "host Node CLI smoke failed: agent version --json",
      `exit=${String(result.status)}`,
      "stdout:",
      result.stdout,
      "stderr:",
      result.stderr
    ].join("\n"));
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`host Node CLI smoke did not print JSON: ${error instanceof Error ? error.message : String(error)}\n${result.stdout}`, { cause: error });
  }
  if (parsed?.product !== "Sigma Code" || parsed?.package?.name !== "agent-cli") {
    throw new Error(`host Node CLI smoke returned unexpected version payload:\n${result.stdout}`);
  }
  return parsed;
}

function targetArchForHost(arch = process.arch) {
  if (arch === "x64" || arch === "arm64") return arch;
  return arch;
}

function targetArchForLinuxMachine(machine) {
  const value = String(machine ?? "").trim();
  if (value === "x86_64" || value === "amd64") return "x64";
  if (value === "aarch64" || value === "arm64") return "arm64";
  return value;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`;
}

function wslPathForWindowsPath(value, spawn) {
  const normalized = path.resolve(value).replace(/\\/g, "/");
  const converted = spawn("wsl", ["wslpath", "-a", normalized], { encoding: "utf8" });
  if (converted.status === 0 && converted.stdout.trim()) {
    return { ok: true, path: converted.stdout.trim(), source: "wslpath" };
  }
  const match = normalized.match(/^([A-Za-z]):\/(.*)$/);
  if (!match) {
    return {
      ok: false,
      reason: `could not convert Windows path for WSL: ${value}`
    };
  }
  return {
    ok: true,
    path: `/mnt/${match[1].toLowerCase()}/${match[2]}`,
    source: "drive-fallback",
    warning: converted.stderr || converted.stdout || "wslpath failed"
  };
}

function validateTargetWrapperPayload(stdout, label) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    return {
      ok: false,
      reason: `${label} did not print JSON: ${error instanceof Error ? error.message : String(error)}`
    };
  }

  if (parsed?.product !== "Sigma Code" || parsed?.package?.name !== "agent-cli") {
    return {
      ok: false,
      reason: `${label} returned unexpected version payload`
    };
  }

  return { ok: true, version: parsed };
}

function runNativeTargetWrapperVersion(bundleDir, targetArch, options) {
  const spawn = options.spawnSync ?? spawnSync;
  const arch = options.arch ?? process.arch;
  const hostArch = targetArchForHost(arch);
  if (hostArch !== targetArch) {
    return {
      ok: false,
      status: "skipped",
      reason: `target wrapper smoke requires host arch ${targetArch}; current arch is ${hostArch}`
    };
  }

  const agentBin = path.join(bundleDir, "bin", "agent");
  const result = spawn(agentBin, ["version", "--json"], {
    cwd: bundleDir,
    encoding: "utf8",
    env: {
      ...process.env,
      NO_COLOR: "1",
      SIGMA_NO_COLOR: "1"
    }
  });

  if (result.status !== 0) {
    return {
      ok: false,
      status: "failed",
      exitCode: result.status,
      stdout: result.stdout,
      stderr: result.stderr
    };
  }

  const validated = validateTargetWrapperPayload(result.stdout, "target wrapper smoke");
  if (!validated.ok) {
    return {
      ok: false,
      status: "failed",
      reason: validated.reason,
      stdout: result.stdout,
      stderr: result.stderr
    };
  }

  return {
    ok: true,
    status: "passed",
    transport: "native",
    version: validated.version
  };
}

function runWindowsTargetWrapperVersion(bundleDir, targetArch, options) {
  const spawn = options.spawnSync ?? spawnSync;
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    return {
      ok: false,
      status: "skipped",
      reason: `target wrapper smoke requires Windows; current platform is ${platform}`
    };
  }

  const arch = options.arch ?? process.arch;
  const hostArch = targetArchForHost(arch);
  if (hostArch !== targetArch) {
    return {
      ok: false,
      status: "skipped",
      reason: `target wrapper smoke requires host arch ${targetArch}; current arch is ${hostArch}`
    };
  }

  const agentCmd = path.join(bundleDir, "bin", "agent.cmd");
  const env = {
    ...process.env,
    ...(options.env ?? {}),
    NO_COLOR: "1",
    SIGMA_NO_COLOR: "1"
  };
  const script = `$ErrorActionPreference = 'Stop'; & ${psQuote(agentCmd)} version --json`;
  const candidates = ["powershell.exe", "powershell", "pwsh"];
  let result = null;
  for (const command of candidates) {
    const attempt = spawn(command, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
      cwd: bundleDir,
      encoding: "utf8",
      env
    });
    result = attempt;
    if (!attempt.error) break;
  }

  if (result?.error) {
    return {
      ok: false,
      status: "failed",
      transport: "native",
      reason: result.error.message,
      stdout: result.stdout,
      stderr: result.stderr
    };
  }

  if (result.status !== 0) {
    return {
      ok: false,
      status: "failed",
      transport: "native",
      exitCode: result.status,
      stdout: result.stdout,
      stderr: result.stderr
    };
  }

  const validated = validateTargetWrapperPayload(result.stdout, "Windows target wrapper smoke");
  if (!validated.ok) {
    return {
      ok: false,
      status: "failed",
      transport: "native",
      reason: validated.reason,
      stdout: result.stdout,
      stderr: result.stderr
    };
  }

  return {
    ok: true,
    status: "passed",
    transport: "native",
    version: validated.version
  };
}

function runWslTargetWrapperVersion(bundleDir, targetArch, options) {
  const spawn = options.spawnSync ?? spawnSync;
  const env = options.env ?? process.env;
  const uname = spawn("wsl", ["-e", "sh", "-lc", "uname -m"], { encoding: "utf8" });
  if (uname.status !== 0) {
    return {
      ok: false,
      status: "skipped",
      transport: "wsl",
      reason: "target wrapper smoke requires WSL on Windows",
      stdout: uname.stdout,
      stderr: uname.stderr
    };
  }
  const machine = uname.stdout.trim().split(/\s+/).at(-1) ?? "";
  const wslArch = targetArchForLinuxMachine(machine);
  if (wslArch !== targetArch) {
    return {
      ok: false,
      status: "skipped",
      transport: "wsl",
      reason: `target wrapper smoke requires WSL arch ${targetArch}; current WSL arch is ${wslArch || "unknown"}`,
      stdout: uname.stdout,
      stderr: uname.stderr
    };
  }

  const libc = spawn("wsl", ["-e", "sh", "-lc", "getconf GNU_LIBC_VERSION 2>/dev/null || ldd --version 2>&1 | head -n 1 || true"], { encoding: "utf8" });
  const libcText = libc.stdout.trim();
  if (libcText && !/glibc|gnu libc/i.test(libcText)) {
    return {
      ok: false,
      status: "skipped",
      transport: "wsl",
      reason: "WSL distro does not provide glibc required by the official Linux Node runtime",
      libc: libcText,
      stdout: libc.stdout,
      stderr: libc.stderr
    };
  }

  const converted = wslPathForWindowsPath(bundleDir, spawn);
  if (!converted.ok) {
    return {
      ok: false,
      status: "skipped",
      transport: "wsl",
      reason: converted.reason
    };
  }

  const command = [
    `cd ${shellQuote(converted.path)}`,
    "(chmod +x ./bin/agent ./bin/node 2>/dev/null || true)",
    "NO_COLOR=1 SIGMA_NO_COLOR=1 ./bin/agent version --json"
  ].join(" && ");
  const result = spawn("wsl", ["-e", "sh", "-lc", command], {
    encoding: "utf8",
    env: {
      ...env,
      NO_COLOR: "1",
      SIGMA_NO_COLOR: "1"
    }
  });

  if (result.status !== 0) {
    return {
      ok: false,
      status: "failed",
      transport: "wsl",
      exitCode: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      wslPath: converted.path,
      wslPathSource: converted.source
    };
  }

  const validated = validateTargetWrapperPayload(result.stdout, "WSL target wrapper smoke");
  if (!validated.ok) {
    return {
      ok: false,
      status: "failed",
      transport: "wsl",
      reason: validated.reason,
      stdout: result.stdout,
      stderr: result.stderr,
      wslPath: converted.path,
      wslPathSource: converted.source
    };
  }

  return {
    ok: true,
    status: "passed",
    transport: "wsl",
    machine,
    wslPath: converted.path,
    wslPathSource: converted.source,
    ...(converted.warning ? { wslPathWarning: converted.warning } : {}),
    version: validated.version
  };
}

export function runTargetWrapperVersion(bundleDir, targetPlatformOrArch, targetArchOrOptions = {}, maybeOptions = {}) {
  let targetPlatform = "linux";
  let targetArch = targetPlatformOrArch;
  let options = targetArchOrOptions;
  if (targetPlatformOrArch === "linux" || targetPlatformOrArch === "win32") {
    targetPlatform = targetPlatformOrArch;
    targetArch = targetArchOrOptions;
    options = maybeOptions;
  }

  if (targetPlatform === "win32") return runWindowsTargetWrapperVersion(bundleDir, targetArch, options);
  const platform = options.platform ?? process.platform;
  if (platform === "linux") return runNativeTargetWrapperVersion(bundleDir, targetArch, options);
  if (platform === "win32") return runWslTargetWrapperVersion(bundleDir, targetArch, options);
  return {
    ok: false,
    status: "skipped",
    reason: `target wrapper smoke requires Linux or Windows+WSL; current platform is ${platform}`
  };
}

function requireTargetWrapperSmoke(options, env) {
  const value = options.requireTargetWrapperSmoke ?? env.AGENT_REQUIRE_TARGET_WRAPPER;
  return value === true || value === "1" || value === "true";
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function sha256File(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

function safeBundlePath(bundleDir, relativePath) {
  if (typeof relativePath !== "string" || relativePath.length === 0 || relativePath.includes("\\")) {
    throw new Error(`Integrity entry has an invalid path: ${String(relativePath)}`);
  }
  const absolute = path.resolve(bundleDir, ...relativePath.split("/"));
  const relative = path.relative(bundleDir, absolute);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Integrity entry escapes the bundle: ${relativePath}`);
  }
  return absolute;
}

async function verifyIntegrityManifest(bundleDir, metadata, targetPlatform, targetArch) {
  const descriptor = metadata.integrity;
  if (descriptor?.algorithm !== "sha256" || descriptor?.manifest !== "integrity-manifest.json") {
    throw new Error("V3 package metadata must reference the SHA-256 integrity-manifest.json.");
  }
  const manifestPath = path.join(bundleDir, "integrity-manifest.json");
  const manifestDigest = await sha256File(manifestPath);
  if (manifestDigest !== descriptor.manifestSha256) {
    throw new Error(`integrity-manifest.json digest mismatch: ${manifestDigest}`);
  }
  const manifest = await readJson(manifestPath);
  if (manifest.schemaVersion !== 1 || manifest.algorithm !== "sha256") {
    throw new Error("Unsupported portable integrity manifest schema.");
  }
  if (manifest.targetPlatform !== targetPlatform || manifest.targetArch !== targetArch) {
    throw new Error("Portable integrity manifest target does not match the archive target.");
  }
  if (!Array.isArray(manifest.entries) || manifest.entries.length !== descriptor.entries) {
    throw new Error("Portable integrity manifest entry count does not match package metadata.");
  }
  const entries = new Map();
  for (const entry of manifest.entries) {
    if (entries.has(entry.path)) throw new Error(`Duplicate portable integrity entry: ${entry.path}`);
    const absolute = safeBundlePath(bundleDir, entry.path);
    const stats = await lstat(absolute).catch(() => null);
    if (!stats?.isFile() || stats.isSymbolicLink()) throw new Error(`Integrity entry is not a regular file: ${entry.path}`);
    if (stats.size !== entry.size) throw new Error(`Integrity size mismatch for ${entry.path}`);
    const digest = await sha256File(absolute);
    if (digest !== entry.sha256) throw new Error(`Integrity SHA-256 mismatch for ${entry.path}`);
    entries.set(entry.path, entry);
  }
  const nodePath = `bin/${targetPlatform === "win32" ? "node.exe" : "node"}`;
  const brokerPath = `bin/${targetPlatform === "win32" ? "sigma-exec.exe" : "sigma-exec"}`;
  const requiredFiles = [
    nodePath,
    brokerPath,
    ...Object.values(portableLanguageAssets),
    "assets/tokenizers/sigma-cjk-byte-v1.json",
    "sbom.cdx.json"
  ];
  for (const required of requiredFiles) {
    if (!entries.has(required)) throw new Error(`Integrity manifest does not cover required portable asset: ${required}`);
  }
  async function assertTreeCovered(relativeRoot) {
    const absoluteRoot = safeBundlePath(bundleDir, relativeRoot);
    async function visit(absolute) {
      const stats = await lstat(absolute);
      const relative = path.relative(bundleDir, absolute).replaceAll(path.sep, "/");
      if (stats.isSymbolicLink()) throw new Error(`Language runtime tree contains a symbolic link: ${relative}`);
      if (stats.isDirectory()) {
        for (const item of await readdir(absolute, { withFileTypes: true })) await visit(path.join(absolute, item.name));
      } else if (stats.isFile() && !entries.has(relative)) {
        throw new Error(`Integrity manifest omits language runtime file: ${relative}`);
      }
    }
    await visit(absoluteRoot);
  }
  await assertTreeCovered("node_modules/typescript");
  await assertTreeCovered("node_modules/pyright");
  if (metadata.node?.sha256 !== entries.get(nodePath).sha256) throw new Error("Bundled Node digest metadata does not match the manifest.");
  if (metadata.sigmaExec?.sha256 !== entries.get(brokerPath).sha256) throw new Error("sigma-exec digest metadata does not match the manifest.");
  const metadataAssets = [
    [metadata.assets?.languageServers, "typescript", portableLanguageAssets.typescriptServer],
    [metadata.assets?.languageServiceEngines, "typescript", portableLanguageAssets.typescriptEngine],
    [metadata.assets?.languageServers, "python", portableLanguageAssets.pyrightServer]
  ];
  for (const [collection, id, assetPath] of metadataAssets) {
    const descriptor = Array.isArray(collection) ? collection.find((item) => item?.id === id) : undefined;
    const entry = entries.get(assetPath);
    if (descriptor?.path !== assetPath || descriptor?.sha256 !== entry.sha256 || descriptor?.size !== entry.size) {
      throw new Error(`Language-server metadata does not match integrity asset ${assetPath}.`);
    }
  }
  return {
    manifest,
    manifestDigest,
    nodePath,
    brokerPath,
    languageServerAssetsVerified: true,
    languageServerAssetPaths: portableLanguageAssets
  };
}

function namedProperties(properties, label) {
  if (!Array.isArray(properties)) throw new Error(`${label} must declare CycloneDX properties.`);
  const values = new Map();
  for (const property of properties) {
    if (typeof property?.name !== "string" || typeof property?.value !== "string") {
      throw new Error(`${label} has an invalid CycloneDX property.`);
    }
    if (values.has(property.name)) throw new Error(`${label} repeats CycloneDX property ${property.name}.`);
    values.set(property.name, property.value);
  }
  return values;
}

function componentSha256(component, label) {
  const hashes = Array.isArray(component?.hashes)
    ? component.hashes.filter((hash) => hash?.alg === "SHA-256")
    : [];
  if (hashes.length !== 1 || !/^[a-f0-9]{64}$/.test(String(hashes[0]?.content ?? ""))) {
    throw new Error(`${label} must declare exactly one valid SHA-256 hash.`);
  }
  return hashes[0].content;
}

export function verifyPortableSbomComponents(sbom, integrityManifest, metadata, targetPlatform, targetArch) {
  const metadataProperties = namedProperties(sbom.metadata?.properties, "CycloneDX metadata");
  if (metadataProperties.get("sigma:target-platform") !== targetPlatform
    || metadataProperties.get("sigma:target-arch") !== targetArch) {
    throw new Error("CycloneDX metadata target does not match the archive target.");
  }
  const integrityEntries = new Map(integrityManifest.entries.map((entry) => [entry.path, entry]));
  const componentsByPath = new Map();
  for (const component of sbom.components) {
    if (!Array.isArray(component?.properties)) continue;
    const properties = namedProperties(component.properties, `CycloneDX component ${String(component.name)}`);
    const componentPath = properties.get("sigma:path");
    if (!componentPath) continue;
    if (componentsByPath.has(componentPath)) throw new Error(`CycloneDX repeats portable asset component ${componentPath}.`);
    componentsByPath.set(componentPath, { component, properties });
  }
  const nodePath = `bin/${targetPlatform === "win32" ? "node.exe" : "node"}`;
  const brokerPath = `bin/${targetPlatform === "win32" ? "sigma-exec.exe" : "sigma-exec"}`;
  const tokenizerEntries = [...integrityEntries.values()]
    .filter((entry) => entry.path.startsWith("assets/tokenizers/"));
  if (tokenizerEntries.length === 0 || metadata.assets?.tokenizerAssets !== true) {
    throw new Error("CycloneDX verification requires bundled tokenizer assets.");
  }
  const requiredAssets = [
    { path: nodePath, kind: "node-runtime", metadataSha256: metadata.node?.sha256 },
    { path: brokerPath, kind: "native-broker", metadataSha256: metadata.sigmaExec?.sha256 },
    {
      path: portableLanguageAssets.typescriptServer,
      kind: "language-server",
      metadataSha256: metadata.assets?.languageServers?.find((item) => item?.id === "typescript")?.sha256
    },
    {
      path: portableLanguageAssets.typescriptEngine,
      kind: "language-service-engine",
      metadataSha256: metadata.assets?.languageServiceEngines?.find((item) => item?.id === "typescript")?.sha256
    },
    {
      path: portableLanguageAssets.pyrightServer,
      kind: "language-server",
      metadataSha256: metadata.assets?.languageServers?.find((item) => item?.id === "python")?.sha256
    },
    ...tokenizerEntries.map((entry) => ({ path: entry.path, kind: "tokenizer", metadataSha256: entry.sha256 }))
  ];
  for (const asset of requiredAssets) {
    const integrityEntry = integrityEntries.get(asset.path);
    if (!integrityEntry) throw new Error(`Integrity manifest is missing SBOM portable asset ${asset.path}.`);
    const record = componentsByPath.get(asset.path);
    if (!record) throw new Error(`CycloneDX SBOM is missing portable asset component ${asset.path}.`);
    if (record.component.type !== "file" || record.component.scope !== "required") {
      throw new Error(`CycloneDX portable asset ${asset.path} must be a required file component.`);
    }
    if (record.component["bom-ref"] !== `sigma:file:${asset.path}`) {
      throw new Error(`CycloneDX portable asset ${asset.path} has an invalid bom-ref.`);
    }
    if (record.properties.get("sigma:asset-kind") !== asset.kind) {
      throw new Error(`CycloneDX portable asset ${asset.path} has an invalid asset kind.`);
    }
    if (record.properties.get("sigma:target-platform") !== targetPlatform
      || record.properties.get("sigma:target-arch") !== targetArch) {
      throw new Error(`CycloneDX portable asset ${asset.path} has an invalid target.`);
    }
    const digest = componentSha256(record.component, `CycloneDX portable asset ${asset.path}`);
    if (digest !== integrityEntry.sha256 || digest !== asset.metadataSha256) {
      throw new Error(`CycloneDX portable asset ${asset.path} SHA-256 does not match integrity metadata.`);
    }
  }
  const node = componentsByPath.get(nodePath);
  if (node.component.version !== pinnedNodeVersion
    || node.properties.get("sigma:archive-sha256") !== metadata.node?.archiveSha256) {
    throw new Error("CycloneDX bundled Node component does not match Node metadata.");
  }
  const broker = componentsByPath.get(brokerPath);
  if (metadata.sigmaExec?.targetPlatform !== targetPlatform
    || metadata.sigmaExec?.targetArch !== targetArch
    || broker.properties.get("sigma:binary-format") !== metadata.sigmaExec?.format
    || broker.properties.get("sigma:machine") !== metadata.sigmaExec?.machine) {
    throw new Error("CycloneDX sigma-exec component does not match binary target metadata.");
  }
  return { portableAssets: requiredAssets.length, tokenizerAssets: tokenizerEntries.length };
}

async function verifyReleaseSidecars(archive, bundleDir, metadata, integrity, targetPlatform, targetArch) {
  const sidecars = metadata.sidecars;
  for (const key of ["checksum", "sbom", "provenance"]) {
    if (typeof sidecars?.[key] !== "string" || path.basename(sidecars[key]) !== sidecars[key]) {
      throw new Error(`V3 package metadata has an invalid ${key} sidecar name.`);
    }
  }
  const directory = path.dirname(archive);
  const checksumPath = path.join(directory, sidecars.checksum);
  const sbomPath = path.join(directory, sidecars.sbom);
  const provenancePath = path.join(directory, sidecars.provenance);
  const archiveSha256 = await sha256File(archive);
  const checksum = (await readFile(checksumPath, "utf8")).trim().split(/\s+/);
  if (checksum[0] !== archiveSha256 || checksum.at(-1) !== path.basename(archive)) {
    throw new Error("Portable archive SHA-256 sidecar does not match the archive.");
  }
  const bundledSbomPath = path.join(bundleDir, "sbom.cdx.json");
  if (await sha256File(sbomPath) !== await sha256File(bundledSbomPath)) {
    throw new Error("External CycloneDX SBOM does not match the bundled SBOM.");
  }
  const sbom = await readJson(bundledSbomPath);
  if (sbom.bomFormat !== "CycloneDX" || sbom.specVersion !== "1.5" || !Array.isArray(sbom.components)) {
    throw new Error("Bundled SBOM is not a CycloneDX 1.5 component inventory.");
  }
  const portableComponents = verifyPortableSbomComponents(
    sbom,
    integrity.manifest,
    metadata,
    targetPlatform,
    targetArch
  );
  const provenance = await readJson(provenancePath);
  const subject = Array.isArray(provenance.subject)
    ? provenance.subject.find((item) => item?.name === path.basename(archive))
    : null;
  if (provenance.predicateType !== "https://slsa.dev/provenance/v1" || subject?.digest?.sha256 !== archiveSha256) {
    throw new Error("Portable provenance does not bind the archive SHA-256 digest.");
  }
  return {
    archiveSha256,
    checksumPath,
    sbomPath,
    provenancePath,
    components: sbom.components.length,
    ...portableComponents
  };
}

async function workspaceReleaseVersion(rootDir) {
  for (const manifestPath of [path.join(rootDir, "package.json"), path.join(rootDir, "packages", "agent-cli", "package.json")]) {
    if (!existsSync(manifestPath)) continue;
    const version = String((await readJson(manifestPath)).version ?? "");
    if (version) return version;
  }
  return null;
}

function defaultArchivePath(rootDir, artifactsDir, targetPlatform, targetArch) {
  const bundleName = agentCliBundleName(targetPlatform, targetArch);
  return path.join(artifactsDir, targetPlatform === "win32" ? `${bundleName}.zip` : `${bundleName}.tgz`);
}

function parseVerifyArgs(argv) {
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
    } else if (arg === "--archive" && next) {
      options.archive = next;
      index += 1;
    } else if (arg === "--tarball" && next) {
      options.tarball = next;
      index += 1;
    } else if (arg === "--require-target-wrapper") {
      options.requireTargetWrapperSmoke = true;
    }
  }
  return options;
}

export async function verifyAgentCliPackage(options = {}) {
  const rootDir = options.rootDir ? path.resolve(options.rootDir) : defaultRootDir;
  const env = options.env ?? process.env;
  const targetPlatform = normalizeTargetPlatform(env.AGENT_TARGET_PLATFORM ?? options.targetPlatform ?? "linux");
  const targetArch = normalizeTargetArch(env.AGENT_TARGET_ARCH ?? options.targetArch ?? "x64");
  const artifactsDir = options.artifactsDir ? path.resolve(options.artifactsDir) : path.join(rootDir, ".artifacts");
  const bundleName = agentCliBundleName(targetPlatform, targetArch);
  const archive = path.resolve(
    options.archive
      ?? options.tarball
      ?? env.AGENT_CLI_ARCHIVE
      ?? (targetPlatform === "linux" ? env.AGENT_CLI_TARBALL : undefined)
      ?? defaultArchivePath(rootDir, artifactsDir, targetPlatform, targetArch)
  );

  if (!existsSync(archive)) {
    throw new Error(`agent CLI bundle not found: ${archive}\nRun pnpm package:agent-cli first.`);
  }

  const releaseVersion = await workspaceReleaseVersion(rootDir);
  const isV3 = releaseVersion !== null && /^3\./.test(releaseVersion);
  const workspacePackages = [...new Set([
    ...await workspaceRuntimePackages(rootDir),
    ...(isV3 ? v3PortablePackages : [])
  ])].sort((left, right) => left.localeCompare(right, "en"));
  const requiredEntries = [
    targetPlatform === "win32" ? `${bundleName}/bin/agent.cmd` : `${bundleName}/bin/agent`,
    targetPlatform === "win32" ? `${bundleName}/bin/node.exe` : `${bundleName}/bin/node`,
    `${bundleName}/README.md`,
      `${bundleName}/package.json`,
      `${bundleName}/package-metadata.json`,
    ...(isV3 ? [
      `${bundleName}/integrity-manifest.json`,
      `${bundleName}/sbom.cdx.json`,
      `${bundleName}/bin/${targetPlatform === "win32" ? "sigma-exec.exe" : "sigma-exec"}`,
      ...Object.values(portableLanguageAssets).map((assetPath) => `${bundleName}/${assetPath}`),
      `${bundleName}/assets/tokenizers/sigma-cjk-byte-v1.json`
    ] : []),
    ...workspacePackages.map((name) => `${bundleName}/packages/${name}/dist/index.js`),
    ...workspacePackages.filter((name) => name !== "agent-cli").map((name) => `${bundleName}/node_modules/${name}/package.json`)
  ];
  const spawn = options.spawnSync ?? spawnSync;
  const entries = targetPlatform === "win32" ? zipEntries(archive, spawn) : tarEntries(archive, spawn);
  requireEntries(entries, requiredEntries);
  if (entries.some((entry) => entry.includes("agent-core") || entry.includes("agent-ai"))) {
    throw new Error("Removed agent-core/agent-ai content must not be present in the bundle.");
  }

  await mkdir(artifactsDir, { recursive: true });
  const tempDir = await mkdtemp(path.join(artifactsDir, ".agent-cli-verify-"));
  try {
    if (targetPlatform === "win32") extractZipArchive(archive, tempDir, spawn);
    else extractTarball(archive, tempDir, spawn);
    const bundleDir = path.join(tempDir, bundleName);
    const wrapper = await readFile(path.join(bundleDir, "bin", targetPlatform === "win32" ? "agent.cmd" : "agent"), "utf8");
    const readme = await readFile(path.join(bundleDir, "README.md"), "utf8");
    const packageJson = await readJson(path.join(bundleDir, "package.json"));
    const metadata = await readJson(path.join(bundleDir, "package-metadata.json"));
    if (isV3 && metadata.schemaVersion !== 3) {
      throw new Error(`V3 package metadata schemaVersion=${String(metadata.schemaVersion)} expected 3.`);
    }

    if (targetPlatform === "win32") {
      assertContains("bin/agent.cmd", wrapper, '"%NODE_EXE%" "%SCRIPT_DIR%..\\packages\\agent-cli\\dist\\index.js" %*');
      if (wrapper.toLowerCase().includes("where node")) throw new Error("bin/agent.cmd must not fall back to a system Node runtime.");
    } else {
      assertContains("bin/agent", wrapper, 'exec "$NODE" "$SCRIPT_DIR/../packages/agent-cli/dist/index.js" "$@"');
      if (wrapper.includes("command -v node")) throw new Error("bin/agent must not fall back to a system Node runtime.");
    }
    assertContains("README.md", readme, "Sigma Code CLI Bundle");
    assertContains("README.md", readme, targetPlatform === "win32" ? String.raw`.\bin\agent.cmd version --json` : "./bin/agent version --json");
    assertContains("README.md", readme, targetPlatform === "win32" ? String.raw`.\bin\agent.cmd doctor --workspace D:\path\to\repo --json --strict` : "./bin/agent doctor --workspace /path/to/repo --json --strict");
    assertContains("README.md", readme, "Product Boundary");
    assertContains("README.md", readme, "never falls back to a system `node`");
    assertContains("README.md", readme, "benchmark identity, verifier output, rewards, scores, and hidden test details must not be fed back");

    if (packageJson.name !== `sigma-agent-cli-${targetPlatform}-${targetArch}`) {
      throw new Error(`bundle package.json has unexpected name: ${String(packageJson.name)}`);
    }
    if (releaseVersion !== null && packageJson.version !== releaseVersion) {
      throw new Error(`bundle package version=${String(packageJson.version)} expected ${releaseVersion}`);
    }
    if (metadata.targetPlatform !== targetPlatform) {
      throw new Error(`package-metadata targetPlatform=${String(metadata.targetPlatform)} expected ${targetPlatform}`);
    }
    if (metadata.targetArch !== targetArch) {
      throw new Error(`package-metadata targetArch=${String(metadata.targetArch)} expected ${targetArch}`);
    }
    if (metadata.node?.version !== pinnedNodeVersion) {
      throw new Error(`package-metadata node.version=${String(metadata.node?.version)} expected ${pinnedNodeVersion}`);
    }
    if (isV3 && !/^[a-f0-9]{64}$/.test(String(metadata.node?.archiveSha256 ?? ""))) {
      throw new Error("V3 package metadata is missing the verified Node runtime archive SHA-256.");
    }
    const verifiedIntegrity = isV3
      ? await verifyIntegrityManifest(bundleDir, metadata, targetPlatform, targetArch)
      : null;
    const binaryTarget = isV3
      ? await inspectSigmaExecBinary(path.join(bundleDir, verifiedIntegrity.brokerPath))
      : null;
    if (isV3 && (binaryTarget.targetPlatform !== targetPlatform || binaryTarget.targetArch !== targetArch)) {
      throw new Error([
        `Bundled sigma-exec target mismatch: expected ${targetPlatform}-${targetArch},`,
        `detected ${binaryTarget.targetPlatform}-${binaryTarget.targetArch} (${binaryTarget.format} machine ${binaryTarget.machine}).`
      ].join(" "));
    }
    if (isV3 && (metadata.sigmaExec?.format !== binaryTarget.format
      || metadata.sigmaExec?.machine !== binaryTarget.machine)) {
      throw new Error("Bundled sigma-exec executable header does not match package metadata.");
    }
    const integrity = verifiedIntegrity ? { ...verifiedIntegrity, binaryTarget } : null;
    const sidecars = isV3
      ? await verifyReleaseSidecars(archive, bundleDir, metadata, integrity, targetPlatform, targetArch)
      : null;
    if (isV3 && metadata.productVersion !== releaseVersion) {
      throw new Error(`package-metadata productVersion=${String(metadata.productVersion)} expected ${releaseVersion}`);
    }
    const hostCli = options.hostCliSmoke === false ? null : runHostCliVersion(bundleDir, spawn);
    const targetWrapper = options.targetWrapperSmoke === false
      ? { ok: false, status: "disabled", reason: "target wrapper smoke disabled" }
      : runTargetWrapperVersion(bundleDir, targetPlatform, targetArch, {
        spawnSync: spawn,
        platform: options.platform,
        arch: options.arch,
        env
      });
    if (requireTargetWrapperSmoke(options, env) && !targetWrapper.ok) {
      throw new Error(
        [
          "target wrapper smoke is required but did not pass",
          `status=${targetWrapper.status}`,
          targetWrapper.reason ? `reason=${targetWrapper.reason}` : null,
          targetWrapper.exitCode !== undefined ? `exit=${String(targetWrapper.exitCode)}` : null,
          targetWrapper.stdout ? `stdout:\n${targetWrapper.stdout}` : null,
          targetWrapper.stderr ? `stderr:\n${targetWrapper.stderr}` : null
        ].filter(Boolean).join("\n")
      );
    }
    if (targetWrapper.ok && targetWrapper.version?.runtime?.node !== pinnedNodeVersion) {
      throw new Error(`target wrapper node=${String(targetWrapper.version?.runtime?.node)} expected ${pinnedNodeVersion}`);
    }

    return {
      ok: true,
      archive,
      tarball: targetPlatform === "linux" ? archive : null,
      zip: targetPlatform === "win32" ? archive : null,
      bundleName,
      targetPlatform,
      targetArch,
      entries: entries.length,
      checks: {
        requiredEntries: requiredEntries.length,
        readme: true,
        wrapper: true,
        metadata: true,
        bundledNode: true,
        noSystemNodeFallback: true,
        sigmaExec: isV3 ? integrity !== null : null,
        languageServerAssets: isV3 ? integrity?.languageServerAssetsVerified === true : null,
        tokenizerAssets: isV3 ? integrity !== null : null,
        integrity: isV3 ? integrity !== null : null,
        sbom: isV3 ? sidecars !== null : null,
        provenance: isV3 ? sidecars !== null : null,
        archiveChecksum: isV3 ? sidecars !== null : null,
        hostCli: hostCli !== null,
        targetWrapper: targetWrapper.ok
      },
      hostCli,
      targetWrapper,
      integrity,
      sidecars,
      metadata
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const report = await verifyAgentCliPackage(parseVerifyArgs(process.argv.slice(2)));
    const artifactsDir = path.join(defaultRootDir, ".artifacts");
    const reportPath = path.join(artifactsDir, `agent-cli-package-verify-${report.targetPlatform}-${report.targetArch}.json`);
    const latestReportPath = path.join(artifactsDir, "agent-cli-package-verify.json");
    const serialized = `${JSON.stringify(report, null, 2)}\n`;
    await writeFile(reportPath, serialized, "utf8");
    await writeFile(latestReportPath, serialized, "utf8");
    console.log(`PASS agent-cli package verify ${path.relative(defaultRootDir, report.archive)}`);
    console.log(`Wrote ${path.relative(defaultRootDir, reportPath)}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
