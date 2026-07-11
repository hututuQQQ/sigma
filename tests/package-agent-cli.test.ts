import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, cp, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { packageAgentCli, pinnedNodeVersion } from "../scripts/package-agent-cli.mjs";
import {
  runTargetWrapperVersion,
  verifyAgentCliPackage,
  verifyPortableSbomComponents
} from "../scripts/verify-agent-cli-package.mjs";

async function writeBuiltPackage(
  rootDir: string,
  packageName: string,
  dependencies: Record<string, string> = {},
  version = "2.0.0"
) {
  const packageDir = path.join(rootDir, "packages", packageName);
  await mkdir(path.join(packageDir, "dist"), { recursive: true });
  const distIndex = packageName === "agent-cli"
    ? [
        "if (process.argv[2] === 'version' && process.argv.includes('--json')) {",
        `  process.stdout.write(JSON.stringify({ product: 'Sigma Code', package: { name: 'agent-cli', version: '${version}' }, runtime: { node: process.version } }) + '\\n');`,
        "}",
        "export {};",
        ""
      ].join("\n")
    : "export {};\n";
  await writeFile(path.join(packageDir, "dist", "index.js"), distIndex, "utf8");
  await writeFile(
    path.join(packageDir, "package.json"),
    `${JSON.stringify(
      {
        name: packageName,
        version,
        type: "module",
        main: "./dist/index.js",
        dependencies
      },
      null,
      2
    )}\n`,
    "utf8"
  );
}

async function writeExternalPackage(packageDir: string, manifest: Record<string, unknown>) {
  await mkdir(packageDir, { recursive: true });
  await writeFile(path.join(packageDir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await writeFile(path.join(packageDir, "index.js"), "export {};\n", "utf8");
}

async function writeFakeNodeRuntimeTarball(tmpDir: string, arch = "x64") {
  const runtimeRoot = path.join(tmpDir, "runtime");
  const runtimeDirName = `node-${pinnedNodeVersion}-linux-${arch}`;
  const runtimeDir = path.join(runtimeRoot, runtimeDirName);
  await mkdir(path.join(runtimeDir, "bin"), { recursive: true });
  const nodePath = path.join(runtimeDir, "bin", "node");
  await writeFile(nodePath, `#!/usr/bin/env sh
if [ "$1" = "--version" ]; then echo "${pinnedNodeVersion}"; exit 0; fi
if [ "$2" = "version" ]; then echo '{"product":"Sigma Code","package":{"name":"agent-cli","version":"2.0.0"},"runtime":{"node":"${pinnedNodeVersion}"}}'; exit 0; fi
exec "${process.execPath}" "$@"
`, "utf8");
  await chmod(nodePath, 0o755);

  const tarball = path.join(tmpDir, "node-runtime.tgz");
  const result = spawnSync("tar", ["-czf", tarball, "-C", runtimeRoot, runtimeDirName], {
    encoding: "utf8"
  });
  expect(result.status, result.stderr).toBe(0);
  return tarball;
}

function psQuote(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}

function runPowerShell(script: string) {
  const commands = process.platform === "win32" ? ["powershell.exe", "powershell", "pwsh"] : ["pwsh", "powershell"];
  for (const command of commands) {
    const result = spawnSync(command, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
      encoding: "utf8"
    });
    if (!result.error && result.status === 0) return result;
  }
  return null;
}

function commandAvailable(command: string, args: string[]) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  return !result.error && result.status === 0;
}

function windowsZipFixtureAvailable() {
  return runPowerShell("$PSVersionTable.PSVersion.ToString()") !== null
    || (commandAvailable("zip", ["-v"]) && commandAvailable("unzip", ["-v"]));
}

function runZip(args: string[], cwd: string) {
  const result = spawnSync("zip", args, {
    cwd,
    encoding: "utf8"
  });
  if (result.status !== 0) {
    throw new Error(`zip failed: ${result.stderr || result.stdout || result.error?.message}`);
  }
}

const windowsZipFixtureIt = windowsZipFixtureAvailable() ? it : it.skip;

async function writeFakeWindowsNodeRuntimeZip(tmpDir: string, arch = "x64") {
  const runtimeRoot = path.join(tmpDir, "runtime-win");
  const runtimeDirName = `node-${pinnedNodeVersion}-win-${arch}`;
  const runtimeDir = path.join(runtimeRoot, runtimeDirName);
  await mkdir(runtimeDir, { recursive: true });
  await cp(process.execPath, path.join(runtimeDir, "node.exe"));

  const archive = path.join(tmpDir, "node-runtime-win.zip");
  const powerShell = runPowerShell(
    `$ErrorActionPreference = 'Stop'; Compress-Archive -LiteralPath ${psQuote(runtimeDir)} -DestinationPath ${psQuote(archive)} -Force`
  );
  if (!powerShell) {
    runZip(["-qr", archive, runtimeDirName], runtimeRoot);
  }
  return archive;
}

async function writePackageFixture() {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "sigma-package-agent-cli-"));
  await writeBuiltPackage(rootDir, "agent-protocol");
  await writeBuiltPackage(rootDir, "agent-runtime", { "agent-protocol": "workspace:*" });
  await writeBuiltPackage(rootDir, "agent-tui", { "agent-protocol": "workspace:*" });
  await writeBuiltPackage(rootDir, "agent-cli", { "agent-runtime": "workspace:*", "agent-tui": "workspace:*" });
  return rootDir;
}

async function writeMinimalExecutable(
  filePath: string,
  targetPlatform: "linux" | "win32",
  targetArch: "x64" | "arm64" = "x64"
) {
  if (targetPlatform === "linux") {
    const header = Buffer.alloc(64);
    Buffer.from([0x7f, 0x45, 0x4c, 0x46]).copy(header, 0);
    header[4] = 2;
    header[5] = 1;
    header[6] = 1;
    header.writeUInt16LE(3, 16);
    header.writeUInt16LE(targetArch === "x64" ? 0x003e : 0x00b7, 18);
    await writeFile(filePath, header);
    return;
  }
  const header = Buffer.alloc(0x9a);
  header.write("MZ", 0, "ascii");
  header.writeUInt32LE(0x80, 0x3c);
  header.write("PE\0\0", 0x80, "binary");
  header.writeUInt16LE(targetArch === "x64" ? 0x8664 : 0xaa64, 0x84);
  header.writeUInt16LE(1, 0x86);
  header.writeUInt16LE(0x00f0, 0x94);
  header.writeUInt16LE(0x0002, 0x96);
  header.writeUInt16LE(0x020b, 0x98);
  await writeFile(filePath, header);
}

async function writeV3PackageFixture(
  brokerTarget: "linux" | "win32" = "linux",
  brokerArch: "x64" | "arm64" = "x64"
) {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "sigma-package-agent-cli-v3-"));
  const version = "3.0.0-beta.1";
  await writeFile(path.join(rootDir, "package.json"), `${JSON.stringify({ name: "sigma", version, private: true })}\n`, "utf8");
  await writeBuiltPackage(rootDir, "agent-protocol", {}, version);
  await writeBuiltPackage(rootDir, "agent-execution", {}, version);
  await writeBuiltPackage(rootDir, "agent-checkpoint", {}, version);
  await writeBuiltPackage(rootDir, "agent-extensions", {}, version);
  await writeBuiltPackage(rootDir, "agent-code-intel", {
    pyright: "1.1.411",
    typescript: "5.9.3"
  }, version);
  await writeFile(
    path.join(rootDir, "packages", "agent-code-intel", "dist", "typescript-server.mjs"),
    "export {};\n",
    "utf8"
  );
  await writeBuiltPackage(rootDir, "agent-runtime", { "agent-protocol": "workspace:*" }, version);
  await writeBuiltPackage(rootDir, "agent-cli", { "agent-runtime": "workspace:*" }, version);
  const modules = path.join(rootDir, "packages", "agent-code-intel", "node_modules");
  for (const [name, packageVersion, entry] of [
    ["pyright", "1.1.411", "langserver.index.js"],
    ["typescript", "5.9.3", "lib/typescript.js"]
  ] as const) {
    const packageDir = path.join(modules, name);
    await writeExternalPackage(packageDir, { name, version: packageVersion });
    const entryPath = path.join(packageDir, ...entry.split("/"));
    await mkdir(path.dirname(entryPath), { recursive: true });
    await writeFile(entryPath, "export {};\n", "utf8");
  }
  const tokenizerAsset = path.join(rootDir, "assets", "tokenizers", "sigma-cjk-byte-v1.json");
  await mkdir(path.dirname(tokenizerAsset), { recursive: true });
  await writeFile(tokenizerAsset, `${JSON.stringify({
    schemaVersion: 1,
    id: "sigma/cjk-byte-v1",
    accuracy: "approximate",
    safetyMarginPercent: 20
  })}\n`, "utf8");
  const broker = path.join(rootDir, "sigma-exec");
  await writeMinimalExecutable(broker, brokerTarget, brokerArch);
  return { rootDir, broker, version };
}

describe("package-agent-cli", () => {
  it("rejects non-Tier-1 architectures", async () => {
    await expect(packageAgentCli({ rootDir: process.cwd(), targetArch: "arm64" })).rejects.toThrow("AGENT_TARGET_ARCH");
  });

  it("creates the Linux x64 artifact with bin/agent and bundled node", async () => {
    const rootDir = await writePackageFixture();
    const runtimeTarball = await writeFakeNodeRuntimeTarball(rootDir);

    const result = await packageAgentCli({
      rootDir,
      env: {
        NODE_RUNTIME_TARBALL: runtimeTarball,
        AGENT_TARGET_ARCH: "x64"
      }
    });

    expect(path.basename(result.outputPath)).toBe("agent-cli-linux-x64.tgz");
    await expect(stat(path.join(result.bundleDir, "bin", "agent"))).resolves.toBeTruthy();
    await expect(stat(path.join(result.bundleDir, "bin", "node"))).resolves.toBeTruthy();

    const wrapper = await readFile(path.join(result.bundleDir, "bin", "agent"), "utf8");
    expect(wrapper).toContain('if [ ! -x "$NODE" ]; then');
    expect(wrapper).toContain('NODE="$SCRIPT_DIR/node"');
    expect(wrapper).not.toContain("command -v node");
    expect(wrapper).toContain("Sigma Code cannot start: the bundled Node runtime is missing or not executable.");
    expect(wrapper).toContain('exec "$NODE" "$SCRIPT_DIR/../packages/agent-cli/dist/index.js" "$@"');

    const listing = spawnSync("tar", ["-tzf", result.outputPath], { encoding: "utf8" });
    expect(listing.status, listing.stderr).toBe(0);
    expect(listing.stdout).toContain("agent-cli-linux-x64/bin/agent");
    expect(listing.stdout).toContain("agent-cli-linux-x64/bin/node");
    expect(listing.stdout).toContain("agent-cli-linux-x64/packages/agent-cli/dist/index.js");
    expect(listing.stdout).toContain("agent-cli-linux-x64/node_modules/agent-runtime/package.json");
    expect(listing.stdout).toContain("agent-cli-linux-x64/node_modules/agent-protocol/package.json");
    expect(listing.stdout).not.toContain("agent-core");

    const readme = await readFile(path.join(result.bundleDir, "README.md"), "utf8");
    expect(readme).toContain("Sigma Code CLI Bundle");
    expect(readme).toContain("./bin/agent init");
    expect(readme).toContain("./bin/agent version --json");
    expect(readme).toContain("./bin/agent doctor --workspace /path/to/repo --json --strict");
    expect(readme).toContain("./bin/agent inspect");
    expect(readme).toContain("./bin/agent sessions");
    expect(readme).toContain("Product Boundary");
    expect(readme).toContain("`version`, `init`, `doctor`");
    expect(readme).not.toContain("Harbor task containers");
  });

  it("recursively deploys target optional dependencies and preserves nested version conflicts", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "sigma-package-dependency-graph-"));
    await writeBuiltPackage(rootDir, "agent-tui", { "@opentui/core": "0.4.3", "root-dep": "1.0.0" });
    await writeBuiltPackage(rootDir, "agent-cli", { "agent-tui": "workspace:*" });
    const modules = path.join(rootDir, "packages", "agent-tui", "node_modules");
    const core = path.join(modules, "@opentui", "core");
    await writeExternalPackage(core, {
      name: "@opentui/core", version: "0.4.3", dependencies: { shared: "1.0.0" },
      optionalDependencies: {
        "@opentui/core-linux-x64": "0.4.3", "@opentui/core-linux-x64-musl": "0.4.3",
        "@opentui/core-win32-x64": "0.4.3"
      }
    });
    await mkdir(path.join(core, "node_modules"), { recursive: true });
    await writeFile(path.join(core, "node_modules", "source-only.txt"), "must not leak", "utf8");
    await writeExternalPackage(path.join(modules, "shared"), { name: "shared", version: "1.0.0" });
    await writeExternalPackage(path.join(modules, "root-dep"), {
      name: "root-dep", version: "1.0.0", dependencies: { shared: "2.0.0" }
    });
    await writeExternalPackage(path.join(modules, "root-dep", "node_modules", "shared"), {
      name: "shared", version: "2.0.0"
    });
    await writeExternalPackage(path.join(modules, "@opentui", "core-linux-x64"), {
      name: "@opentui/core-linux-x64", version: "0.4.3", os: ["linux"], cpu: ["x64"], libc: ["glibc"]
    });
    await writeExternalPackage(path.join(modules, "@opentui", "core-linux-x64-musl"), {
      name: "@opentui/core-linux-x64-musl", version: "0.4.3", os: ["linux"], cpu: ["x64"], libc: ["musl"]
    });
    await writeExternalPackage(path.join(modules, "@opentui", "core-win32-x64"), {
      name: "@opentui/core-win32-x64", version: "0.4.3", os: ["win32"], cpu: ["x64"]
    });
    const runtimeTarball = await writeFakeNodeRuntimeTarball(rootDir);
    const result = await packageAgentCli({
      rootDir, env: { NODE_RUNTIME_TARBALL: runtimeTarball, AGENT_TARGET_ARCH: "x64" }
    });

    const targetModules = path.join(result.bundleDir, "node_modules");
    await expect(stat(path.join(targetModules, "@opentui", "core-linux-x64", "package.json"))).resolves.toBeTruthy();
    await expect(stat(path.join(targetModules, "@opentui", "core-win32-x64", "package.json"))).rejects.toThrow();
    await expect(stat(path.join(targetModules, "@opentui", "core-linux-x64-musl", "package.json"))).rejects.toThrow();
    await expect(stat(path.join(targetModules, "@opentui", "core", "node_modules", "source-only.txt"))).rejects.toThrow();
    const nested = JSON.parse(await readFile(path.join(targetModules, "root-dep", "node_modules", "shared", "package.json"), "utf8"));
    expect(nested.version).toBe("2.0.0");
    const wrapper = await readFile(path.join(result.bundleDir, "bin", "agent"), "utf8");
    expect(wrapper).toContain('if [ "${1:-}" = "tui" ]; then');
    expect(wrapper).toContain("--experimental-ffi");
  });

  it("uses a cached Node runtime tarball when env override is absent", async () => {
    const rootDir = await writePackageFixture();
    const artifactsDir = path.join(rootDir, ".artifacts");
    const cacheDir = path.join(artifactsDir, "cache");
    await mkdir(cacheDir, { recursive: true });
    const runtimeTarball = await writeFakeNodeRuntimeTarball(rootDir);
    await writeFile(path.join(cacheDir, `node-${pinnedNodeVersion}-linux-x64.tar.xz`), await readFile(runtimeTarball));

    const result = await packageAgentCli({ rootDir, env: {}, artifactsDir });

    expect(result.source).toBe("cache");
    expect(result.downloaded).toBe(false);
    await expect(stat(path.join(result.bundleDir, "bin", "node"))).resolves.toBeTruthy();
  });

  it("auto-downloads the Node runtime tarball into cache when missing", async () => {
    const rootDir = await writePackageFixture();
    const sourceTarball = await writeFakeNodeRuntimeTarball(rootDir);
    const downloads: Array<{ url: string; destination: string }> = [];

    const result = await packageAgentCli({
      rootDir,
      env: {},
      downloader: async (url: string, destination: string) => {
        downloads.push({ url, destination });
        await mkdir(path.dirname(destination), { recursive: true });
        await writeFile(destination, await readFile(sourceTarball));
      }
    });

    expect(result.source).toBe("download");
    expect(result.downloaded).toBe(true);
    expect(downloads[0].url).toContain(`node-${pinnedNodeVersion}-linux-x64.tar.xz`);
    expect(downloads[0].destination).toContain(path.join(".artifacts", "cache"));
    const metadata = JSON.parse(await readFile(path.join(result.bundleDir, "package-metadata.json"), "utf8"));
    expect(metadata.node).toMatchObject({
      downloaded: true,
      source: "download",
      version: pinnedNodeVersion
    });
  });

  it("verifies the release bundle structure and product metadata", async () => {
    const rootDir = await writePackageFixture();
    const runtimeTarball = await writeFakeNodeRuntimeTarball(rootDir);
    const artifactsDir = path.join(rootDir, ".artifacts");
    const packaged = await packageAgentCli({
      rootDir,
      artifactsDir,
      env: {
        NODE_RUNTIME_TARBALL: runtimeTarball,
        AGENT_TARGET_ARCH: "x64"
      }
    });

    const report = await verifyAgentCliPackage({
      rootDir,
      artifactsDir,
      tarball: packaged.outputPath,
      targetArch: "x64",
      env: {},
      targetWrapperSmoke: false
    });

    expect(report).toMatchObject({
      ok: true,
      targetPlatform: "linux",
      bundleName: "agent-cli-linux-x64",
      targetArch: "x64",
      checks: {
        readme: true,
        wrapper: true,
        metadata: true,
        hostCli: true,
        targetWrapper: false
      },
      hostCli: {
        product: "Sigma Code",
        package: {
          name: "agent-cli",
          version: "2.0.0"
        }
      },
      metadata: {
        targetPlatform: "linux",
        targetArch: "x64",
        node: {
          version: pinnedNodeVersion,
          source: "env"
        }
      }
    });
    expect(report.targetWrapper).toMatchObject({
      ok: false,
      status: "disabled"
    });
    expect(report.entries).toBeGreaterThan(10);
  });

  it("rejects a renamed sigma-exec binary for a different target", async () => {
    const { rootDir, broker } = await writeV3PackageFixture("win32");
    const runtimeTarball = await writeFakeNodeRuntimeTarball(rootDir);
    const runtimeSha256 = createHash("sha256").update(await readFile(runtimeTarball)).digest("hex");

    await expect(packageAgentCli({
      rootDir,
      env: {
        NODE_RUNTIME_TARBALL: runtimeTarball,
        NODE_RUNTIME_SHA256: runtimeSha256,
        SIGMA_EXEC_BINARY: broker
      }
    })).rejects.toThrow("sigma-exec binary target mismatch: expected linux-x64, detected win32-x64");
  });

  it("rejects a sigma-exec binary for a different architecture", async () => {
    const { rootDir, broker } = await writeV3PackageFixture("linux", "arm64");
    const runtimeTarball = await writeFakeNodeRuntimeTarball(rootDir);
    const runtimeSha256 = createHash("sha256").update(await readFile(runtimeTarball)).digest("hex");

    await expect(packageAgentCli({
      rootDir,
      env: {
        NODE_RUNTIME_TARBALL: runtimeTarball,
        NODE_RUNTIME_SHA256: runtimeSha256,
        SIGMA_EXEC_BINARY: broker
      }
    })).rejects.toThrow("sigma-exec binary target mismatch: expected linux-x64, detected linux-arm64");
  });

  it("packages V3 broker/LSP assets with integrity, SBOM, checksum, and provenance", async () => {
    const { rootDir, broker, version } = await writeV3PackageFixture();
    const runtimeTarball = await writeFakeNodeRuntimeTarball(rootDir);
    const runtimeSha256 = createHash("sha256").update(await readFile(runtimeTarball)).digest("hex");
    const artifactsDir = path.join(rootDir, ".artifacts");
    const packaged = await packageAgentCli({
      rootDir,
      artifactsDir,
      env: {
        NODE_RUNTIME_TARBALL: runtimeTarball,
        NODE_RUNTIME_SHA256: runtimeSha256,
        SIGMA_EXEC_BINARY: broker
      }
    });
    const report = await verifyAgentCliPackage({
      rootDir,
      artifactsDir,
      archive: packaged.outputPath,
      targetPlatform: "linux",
      targetArch: "x64",
      targetWrapperSmoke: false,
      env: {}
    });

    expect(report).toMatchObject({
      ok: true,
      checks: {
        bundledNode: true,
        noSystemNodeFallback: true,
        sigmaExec: true,
        languageServerAssets: true,
        tokenizerAssets: true,
        integrity: true,
        sbom: true,
        provenance: true,
        archiveChecksum: true
      },
      metadata: {
        schemaVersion: 3,
        productVersion: version,
        node: { archiveSha256: runtimeSha256 },
        sigmaExec: { source: "env" }
      }
    });
    expect(report.sidecars).toMatchObject({
      portableAssets: 6,
      tokenizerAssets: 1
    });
    expect(report.sidecars.components).toBeGreaterThanOrEqual(11);

    const sbom = JSON.parse(await readFile(path.join(packaged.bundleDir, "sbom.cdx.json"), "utf8"));
    const integrity = JSON.parse(await readFile(path.join(packaged.bundleDir, "integrity-manifest.json"), "utf8"));
    const metadata = JSON.parse(await readFile(path.join(packaged.bundleDir, "package-metadata.json"), "utf8"));
    const missingBroker = structuredClone(sbom);
    missingBroker.components = missingBroker.components.filter(
      (component: { properties?: Array<{ name: string; value: string }> }) =>
        !component.properties?.some((property) => property.name === "sigma:path" && property.value === "bin/sigma-exec")
    );
    expect(() => verifyPortableSbomComponents(missingBroker, integrity, metadata, "linux", "x64"))
      .toThrow("CycloneDX SBOM is missing portable asset component bin/sigma-exec");

    const forgedTokenizer = structuredClone(sbom);
    const tokenizer = forgedTokenizer.components.find(
      (component: { properties?: Array<{ name: string; value: string }> }) =>
        component.properties?.some((property) => property.name === "sigma:asset-kind" && property.value === "tokenizer")
    );
    tokenizer.hashes[0].content = "0".repeat(64);
    expect(() => verifyPortableSbomComponents(forgedTokenizer, integrity, metadata, "linux", "x64"))
      .toThrow("SHA-256 does not match integrity metadata");
  });

  windowsZipFixtureIt("creates and verifies the Windows x64 artifact with agent.cmd and bundled node.exe", async () => {
    const rootDir = await writePackageFixture();
    const runtimeArchive = await writeFakeWindowsNodeRuntimeZip(rootDir);
    const artifactsDir = path.join(rootDir, ".artifacts");

    const result = await packageAgentCli({
      rootDir,
      artifactsDir,
      nodeVersionProbe: async () => pinnedNodeVersion,
      env: {
        NODE_RUNTIME_ARCHIVE: runtimeArchive,
        AGENT_TARGET_PLATFORM: "win32",
        AGENT_TARGET_ARCH: "x64"
      }
    });

    expect(path.basename(result.outputPath)).toBe("agent-cli-win32-x64.zip");
    expect(result.targetPlatform).toBe("win32");
    await expect(stat(path.join(result.bundleDir, "bin", "agent.cmd"))).resolves.toBeTruthy();
    await expect(stat(path.join(result.bundleDir, "bin", "node.exe"))).resolves.toBeTruthy();

    const wrapper = await readFile(path.join(result.bundleDir, "bin", "agent.cmd"), "utf8");
    expect(wrapper).toContain("set \"NODE_EXE=%SCRIPT_DIR%node.exe\"");
    expect(wrapper).not.toContain("where node");
    expect(wrapper).toContain("\"%NODE_EXE%\" \"%SCRIPT_DIR%..\\packages\\agent-cli\\dist\\index.js\" %*");

    const readme = await readFile(path.join(result.bundleDir, "README.md"), "utf8");
    expect(readme).toContain(String.raw`.\bin\agent.cmd doctor --workspace D:\path\to\repo --json --strict`);
    expect(readme).not.toContain(String.raw`.\bin\agent.cmd doctor --workspace /path/to/repo`);

    const report = await verifyAgentCliPackage({
      rootDir,
      artifactsDir,
      archive: result.outputPath,
      targetPlatform: "win32",
      targetArch: "x64",
      env: {},
      targetWrapperSmoke: false
    });

    expect(report).toMatchObject({
      ok: true,
      archive: result.outputPath,
      zip: result.outputPath,
      tarball: null,
      bundleName: "agent-cli-win32-x64",
      targetPlatform: "win32",
      targetArch: "x64",
      checks: {
        readme: true,
        wrapper: true,
        metadata: true,
        hostCli: true,
        targetWrapper: false
      },
      metadata: {
        targetPlatform: "win32",
        targetArch: "x64",
        node: {
          version: pinnedNodeVersion,
          source: "env"
        }
      }
    });
    expect(report.entries).toBeGreaterThan(10);
  }, 30_000);

  it("can require the target wrapper smoke for release environments", async () => {
    const rootDir = await writePackageFixture();
    const runtimeTarball = await writeFakeNodeRuntimeTarball(rootDir);
    const artifactsDir = path.join(rootDir, ".artifacts");
    const packaged = await packageAgentCli({
      rootDir,
      artifactsDir,
      env: {
        NODE_RUNTIME_TARBALL: runtimeTarball,
        AGENT_TARGET_ARCH: "x64"
      }
    });

    await expect(verifyAgentCliPackage({
      rootDir,
      artifactsDir,
      tarball: packaged.outputPath,
      targetArch: "x64",
      env: {
        AGENT_REQUIRE_TARGET_WRAPPER: "1"
      },
      targetWrapperSmoke: false
    })).rejects.toThrow("target wrapper smoke is required");
  });

  it("can verify the Linux wrapper through WSL on Windows hosts", () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnSync = (command: string, args: string[]) => {
      calls.push({ command, args });
      if (command === "wsl" && args.join(" ") === "-e sh -lc uname -m") {
        return { status: 0, stdout: "x86_64\n", stderr: "" };
      }
      if (command === "wsl" && args[0] === "-e" && args[3]?.includes("getconf GNU_LIBC_VERSION")) {
        return { status: 0, stdout: "glibc 2.39\n", stderr: "" };
      }
      if (command === "wsl" && args[0] === "wslpath") {
        return { status: 0, stdout: "/mnt/d/sigma/.artifacts/agent-cli-linux-x64\n", stderr: "" };
      }
      if (command === "wsl" && args[0] === "-e" && args[3]?.includes("./bin/agent version --json")) {
        return {
          status: 0,
          stdout: `${JSON.stringify({ product: "Sigma Code", package: { name: "agent-cli", version: "2.0.0" } })}\n`,
          stderr: ""
        };
      }
      return { status: 1, stdout: "", stderr: `unexpected call ${command} ${args.join(" ")}` };
    };

    const report = runTargetWrapperVersion("D:\\sigma\\.artifacts\\agent-cli-linux-x64", "x64", {
      platform: "win32",
      spawnSync
    });

    expect(report).toMatchObject({
      ok: true,
      status: "passed",
      transport: "wsl",
      machine: "x86_64",
      wslPath: "/mnt/d/sigma/.artifacts/agent-cli-linux-x64",
      version: {
        product: "Sigma Code",
        package: {
          name: "agent-cli",
          version: "2.0.0"
        }
      }
    });
    expect(calls.map((call) => call.command)).toEqual(["wsl", "wsl", "wsl", "wsl"]);
  });

  it("can verify the Windows wrapper through agent.cmd on Windows hosts", () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnSync = (command: string, args: string[]) => {
      calls.push({ command, args });
      if (command === "powershell.exe" && args.join(" ").includes("agent.cmd") && args.join(" ").includes("version --json")) {
        return {
          status: 0,
          stdout: `${JSON.stringify({ product: "Sigma Code", package: { name: "agent-cli", version: "2.0.0" } })}\n`,
          stderr: ""
        };
      }
      return { status: 1, stdout: "", stderr: `unexpected call ${command} ${args.join(" ")}` };
    };

    const report = runTargetWrapperVersion("D:\\sigma\\.artifacts\\agent-cli-win32-x64", "win32", "x64", {
      platform: "win32",
      arch: "x64",
      spawnSync
    });

    expect(report).toMatchObject({
      ok: true,
      status: "passed",
      transport: "native",
      version: {
        product: "Sigma Code",
        package: {
          name: "agent-cli",
          version: "2.0.0"
        }
      }
    });
    expect(calls[0].command).toBe("powershell.exe");
  });

  it("skips WSL wrapper verification when the WSL distro cannot run glibc Node", () => {
    const spawnSync = (command: string, args: string[]) => {
      if (command === "wsl" && args.join(" ") === "-e sh -lc uname -m") {
        return { status: 0, stdout: "x86_64\n", stderr: "" };
      }
      if (command === "wsl" && args[0] === "-e" && args[3]?.includes("getconf GNU_LIBC_VERSION")) {
        return { status: 0, stdout: "musl libc (x86_64)\n", stderr: "" };
      }
      return { status: 1, stdout: "", stderr: `unexpected call ${command} ${args.join(" ")}` };
    };

    expect(runTargetWrapperVersion("D:\\sigma\\.artifacts\\agent-cli-linux-x64", "x64", {
      platform: "win32",
      spawnSync
    })).toMatchObject({
      ok: false,
      status: "skipped",
      transport: "wsl",
      reason: "WSL distro does not provide glibc required by the official Linux Node runtime",
      libc: "musl libc (x86_64)"
    });
  });
});
