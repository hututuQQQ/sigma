#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  agentCliBundleName,
  defaultRootDir,
  normalizeTargetPlatform,
  pinnedNodeVersion,
  normalizeTargetArch,
  workspaceRuntimePackages
} from "./package-agent-cli.mjs";

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
  const powerShell = runPowerShell(
    `$ErrorActionPreference = 'Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; $zip = [System.IO.Compression.ZipFile]::OpenRead(${psQuote(archive)}); try { $zip.Entries | ForEach-Object { $_.FullName } } finally { $zip.Dispose() }`,
    spawn
  );
  if (powerShell && !powerShell.error && powerShell.status === 0) {
    return powerShell.stdout.split(/\r?\n/).filter(Boolean);
  }

  const result = spawn("unzip", ["-Z1", archive], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`failed to list ${archive} as zip: ${result.stderr || result.stdout || powerShell?.stderr || powerShell?.stdout}`);
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
  const powerShell = runPowerShell(
    `$ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath ${psQuote(archive)} -DestinationPath ${psQuote(destination)} -Force`,
    spawn
  );
  if (powerShell && !powerShell.error && powerShell.status === 0) return;

  const result = spawn("unzip", ["-q", archive, "-d", destination], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`failed to extract ${archive} as zip: ${result.stderr || result.stdout || powerShell?.stderr || powerShell?.stdout}`);
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

  const workspacePackages = await workspaceRuntimePackages(rootDir);
  const requiredEntries = [
    targetPlatform === "win32" ? `${bundleName}/bin/agent.cmd` : `${bundleName}/bin/agent`,
    targetPlatform === "win32" ? `${bundleName}/bin/node.exe` : `${bundleName}/bin/node`,
    `${bundleName}/README.md`,
    `${bundleName}/package.json`,
    `${bundleName}/package-metadata.json`,
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

    if (targetPlatform === "win32") {
      assertContains("bin/agent.cmd", wrapper, '"%NODE_EXE%" "%SCRIPT_DIR%..\\packages\\agent-cli\\dist\\index.js" %*');
    } else {
      assertContains("bin/agent", wrapper, 'exec "$NODE" "$SCRIPT_DIR/../packages/agent-cli/dist/index.js" "$@"');
    }
    assertContains("README.md", readme, "Sigma Code CLI Bundle");
    assertContains("README.md", readme, targetPlatform === "win32" ? String.raw`.\bin\agent.cmd version --json` : "./bin/agent version --json");
    assertContains("README.md", readme, targetPlatform === "win32" ? String.raw`.\bin\agent.cmd doctor --workspace D:\path\to\repo --json --strict` : "./bin/agent doctor --workspace /path/to/repo --json --strict");
    assertContains("README.md", readme, "Product Boundary");
    assertContains("README.md", readme, "benchmark identity, verifier output, rewards, scores, and hidden test details must not be fed back");

    if (packageJson.name !== `sigma-agent-cli-${targetPlatform}-${targetArch}`) {
      throw new Error(`bundle package.json has unexpected name: ${String(packageJson.name)}`);
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
        hostCli: hostCli !== null,
        targetWrapper: targetWrapper.ok
      },
      hostCli,
      targetWrapper,
      metadata
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const report = await verifyAgentCliPackage(parseVerifyArgs(process.argv.slice(2)));
    const reportPath = path.join(defaultRootDir, ".artifacts", "agent-cli-package-verify.json");
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(`PASS agent-cli package verify ${path.relative(defaultRootDir, report.archive)}`);
    console.log(`Wrote ${path.relative(defaultRootDir, reportPath)}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
