#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractArchiveBytes, inspectArchiveBytes } from "./archive-safety.mjs";
import { inspectPeAuthenticodeIdentity } from "./pe-authenticode-identity.mjs";
import {
  MAX_PROVENANCE_ENVELOPE_BYTES,
  loadTrustedReleaseProvenanceKeys,
  verifyProvenanceEnvelope
} from "./release-provenance-signing.mjs";
import { loadAllowedWindowsSignerCertificateSha256 } from "./windows-release-signing.mjs";
import {
  agentCliBundleName,
  defaultRootDir,
  inspectWindowsAuthenticode,
  inspectSigmaExecBinary,
  normalizeTargetPlatform,
  pinnedNodeVersion,
  normalizeTargetArch,
  windowsAppContainerNodeCompatibility,
  windowsNodeGlobalPipeMarker,
  windowsNodeLocalPipeMarker,
  v3PortablePackages,
  workspaceRuntimePackages
} from "./package-agent-cli.mjs";
import { compareGlibcVersions, inspectLinuxElf } from "./linux-elf.mjs";
import {
  assertLinuxRuntimeLibraryInventory,
  linuxCompatibilityImage,
  linuxMinimumGlibc,
  linuxNodeRpath,
  linuxRuntimeLibraryNames
} from "./linux-portable-runtime-config.mjs";

const portableLanguageAssets = Object.freeze({
  typescriptServer: "node_modules/agent-code-intel/dist/typescript-server.mjs",
  typescriptEngine: "node_modules/typescript/lib/typescript.js",
  pyrightServer: "node_modules/pyright/langserver.index.js"
});

function psQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
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

function dockerMount(source, target, readonly = false) {
  return `type=bind,source=${path.resolve(source)},target=${target}${readonly ? ",readonly" : ""}`;
}

function runDockerTargetWrapperVersion(bundleDir, targetArch, options) {
  const spawn = options.spawnSync ?? spawnSync;
  if (targetArch !== "x64") {
    return {
      ok: false,
      status: "skipped",
      transport: "docker",
      reason: `target wrapper Docker smoke supports x64; requested ${targetArch}`
    };
  }

  const server = spawn("docker", ["version", "--format", "{{.Server.Version}}"], {
    encoding: "utf8"
  });
  if (server.error || server.status !== 0) {
    return {
      ok: false,
      status: "skipped",
      transport: "docker",
      reason: "target wrapper smoke requires an available Docker server on Windows",
      stdout: server.stdout,
      stderr: server.stderr ?? server.error?.message ?? ""
    };
  }

  const command = "cd /opt/sigma && NO_COLOR=1 SIGMA_NO_COLOR=1 ./bin/agent version --json";
  const result = spawn("docker", [
    "run", "--rm", "--platform", "linux/amd64",
    "--mount", dockerMount(bundleDir, "/opt/sigma", true),
    linuxCompatibilityImage, "sh", "-lc", command
  ], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024
  });
  if (result.error || result.status !== 0) {
    return {
      ok: false,
      status: "failed",
      transport: "docker",
      image: linuxCompatibilityImage,
      exitCode: result.status,
      reason: result.error?.message,
      stdout: result.stdout,
      stderr: result.stderr
    };
  }

  const validated = validateTargetWrapperPayload(result.stdout, "Docker target wrapper smoke");
  if (!validated.ok) {
    return {
      ok: false,
      status: "failed",
      transport: "docker",
      image: linuxCompatibilityImage,
      reason: validated.reason,
      stdout: result.stdout,
      stderr: result.stderr
    };
  }
  return {
    ok: true,
    status: "passed",
    transport: "docker",
    image: linuxCompatibilityImage,
    dockerVersion: server.stdout.trim(),
    version: validated.version
  };
}

function windowsLinuxTargetTransport(options) {
  const value = options.linuxTargetTransport ?? options.env?.AGENT_LINUX_TARGET_TRANSPORT ?? "docker";
  if (value === "docker" || value === "wsl") return value;
  throw new Error(`AGENT_LINUX_TARGET_TRANSPORT must be docker or wsl; received ${String(value)}`);
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
  if (platform === "win32") {
    return windowsLinuxTargetTransport(options) === "wsl"
      ? runWslTargetWrapperVersion(bundleDir, targetArch, options)
      : runDockerTargetWrapperVersion(bundleDir, targetArch, options);
  }
  return {
    ok: false,
    status: "skipped",
    reason: `target wrapper smoke requires Linux or Windows+Docker; current platform is ${platform}`
  };
}

function requireTargetWrapperSmoke(options, env) {
  const value = options.requireTargetWrapperSmoke ?? env.AGENT_REQUIRE_TARGET_WRAPPER;
  return value === true || value === "1" || value === "true";
}

function requireLinuxCompatibility(options, env) {
  const value = options.requireLinuxCompatibility ?? env.AGENT_REQUIRE_LINUX_COMPATIBILITY;
  return value === true || value === "1" || value === "true";
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function readBoundedJson(filePath, maximumBytes, label) {
  const stats = await lstat(filePath);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size === 0 || stats.size > maximumBytes) {
    throw new Error(`${label} must be a non-empty regular file no larger than ${maximumBytes} bytes.`);
  }
  const bytes = await readFile(filePath);
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) throw new Error(`${label} is not canonical UTF-8.`);
  return JSON.parse(text);
}

async function sha256File(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

function bufferOccurrenceCount(buffer, marker) {
  let count = 0;
  let offset = 0;
  while (offset <= buffer.length - marker.length) {
    const found = buffer.indexOf(marker, offset);
    if (found < 0) break;
    count += 1;
    offset = found + 1;
  }
  return count;
}

function assertNodeCompatibilityRecord(record, label) {
  if (!record || typeof record !== "object") {
    throw new Error(`${label} must declare the approved Windows AppContainer Node compatibility patch.`);
  }
  for (const [name, expected] of Object.entries(windowsAppContainerNodeCompatibility)) {
    const matches = expected && typeof expected === "object"
      ? JSON.stringify(record[name]) === JSON.stringify(expected)
      : record[name] === expected;
    if (!matches) {
      throw new Error(`${label} has an invalid Windows AppContainer Node compatibility field ${name}.`);
    }
  }
}

function verifyWindowsNodeCompatibility(nodeBytes, metadata, manifest, nodeEntry, targetPlatform, targetArch) {
  if (targetPlatform !== "win32" || targetArch !== "x64") {
    if (metadata.node?.compatibility !== undefined || manifest.nodeCompatibility !== undefined) {
      throw new Error("Windows Node compatibility metadata must not appear on another target.");
    }
    return false;
  }
  assertNodeCompatibilityRecord(metadata.node?.compatibility, "Package metadata");
  assertNodeCompatibilityRecord(manifest.nodeCompatibility, "Integrity manifest");
  const identity = inspectPeAuthenticodeIdentity(nodeBytes, "Bundled Windows Node");
  if (identity.fullSha256 !== nodeEntry.sha256) {
    throw new Error("Bundled Windows Node full digest is inconsistent with its integrity entry.");
  }
  if (identity.normalizedContentSha256 !== windowsAppContainerNodeCompatibility.normalizedContentSha256) {
    throw new Error("Bundled Windows Node normalized content is not the approved AppContainer-compatible executable.");
  }
  const globalCount = bufferOccurrenceCount(nodeBytes, windowsNodeGlobalPipeMarker);
  const localCount = bufferOccurrenceCount(nodeBytes, windowsNodeLocalPipeMarker);
  if (globalCount !== 0 || localCount !== 1) {
    throw new Error(
      `Bundled Windows Node has an invalid AppContainer pipe marker layout (global=${globalCount}, local=${localCount}).`
    );
  }
  return true;
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

const glibcSystemLibraries = new Set([
  "ld-linux-x86-64.so.2", "libc.so.6", "libdl.so.2", "libm.so.6", "libpthread.so.0",
  "libresolv.so.2", "librt.so.1", "libutil.so.1"
]);

async function verifyLinuxCompatibility(bundleDir, metadata, manifest, entries, required) {
  const record = metadata.linuxCompatibility;
  if (!record) {
    if (required) throw new Error("Linux compatibility evidence is required but missing from package metadata.");
    if (manifest.linuxCompatibility !== undefined) {
      throw new Error("Integrity manifest has Linux compatibility evidence missing from package metadata.");
    }
    return false;
  }
  assertExactJson(manifest.linuxCompatibility, record, "Integrity Linux compatibility evidence");
  if (record.minimumGlibc !== linuxMinimumGlibc || record.validated !== true) {
    throw new Error(`Linux compatibility must be validated for GLIBC_${linuxMinimumGlibc}.`);
  }
  if (record.broker?.linkage !== "static-musl" || record.broker?.interpreter !== null
    || !Array.isArray(record.broker?.needed) || record.broker.needed.length > 0) {
    throw new Error("Linux compatibility metadata must declare a static-musl broker without dynamic dependencies.");
  }
  const broker = await inspectLinuxElf(path.join(bundleDir, "bin", "sigma-exec"));
  if (broker.interpreters.length > 0 || broker.needed.length > 0) {
    throw new Error("Bundled Linux sigma-exec has a dynamic interpreter or DT_NEEDED entry.");
  }

  const libraries = assertLinuxRuntimeLibraryInventory(
    record.runtimeLibraries,
    "Linux compatibility"
  );
  const bundledSonames = new Set();
  for (const library of libraries) {
    const expectedPath = `lib/${library.name}`;
    if (library.path !== expectedPath || !entries.has(expectedPath)) {
      throw new Error(`Integrity manifest does not cover Linux runtime library ${expectedPath}.`);
    }
    if (entries.get(expectedPath).sha256 !== library.sha256) {
      throw new Error(`Linux runtime library ${library.name} digest does not match compatibility metadata.`);
    }
    const elf = await inspectLinuxElf(path.join(bundleDir, "lib", library.name));
    if ((elf.soname ?? library.name) !== library.soname) {
      throw new Error(`Linux runtime library ${library.name} SONAME does not match compatibility metadata.`);
    }
    if (elf.maxGlibc && compareGlibcVersions(elf.maxGlibc, linuxMinimumGlibc) > 0) {
      throw new Error(`${library.name} exceeds the GLIBC_${linuxMinimumGlibc} compatibility ceiling.`);
    }
    bundledSonames.add(library.soname);
  }
  for (const library of libraries) {
    const unresolved = (library.needed ?? []).filter(
      (soname) => !glibcSystemLibraries.has(soname) && !bundledSonames.has(soname)
    );
    if (unresolved.length > 0) {
      throw new Error(`${library.name} has unresolved runtime dependencies: ${unresolved.join(", ")}.`);
    }
  }

  const node = await inspectLinuxElf(path.join(bundleDir, "bin", "node"));
  const effectiveRpath = node.runpath ?? node.rpath;
  if (effectiveRpath !== linuxNodeRpath || record.node?.rpath !== linuxNodeRpath) {
    throw new Error(`Bundled Linux Node must use relative RUNPATH ${linuxNodeRpath}.`);
  }
  if (node.maxGlibc && compareGlibcVersions(node.maxGlibc, linuxMinimumGlibc) > 0) {
    throw new Error(`Bundled Node exceeds the GLIBC_${linuxMinimumGlibc} compatibility ceiling.`);
  }
  const unresolved = node.needed.filter((soname) => !glibcSystemLibraries.has(soname) && !bundledSonames.has(soname));
  if (unresolved.length > 0) throw new Error(`Bundled Node has unresolved runtime dependencies: ${unresolved.join(", ")}.`);
  if (JSON.stringify(node.needed) !== JSON.stringify(record.node?.needed)
    || record.node?.maxGlibc !== node.maxGlibc || record.node?.dependenciesResolved !== true) {
    throw new Error("Bundled Node ELF requirements do not match Linux compatibility metadata.");
  }
  if (record.sandbox?.path !== "bin/bwrap" || !entries.has("bin/bwrap")
    || entries.get("bin/bwrap").sha256 !== record.sandbox.sha256) {
    throw new Error("Bundled bubblewrap is missing or does not match Linux compatibility metadata.");
  }
  const sandbox = await inspectLinuxElf(path.join(bundleDir, "bin", "bwrap"));
  const sandboxRpath = sandbox.runpath ?? sandbox.rpath;
  const unresolvedSandbox = sandbox.needed.filter(
    (soname) => !glibcSystemLibraries.has(soname) && !bundledSonames.has(soname)
  );
  if (sandboxRpath !== linuxNodeRpath || record.sandbox.rpath !== linuxNodeRpath
    || unresolvedSandbox.length > 0 || record.sandbox.dependenciesResolved !== true
    || (sandbox.maxGlibc && compareGlibcVersions(sandbox.maxGlibc, linuxMinimumGlibc) > 0)) {
    throw new Error("Bundled bubblewrap is not portable across the declared Linux compatibility range.");
  }
  return true;
}

async function verifyIntegrityManifest(bundleDir, metadata, targetPlatform, targetArch, linuxCompatibilityRequired = false) {
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
  const nodePath = `bin/${targetPlatform === "win32" ? "node.exe" : "node"}`;
  const entries = new Map();
  let verifiedNodeBytes;
  for (const entry of manifest.entries) {
    if (entries.has(entry.path)) throw new Error(`Duplicate portable integrity entry: ${entry.path}`);
    const absolute = safeBundlePath(bundleDir, entry.path);
    const stats = await lstat(absolute).catch(() => null);
    if (!stats?.isFile() || stats.isSymbolicLink()) throw new Error(`Integrity entry is not a regular file: ${entry.path}`);
    if (stats.size !== entry.size) throw new Error(`Integrity size mismatch for ${entry.path}`);
    const bytes = await readFile(absolute);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== entry.sha256) throw new Error(`Integrity SHA-256 mismatch for ${entry.path}`);
    if (entry.path === nodePath) verifiedNodeBytes = bytes;
    entries.set(entry.path, entry);
  }
  const brokerPath = `bin/${targetPlatform === "win32" ? "sigma-exec.exe" : "sigma-exec"}`;
  const requiredFiles = [
    nodePath,
    brokerPath,
    `bin/${targetPlatform === "win32" ? "agent.cmd" : "agent"}`,
    "package.json",
    "README.md",
    "LICENSE",
    ...Object.values(portableLanguageAssets),
    "assets/tokenizers/sigma-cjk-byte-v1.json",
    "sbom.cdx.json"
  ];
  if (metadata.linuxCompatibility) {
    requiredFiles.push(...linuxRuntimeLibraryNames.map((name) => `lib/${name}`));
    requiredFiles.push("bin/bwrap");
  }
  for (const required of requiredFiles) {
    if (!entries.has(required)) throw new Error(`Integrity manifest does not cover required portable asset: ${required}`);
  }
  const deliberatelyUnmanifested = new Set(["integrity-manifest.json", "package-metadata.json"]);
  const observedManifestEntries = new Set();
  async function verifyCompleteTree(absolute) {
    const stats = await lstat(absolute);
    const relative = path.relative(bundleDir, absolute).replaceAll(path.sep, "/");
    if (stats.isSymbolicLink()) throw new Error(`Portable bundle contains a symbolic link: ${relative}`);
    if (stats.isDirectory()) {
      for (const item of await readdir(absolute, { withFileTypes: true })) {
        await verifyCompleteTree(path.join(absolute, item.name));
      }
      return;
    }
    if (!stats.isFile()) throw new Error(`Portable bundle contains a non-regular entry: ${relative}`);
    if (deliberatelyUnmanifested.has(relative)) return;
    if (!entries.has(relative)) throw new Error(`Integrity manifest omits portable bundle file: ${relative}`);
    observedManifestEntries.add(relative);
  }
  await verifyCompleteTree(bundleDir);
  for (const manifestEntry of entries.keys()) {
    if (!observedManifestEntries.has(manifestEntry)) {
      throw new Error(`Integrity manifest path is not canonical bundle content: ${manifestEntry}`);
    }
  }
  if (metadata.node?.sha256 !== entries.get(nodePath).sha256) throw new Error("Bundled Node digest metadata does not match the manifest.");
  if (!verifiedNodeBytes) throw new Error("Integrity manifest did not yield bundled Node bytes.");
  const nodeCompatibilityVerified = verifyWindowsNodeCompatibility(
    verifiedNodeBytes,
    metadata,
    manifest,
    entries.get(nodePath),
    targetPlatform,
    targetArch
  );
  if (metadata.sigmaExec?.sha256 !== entries.get(brokerPath).sha256) throw new Error("sigma-exec digest metadata does not match the manifest.");
  const linuxCompatibilityVerified = targetPlatform === "linux"
    ? await verifyLinuxCompatibility(bundleDir, metadata, manifest, entries, linuxCompatibilityRequired)
    : false;
  if (targetPlatform !== "linux" && (metadata.linuxCompatibility !== undefined || manifest.linuxCompatibility !== undefined)) {
    throw new Error("Linux compatibility evidence must not appear on another target.");
  }
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
    node: entries.get(nodePath),
    sigmaExec: entries.get(brokerPath),
    sandbox: metadata.linuxCompatibility ? entries.get("bin/bwrap") : undefined,
    runtimeLibraries: Object.fromEntries(
      (metadata.linuxCompatibility?.runtimeLibraries ?? []).map((entry) => [entry.soname, entries.get(entry.path)])
    ),
    languageServerAssetsVerified: true,
    nodeCompatibilityVerified,
    linuxCompatibilityVerified,
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
    ...(metadata.linuxCompatibility?.sandbox ? [{
      path: metadata.linuxCompatibility.sandbox.path,
      kind: "sandbox-runtime",
      metadataSha256: metadata.linuxCompatibility.sandbox.sha256
    }] : []),
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
    ...tokenizerEntries.map((entry) => ({ path: entry.path, kind: "tokenizer", metadataSha256: entry.sha256 })),
    ...(metadata.linuxCompatibility?.runtimeLibraries ?? []).map((entry) => ({
      path: entry.path, kind: "runtime-library", metadataSha256: entry.sha256
    }))
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
  if (targetPlatform === "win32" && targetArch === "x64") {
    assertNodeCompatibilityRecord(metadata.node?.compatibility, "Package metadata");
    const compatibilityProperties = new Map([
      ["sigma:compatibility-kind", metadata.node.compatibility.kind],
      ["sigma:compatibility-patch-id", metadata.node.compatibility.patchId],
      ["sigma:compatibility-reason", metadata.node.compatibility.reason],
      ["sigma:source-sha256", metadata.node.compatibility.sourceSha256],
      ["sigma:normalized-content-sha256", metadata.node.compatibility.normalizedContentSha256],
      ["sigma:runtime-environment", JSON.stringify(metadata.node.compatibility.runtimeEnvironment)],
      ["sigma:runtime-environment-reason", metadata.node.compatibility.runtimeEnvironmentReason],
      ["sigma:sandbox-runtime-environment", JSON.stringify(metadata.node.compatibility.sandboxRuntimeEnvironment)],
      ["sigma:sandbox-runtime-environment-reason", metadata.node.compatibility.sandboxRuntimeEnvironmentReason]
    ]);
    for (const [name, expected] of compatibilityProperties) {
      if (node.properties.get(name) !== expected) {
        throw new Error(`CycloneDX bundled Node component has invalid compatibility property ${name}.`);
      }
    }
  }
  const broker = componentsByPath.get(brokerPath);
  if (metadata.sigmaExec?.targetPlatform !== targetPlatform
    || metadata.sigmaExec?.targetArch !== targetArch
    || broker.properties.get("sigma:binary-format") !== metadata.sigmaExec?.format
    || broker.properties.get("sigma:machine") !== metadata.sigmaExec?.machine) {
    throw new Error("CycloneDX sigma-exec component does not match binary target metadata.");
  }
  if (targetPlatform === "linux" && metadata.linuxCompatibility) {
    if (node.properties.get("sigma:minimum-glibc") !== metadata.linuxCompatibility.minimumGlibc
      || node.properties.get("sigma:rpath") !== metadata.linuxCompatibility.node.rpath
      || broker.properties.get("sigma:linkage") !== metadata.linuxCompatibility.broker.linkage) {
      throw new Error("CycloneDX Linux compatibility properties do not match package metadata.");
    }
    for (const library of metadata.linuxCompatibility.runtimeLibraries) {
      const component = componentsByPath.get(library.path);
      if (component?.properties.get("sigma:soname") !== library.soname) {
        throw new Error(`CycloneDX runtime library ${library.path} has an invalid SONAME.`);
      }
    }
  }
  return { portableAssets: requiredAssets.length, tokenizerAssets: tokenizerEntries.length };
}

function assertExactJson(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} does not match package metadata.`);
  }
}

function authenticodeArtifactEvidence(value) {
  return {
    required: value?.required,
    authenticodeVerified: value?.authenticodeVerified,
    observedSignerIds: value?.observedSignerIds,
    signatures: value?.signatures,
    sourceSignatureInvalidatedByPatch: value?.sourceSignatureInvalidatedByPatch,
    sourceSignatureStatus: value?.sourceSignatureStatus
  };
}

function verifyPortableProvenance(
  provenance,
  archive,
  archiveSha256,
  metadata,
  integrity,
  targetPlatform,
  targetArch
) {
  if (provenance?._type !== "https://in-toto.io/Statement/v1"
    || provenance?.predicateType !== "https://slsa.dev/provenance/v1") {
    throw new Error("Portable provenance has an unsupported statement or predicate type.");
  }
  const expectedSubject = [{ name: path.basename(archive), digest: { sha256: archiveSha256 } }];
  assertExactJson(provenance.subject, expectedSubject, "Portable provenance subject");
  const buildDefinition = provenance.predicate?.buildDefinition;
  if (buildDefinition?.buildType !== "https://sigma-code.dev/build-types/portable-cli/v3") {
    throw new Error("Portable provenance has an unexpected build type.");
  }
  assertExactJson(buildDefinition.externalParameters, {
    version: metadata.productVersion,
    targetPlatform,
    targetArch
  }, "Portable provenance external parameters");
  const windowsTarget = targetPlatform === "win32" && targetArch === "x64";
  if (windowsTarget) {
    assertNodeCompatibilityRecord(
      buildDefinition.internalParameters?.nodeCompatibility,
      "Portable provenance"
    );
  } else if (targetPlatform === "linux" && metadata.linuxCompatibility) {
    assertExactJson(
      buildDefinition.internalParameters?.linuxCompatibility,
      metadata.linuxCompatibility,
      "Portable provenance Linux compatibility evidence"
    );
    if (Object.keys(buildDefinition.internalParameters ?? {}).length !== 1) {
      throw new Error("Portable provenance has unexpected Linux internal parameters.");
    }
  } else if (buildDefinition.internalParameters !== undefined) {
    throw new Error("Portable provenance has unexpected internal parameters for a non-Windows target.");
  }
  const dependencies = buildDefinition.resolvedDependencies;
  if (!Array.isArray(dependencies)) {
    throw new Error("Portable provenance must declare resolved dependencies.");
  }
  const actualDependencies = new Map();
  for (const dependency of dependencies) {
    if (typeof dependency?.uri !== "string" || actualDependencies.has(dependency.uri)
      || !/^[a-f0-9]{64}$/u.test(String(dependency?.digest?.sha256 ?? ""))) {
      throw new Error("Portable provenance contains an invalid or duplicate resolved dependency.");
    }
    actualDependencies.set(dependency.uri, dependency.digest.sha256);
  }
  const nodePath = `bin/${windowsTarget ? "node.exe" : "node"}`;
  const expectedDependencies = new Map([
    ["pkg:generic/node-runtime-archive", metadata.node.archiveSha256],
    [`file:${nodePath}`, integrity.node.sha256],
    ["pkg:generic/sigma-exec", integrity.sigmaExec.sha256],
    ...(targetPlatform === "linux" && metadata.linuxCompatibility?.sandbox ? [[
      `pkg:generic/bubblewrap@${metadata.linuxCompatibility.sandbox.version}`,
      integrity.sandbox.sha256
    ]] : []),
    ["file:integrity-manifest.json", integrity.manifestDigest],
    ...(targetPlatform === "linux" ? Object.entries(integrity.runtimeLibraries ?? {}).map(([soname, entry]) => [
      `pkg:generic/${soname}`, entry.sha256
    ]) : []),
    ...(windowsTarget ? [[
      `pkg:generic/node-runtime-source@${pinnedNodeVersion}`,
      windowsAppContainerNodeCompatibility.sourceSha256
    ]] : [])
  ]);
  if (actualDependencies.size !== expectedDependencies.size) {
    throw new Error("Portable provenance resolved dependency set is incomplete or contains extras.");
  }
  for (const [uri, digest] of expectedDependencies) {
    if (actualDependencies.get(uri) !== digest) {
      throw new Error(`Portable provenance dependency ${uri} does not match its verified digest.`);
    }
  }
  const runDetails = provenance.predicate?.runDetails;
  if (runDetails?.builder?.id !== "https://sigma-code.dev/builders/local-portable-packager/v3") {
    throw new Error("Portable provenance has an unexpected builder identity.");
  }
  assertExactJson(runDetails.metadata, {
    invocationId: `${metadata.productVersion}:${targetPlatform}:${targetArch}`,
    signing: metadata.signing
  }, "Portable provenance run metadata");
  if (windowsTarget && (metadata.signing?.sourceSignatureInvalidatedByPatch !== true
    || metadata.signing?.sourceSignatureStatus !== "invalidated-by-deterministic-patch")) {
    throw new Error("Portable signing metadata must disclose deterministic Node patch signature invalidation.");
  }
}

async function verifyReleaseSidecars(
  archive,
  archiveSha256,
  bundleDir,
  metadata,
  integrity,
  targetPlatform,
  targetArch,
  trustedReleasePublicKeys
) {
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
  const provenanceEnvelope = await readBoundedJson(
    provenancePath,
    MAX_PROVENANCE_ENVELOPE_BYTES,
    "Portable provenance sidecar"
  );
  const verifiedEnvelope = verifyProvenanceEnvelope(provenanceEnvelope, trustedReleasePublicKeys);
  const provenance = verifiedEnvelope.statement;
  verifyPortableProvenance(
    provenance,
    archive,
    archiveSha256,
    metadata,
    integrity,
    targetPlatform,
    targetArch
  );
  return {
    archiveSha256,
    checksumPath,
    sbomPath,
    provenancePath,
    provenanceSignature: verifiedEnvelope.signature,
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
    } else if (arg === "--require-linux-compatibility") {
      options.requireLinuxCompatibility = true;
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
  const baseWorkspacePackages = await workspaceRuntimePackages(rootDir);
  const baseRequiredEntries = [
    targetPlatform === "win32" ? `${bundleName}/bin/agent.cmd` : `${bundleName}/bin/agent`,
    targetPlatform === "win32" ? `${bundleName}/bin/node.exe` : `${bundleName}/bin/node`,
    `${bundleName}/README.md`,
    `${bundleName}/LICENSE`,
    `${bundleName}/package.json`,
    `${bundleName}/package-metadata.json`,
    ...baseWorkspacePackages.map((name) => `${bundleName}/packages/${name}/dist/index.js`),
    ...baseWorkspacePackages.filter((name) => name !== "agent-cli")
      .map((name) => `${bundleName}/node_modules/${name}/package.json`)
  ];
  const spawn = options.spawnSync ?? spawnSync;
  const archiveBytes = await readFile(archive);
  const archiveSha256 = createHash("sha256").update(archiveBytes).digest("hex");
  const { entries } = inspectArchiveBytes(archiveBytes, {
    root: bundleName,
    label: `agent CLI archive ${path.basename(archive)}`,
    spawn
  });
  requireEntries(entries, baseRequiredEntries);
  if (entries.some((entry) => entry.includes("agent-core") || entry.includes("agent-ai"))) {
    throw new Error("Removed agent-core/agent-ai content must not be present in the bundle.");
  }

  await mkdir(artifactsDir, { recursive: true });
  const tempDir = await mkdtemp(path.join(artifactsDir, ".agent-cli-verify-"));
  try {
    extractArchiveBytes(archiveBytes, tempDir, `agent CLI archive ${path.basename(archive)}`, spawn);
    const bundleDir = path.join(tempDir, bundleName);
    const wrapper = await readFile(path.join(bundleDir, "bin", targetPlatform === "win32" ? "agent.cmd" : "agent"), "utf8");
    const readme = await readFile(path.join(bundleDir, "README.md"), "utf8");
    const license = await readFile(path.join(bundleDir, "LICENSE"), "utf8");
    const packageJson = await readJson(path.join(bundleDir, "package.json"));
    const metadata = await readJson(path.join(bundleDir, "package-metadata.json"));
    if (metadata.schemaVersion !== 2 && metadata.schemaVersion !== 3) {
      throw new Error(`Unsupported package metadata schemaVersion=${String(metadata.schemaVersion)}.`);
    }
    const isV3 = metadata.schemaVersion === 3;
    const expectedMajor = isV3 ? "3" : "2";
    if (typeof packageJson.version !== "string" || !packageJson.version.startsWith(`${expectedMajor}.`)) {
      throw new Error(`Package metadata schema ${metadata.schemaVersion} does not match version ${String(packageJson.version)}.`);
    }
    const workspacePackages = [...new Set([
      ...baseWorkspacePackages,
      ...(isV3 ? v3PortablePackages : [])
    ])].sort((left, right) => left.localeCompare(right, "en"));
    const requiredEntries = [
      ...baseRequiredEntries,
      ...(isV3 ? [
        `${bundleName}/integrity-manifest.json`,
        `${bundleName}/sbom.cdx.json`,
        `${bundleName}/bin/${targetPlatform === "win32" ? "sigma-exec.exe" : "sigma-exec"}`,
        ...Object.values(portableLanguageAssets).map((assetPath) => `${bundleName}/${assetPath}`),
        `${bundleName}/assets/tokenizers/sigma-cjk-byte-v1.json`
      ] : []),
      ...workspacePackages.map((name) => `${bundleName}/packages/${name}/dist/index.js`),
      ...workspacePackages.filter((name) => name !== "agent-cli")
        .map((name) => `${bundleName}/node_modules/${name}/package.json`)
    ];
    requireEntries(entries, requiredEntries);

    if (targetPlatform === "win32") {
      assertContains("bin/agent.cmd", wrapper, '"%NODE_EXE%" "%SCRIPT_DIR%..\\packages\\agent-cli\\dist\\index.js" %*');
      assertContains("bin/agent.cmd", wrapper, 'set "PATH=%SCRIPT_DIR%;%PATH%"');
      assertContains("bin/agent.cmd", wrapper, 'set "NODE_OPTIONS=--preserve-symlinks-main"');
      assertContains("bin/agent.cmd", wrapper, 'set "NODE_PATH="');
      if (wrapper.toLowerCase().includes("where node")) throw new Error("bin/agent.cmd must not fall back to a system Node runtime.");
    } else {
      assertContains("bin/agent", wrapper, 'exec "$NODE" "$SCRIPT_DIR/../packages/agent-cli/dist/index.js" "$@"');
      assertContains("bin/agent", wrapper, 'export PATH="$SCRIPT_DIR${PATH:+:$PATH}"');
      assertContains("bin/agent", wrapper, "unset NODE_OPTIONS NODE_PATH");
      if (wrapper.includes("command -v node")) throw new Error("bin/agent must not fall back to a system Node runtime.");
    }
    assertContains("README.md", readme, "Sigma Code CLI Bundle");
    assertContains("README.md", readme, targetPlatform === "win32" ? String.raw`.\bin\agent.cmd version --json` : "./bin/agent version --json");
    assertContains("README.md", readme, targetPlatform === "win32" ? String.raw`.\bin\agent.cmd doctor --workspace D:\path\to\repo --json --strict` : "./bin/agent doctor --workspace /path/to/repo --json --strict");
    assertContains("README.md", readme, "Product Boundary");
    assertContains("README.md", readme, "never falls back to a system `node`");
    assertContains("README.md", readme, "benchmark identity, verifier output, rewards, scores, and hidden test details must not be fed back");
    assertContains("LICENSE", license, "MIT License");

    if (packageJson.name !== `sigma-agent-cli-${targetPlatform}-${targetArch}`) {
      throw new Error(`bundle package.json has unexpected name: ${String(packageJson.name)}`);
    }
    if (packageJson.license !== "MIT") {
      throw new Error(`bundle package.json has unexpected license: ${String(packageJson.license)}`);
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
      ? await verifyIntegrityManifest(
          bundleDir, metadata, targetPlatform, targetArch,
          requireLinuxCompatibility(options, env)
        )
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
    const observedSigning = isV3
      ? inspectWindowsAuthenticode(
          path.join(bundleDir, verifiedIntegrity.nodePath),
          path.join(bundleDir, verifiedIntegrity.brokerPath),
          targetPlatform,
          metadata.node?.compatibility,
          options.allowedWindowsSignerCertificateSha256
            ?? loadAllowedWindowsSignerCertificateSha256(env)
        )
      : null;
    if (isV3 && JSON.stringify(authenticodeArtifactEvidence(observedSigning))
      !== JSON.stringify(authenticodeArtifactEvidence(metadata.signing))) {
      throw new Error("Portable signing metadata does not match independent artifact inspection.");
    }
    const integrity = verifiedIntegrity ? { ...verifiedIntegrity, binaryTarget } : null;
    const sidecars = isV3
      ? await verifyReleaseSidecars(
          archive,
          archiveSha256,
          bundleDir,
          metadata,
          integrity,
          targetPlatform,
          targetArch,
          options.trustedReleasePublicKeys ?? loadTrustedReleaseProvenanceKeys(env)
        )
      : null;
    if (metadata.productVersion !== packageJson.version) {
      throw new Error(`package-metadata productVersion=${String(metadata.productVersion)} expected ${String(packageJson.version)}`);
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
        license: true,
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
        provenanceSignature: isV3 ? sidecars?.provenanceSignature.verified === true : null,
        archiveChecksum: isV3 ? sidecars !== null : null,
        linuxCompatibility: isV3 && targetPlatform === "linux"
          ? integrity?.linuxCompatibilityVerified === true
          : null,
        windowsSignerPolicy: isV3
          ? targetPlatform !== "win32" || observedSigning?.policyVerified === true
          : null,
        hostCli: hostCli !== null,
        targetWrapper: targetWrapper.ok
      },
      hostCli,
      targetWrapper,
      integrity,
      sidecars,
      signing: observedSigning,
      metadata
    };
  } finally {
    await rm(tempDir, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 100
    });
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
