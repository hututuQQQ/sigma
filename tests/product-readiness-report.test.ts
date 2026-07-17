import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildProductReadinessReport,
  writeProductReadinessReport
} from "../scripts/product-readiness-report.mjs";

async function writeJson(filePath: string, value: unknown) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function fixture(targetWrapper: Record<string, unknown>, providerSmoke?: Record<string, unknown>, targetPlatform = "win32") {
  const rootDir = await mkdir(path.join(os.tmpdir(), `sigma-readiness-${Date.now()}-${Math.random().toString(16).slice(2)}`), { recursive: true });
  const artifactsDir = path.join(rootDir, ".artifacts");
  await writeJson(path.join(rootDir, "package.json"), {
    version: "2.0.0",
    scripts: {
      "verify:product": "pnpm lint && pnpm test && pnpm smoke:product && pnpm smoke:tui-product && pnpm verify:package:agent-cli:windows:structure && pnpm product:readiness"
    }
  });
  await writeJson(path.join(artifactsDir, "smoke-product", "product-smoke.json"), {
    ok: true,
    sessionId: "product-session",
    outcome: { kind: "completed" },
    sessions: 1,
    doctor: { status: "warning" }
  });
  await writeJson(path.join(artifactsDir, "smoke-tui-product", "tui-smoke.json"), {
    ok: true,
    sessionId: "tui-session",
    checks: {
      alternateScreen: true,
      cursorLifecycle: true,
      rawModeLifecycle: true,
      runCompleted: true,
      resize: true
    }
  });
  await writeJson(path.join(artifactsDir, "agent-cli-package-verify.json"), {
    ok: true,
    archive: path.join(artifactsDir, targetPlatform === "win32" ? "agent-cli-win32-x64.zip" : "agent-cli-linux-x64.tgz"),
    tarball: targetPlatform === "linux" ? path.join(artifactsDir, "agent-cli-linux-x64.tgz") : null,
    zip: targetPlatform === "win32" ? path.join(artifactsDir, "agent-cli-win32-x64.zip") : null,
    targetPlatform,
    targetArch: "x64",
    checks: {
      readme: true,
      wrapper: true,
      metadata: true,
      hostCli: true,
      targetWrapper: targetWrapper.ok === true
    },
    metadata: {
      schemaVersion: 2,
      productVersion: "2.0.0",
      sigmaExec: { sha256: "a".repeat(64) },
      node: { sha256: "c".repeat(64) },
      signing: { authenticodeVerified: targetPlatform === "win32" }
    },
    targetWrapper
  });
  await writeJson(path.join(artifactsDir, `sandbox-smoke-${targetPlatform}-x64.json`), {
    schemaVersion: 1,
    ready: true,
    targetPlatform,
    targetArch: "x64",
    brokerSha256: "a".repeat(64),
    backend: targetPlatform === "win32" ? "lpac+appcontainer+job-object+conpty" : "namespace+landlock+seccomp+pty"
  });
  await writeJson(path.join(artifactsDir, `lsp-sandbox-smoke-${targetPlatform}-x64.json`), {
    schemaVersion: 1,
    kind: "lspSandboxSmoke",
    ready: true,
    targetPlatform,
    targetArch: "x64",
    brokerPlatform: targetPlatform === "win32" ? "windows" : "linux",
    brokerArchitecture: "x86_64",
    brokerSha256: "a".repeat(64),
    bundledNodeSha256: "c".repeat(64),
    sandbox: { required: true, network: "none", writeRoots: [], selfTestPassed: true },
    checks: {
      typescript: { ready: true }, pyright: { ready: true },
      mcp: {
        ready: true, processStarted: true, initializeWriteDenied: true,
        idleWriteDenied: true, spawnCalls: 0
      }
    }
  });
  await writeJson(path.join(artifactsDir, "replay-v4-100k.json"), {
    schemaVersion: 1,
    kind: "v4Replay100k",
    ok: true,
    events: 100_000,
    elapsedMs: 5_000,
    peakRssMiB: 200,
    snapshotRebuilt: true
  });
  await writeJson(path.join(artifactsDir, "sigma-exec-branch-coverage.json"), {
    data: [{ files: [{
      filename: path.join(rootDir, "native", "sigma-exec", "src", "protocol.rs"),
      summary: {
        branches: { count: 12, covered: 12, notcovered: 0, percent: 100 },
        lines: { count: 177, covered: 177, percent: 100 }
      }
    }] }]
  });
  if (providerSmoke) {
    await writeJson(path.join(artifactsDir, "smoke-provider", "provider-smoke.json"), providerSmoke);
  }
  return { rootDir, artifactsDir };
}

async function promoteV3Evidence(
  rootDir: string,
  artifactsDir: string,
  {
    provenanceTrusted,
    windowsSignerPolicy,
    version = "4.0.0-rc.1"
  }: { provenanceTrusted: boolean; windowsSignerPolicy: boolean; version?: string }
) {
  const packageJsonPath = path.join(rootDir, "package.json");
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  packageJson.version = version;
  await writeJson(packageJsonPath, packageJson);
  const verificationPath = path.join(artifactsDir, "agent-cli-package-verify.json");
  const verification = JSON.parse(await readFile(verificationPath, "utf8"));
  Object.assign(verification.checks, {
    bundledNode: true,
    noSystemNodeFallback: true,
    sigmaExec: true,
    languageServerAssets: true,
    tokenizerAssets: true,
    integrity: true,
    sbom: true,
    provenance: true,
    provenanceSignature: provenanceTrusted,
    archiveChecksum: true,
    windowsSignerPolicy
  });
  verification.metadata.schemaVersion = 3;
  verification.metadata.productVersion = version;
  verification.metadata.signing = { authenticodeVerified: windowsSignerPolicy };
  verification.signing = { policyVerified: windowsSignerPolicy };
  verification.integrity = {
    manifestDigest: "d".repeat(64),
    manifest: { entries: [
      { path: "node_modules/agent-code-intel/dist/typescript-server.mjs", sha256: "e".repeat(64) },
      { path: "node_modules/pyright/langserver.index.js", sha256: "f".repeat(64) }
    ] }
  };
  await writeJson(verificationPath, verification);
  const lspPath = path.join(artifactsDir, "lsp-sandbox-smoke-win32-x64.json");
  const lsp = JSON.parse(await readFile(lspPath, "utf8"));
  lsp.productVersion = version;
  lsp.assets = {
    typescriptLanguageServerSha256: "e".repeat(64),
    pyrightSha256: "f".repeat(64)
  };
  lsp.integrityManifestSha256 = "d".repeat(64);
  lsp.checks.languageServerDiscovery = true;
  await writeJson(lspPath, lsp);
}

describe("product readiness report", () => {
  it("marks complete local evidence as internal-ready when wrapper is skipped", async () => {
    const { rootDir, artifactsDir } = await fixture({
      ok: false,
      status: "skipped",
      reason: "WSL distro does not provide glibc"
    });

    const report = await buildProductReadinessReport({ rootDir, artifactsDir });

    expect(report).toMatchObject({
      status: "internal-ready",
      internalReady: true,
      releaseReady: false,
      evidence: {
        productSmoke: { sessionId: "product-session" },
        tuiSmoke: { sessionId: "tui-session" }
      }
    });
    expect(report.releaseNotes[0]).toContain("win32-x64 CLI wrapper is not proven");
    expect(report.releaseNotes.some((item) => item.includes("Live provider smoke is not proven"))).toBe(true);
    expect(report.checks.every((item) => item.ok)).toBe(true);
    expect(report.releaseChecks.some((item) => item.name === "package:tier1Target" && item.ok)).toBe(true);
    expect(report.releaseChecks.some((item) => item.name === "providerSmoke:present" && !item.ok)).toBe(true);
    expect(report.releaseChecks.some((item) => item.name === "sandboxSmoke:ready" && item.ok)).toBe(true);
    expect(report.releaseChecks.some((item) => item.name === "lspSandboxSmoke:ready" && item.ok)).toBe(true);
  });

  it("marks release-ready when the target wrapper passed", async () => {
    const { rootDir, artifactsDir } = await fixture({
      ok: true,
      status: "passed",
      transport: "wsl"
    }, {
      ok: true,
      status: "passed",
      provider: "deepseek",
      model: "deepseek-v4-pro",
      sessionId: "provider-session",
      checks: {
        doctorApi: true,
        runCompleted: true,
        fileContent: true,
        inspect: true
      }
    });

    const report = await buildProductReadinessReport({ rootDir, artifactsDir });

    expect(report).toMatchObject({
      status: "release-ready",
      internalReady: true,
      releaseReady: true,
      evidence: {
        packageVerify: {
          targetPlatform: "win32"
        }
      }
    });
  });

  it("marks Linux x64 as an independent Tier 1 release target", async () => {
    const { rootDir, artifactsDir } = await fixture({
      ok: true,
      status: "passed",
      transport: "native"
    }, {
      ok: true,
      status: "passed",
      provider: "deepseek",
      checks: {
        doctorApi: true,
        runCompleted: true,
        fileContent: true,
        inspect: true
      }
    }, "linux");

    const report = await buildProductReadinessReport({ rootDir, artifactsDir });

    expect(report).toMatchObject({
      status: "release-ready",
      internalReady: true,
      releaseReady: true
    });
    expect(report.releaseChecks).toContainEqual({
      name: "package:tier1Target",
      ok: true,
      detail: "linux-x64"
    });
  });

  it("requires the replay snapshot to be rebuilt before release", async () => {
    const { rootDir, artifactsDir } = await fixture({
      ok: true,
      status: "passed",
      transport: "native"
    }, {
      ok: true,
      status: "passed",
      provider: "deepseek",
      checks: {
        doctorApi: true,
        runCompleted: true,
        fileContent: true,
        inspect: true
      }
    });
    const evidencePath = path.join(artifactsDir, "replay-v4-100k.json");
    const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
    evidence.snapshotRebuilt = false;
    await writeJson(evidencePath, evidence);

    const report = await buildProductReadinessReport({ rootDir, artifactsDir });

    expect(report.releaseReady).toBe(false);
    expect(report.releaseChecks).toContainEqual({
      name: "replayPerformance:snapshotRebuilt",
      ok: false,
      detail: "snapshotRebuilt=false"
    });
  });

  it("keeps structurally valid but externally untrusted V3 artifacts preview-only", async () => {
    const { rootDir, artifactsDir } = await fixture({
      ok: true,
      status: "passed",
      transport: "native"
    }, {
      ok: true,
      status: "passed",
      checks: { doctorApi: true, runCompleted: true, fileContent: true, inspect: true }
    });
    await promoteV3Evidence(rootDir, artifactsDir, {
      provenanceTrusted: false,
      windowsSignerPolicy: false
    });

    const report = await buildProductReadinessReport({ rootDir, artifactsDir });
    expect(report).toMatchObject({ status: "internal-ready", internalReady: true, releaseReady: false });
    expect(report.releaseChecks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "package:provenanceSignature", ok: false }),
      expect.objectContaining({ name: "package:windowsSignerPolicy", ok: false })
    ]));
  });

  it("requires both external provenance trust and approved Windows signer policy for V3 release", async () => {
    const { rootDir, artifactsDir } = await fixture({
      ok: true,
      status: "passed",
      transport: "native"
    }, {
      ok: true,
      status: "passed",
      checks: { doctorApi: true, runCompleted: true, fileContent: true, inspect: true }
    });
    await promoteV3Evidence(rootDir, artifactsDir, {
      provenanceTrusted: true,
      windowsSignerPolicy: true
    });

    const report = await buildProductReadinessReport({ rootDir, artifactsDir });
    expect(report).toMatchObject({ status: "release-ready", internalReady: true, releaseReady: true });
    expect(report.releaseChecks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "package:provenanceSignature", ok: true }),
      expect.objectContaining({ name: "package:windowsSignerPolicy", ok: true })
    ]));
  });

  it("fails closed for an unknown future major without disabling portable trust gates", async () => {
    const { rootDir, artifactsDir } = await fixture({
      ok: true,
      status: "passed",
      transport: "native"
    }, {
      ok: true,
      status: "passed",
      checks: { doctorApi: true, runCompleted: true, fileContent: true, inspect: true }
    });
    await promoteV3Evidence(rootDir, artifactsDir, {
      provenanceTrusted: true,
      windowsSignerPolicy: true,
      version: "5.0.0"
    });

    const report = await buildProductReadinessReport({ rootDir, artifactsDir });
    expect(report).toMatchObject({ status: "not-ready", internalReady: false, releaseReady: false });
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "productVersion:supportedMajor", ok: false }),
      expect.objectContaining({ name: "package:schemaVersion", ok: true }),
      expect.objectContaining({ name: "package:integrity", ok: true })
    ]));
    expect(report.releaseChecks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "package:provenanceSignature", ok: true }),
      expect.objectContaining({ name: "package:windowsSignerPolicy", ok: true })
    ]));
  });

  it("does not reuse readiness evidence from a different release target", async () => {
    const { rootDir, artifactsDir } = await fixture({ ok: true, status: "passed", transport: "native" });

    const report = await buildProductReadinessReport({
      rootDir,
      artifactsDir,
      targetPlatform: "linux",
      targetArch: "x64"
    });

    expect(report.internalReady).toBe(false);
    expect(report.checks).toContainEqual({
      name: "package:requestedTarget",
      ok: false,
      detail: "requested=linux-x64, evidence=win32-x64"
    });
  });

  it("binds V3 sandbox smoke evidence to the broker digest in the verified package", async () => {
    const { rootDir, artifactsDir } = await fixture({ ok: true, status: "passed", transport: "native" });
    const rootPackagePath = path.join(rootDir, "package.json");
    const rootPackage = JSON.parse(await readFile(rootPackagePath, "utf8"));
    rootPackage.version = "4.0.0-rc.1";
    await writeJson(rootPackagePath, rootPackage);
    const packagePath = path.join(artifactsDir, "agent-cli-package-verify.json");
    const packaged = JSON.parse(await readFile(packagePath, "utf8"));
    packaged.metadata.schemaVersion = 3;
    packaged.metadata.sigmaExec = { sha256: "b".repeat(64) };
    await writeJson(packagePath, packaged);

    const report = await buildProductReadinessReport({ rootDir, artifactsDir });
    expect(report.releaseChecks).toContainEqual({
      name: "sandboxSmoke:brokerDigest",
      ok: false,
      detail: `expected=${"b".repeat(64)}, evidence=${"a".repeat(64)}`
    });
    expect(report.releaseReady).toBe(false);
  });

  it("binds bundled LSP evidence to the package target, broker, Node, and sandbox policy", async () => {
    const { rootDir, artifactsDir } = await fixture({ ok: true, status: "passed", transport: "native" });
    const rootPackagePath = path.join(rootDir, "package.json");
    const rootPackage = JSON.parse(await readFile(rootPackagePath, "utf8"));
    rootPackage.version = "4.0.0-rc.1";
    await writeJson(rootPackagePath, rootPackage);
    const packagePath = path.join(artifactsDir, "agent-cli-package-verify.json");
    const packageReport = JSON.parse(await readFile(packagePath, "utf8"));
    packageReport.metadata.schemaVersion = 2;
    packageReport.metadata.productVersion = "4.0.0-rc.1";
    packageReport.integrity = { manifestDigest: "b".repeat(64), manifest: { entries: [
      { path: "node_modules/agent-code-intel/dist/typescript-server.mjs", sha256: "e".repeat(64) },
      { path: "node_modules/pyright/langserver.index.js", sha256: "f".repeat(64) }
    ] } };
    await writeJson(packagePath, packageReport);
    const evidencePath = path.join(artifactsDir, "lsp-sandbox-smoke-win32-x64.json");
    const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
    evidence.productVersion = "4.0.0-rc.1";
    evidence.assets = {
      typescriptLanguageServerSha256: "0".repeat(64),
      pyrightSha256: "f".repeat(64)
    };
    evidence.integrityManifestSha256 = "b".repeat(64);
    evidence.checks.languageServerDiscovery = true;
    evidence.brokerSha256 = "d".repeat(64);
    evidence.sandbox.writeRoots = ["unexpected"];
    await writeJson(evidencePath, evidence);

    const report = await buildProductReadinessReport({ rootDir, artifactsDir });

    expect(report.releaseChecks).toContainEqual({
      name: "lspSandboxSmoke:brokerDigest",
      ok: false,
      detail: `expected=${"a".repeat(64)}, evidence=${"d".repeat(64)}`
    });
    expect(report.releaseChecks.some((item) => item.name === "lspSandboxSmoke:policy" && !item.ok)).toBe(true);
    expect(report.releaseChecks.some((item) => item.name === "lspSandboxSmoke:typescriptDigest" && !item.ok)).toBe(true);
    expect(report.releaseChecks.some((item) => item.name === "lspSandboxSmoke:pyrightDigest" && item.ok)).toBe(true);
    expect(report.releaseChecks.some((item) => item.name === "lspSandboxSmoke:productVersion" && item.ok)).toBe(true);
    expect(report.releaseChecks.some((item) => item.name === "lspSandboxSmoke:integrityManifestDigest" && item.ok)).toBe(true);
    expect(report.checks.some((item) => item.name === "package:schemaVersion" && !item.ok)).toBe(true);
    expect(report.releaseReady).toBe(false);
  });

  it("writes JSON and Markdown and can require release readiness", async () => {
    const { rootDir, artifactsDir } = await fixture({
      ok: false,
      status: "skipped",
      reason: "no Linux host"
    });

    await expect(writeProductReadinessReport({
      rootDir,
      artifactsDir,
      requireReleaseReady: true
    })).rejects.toThrow("not release-ready");
    await expect(writeProductReadinessReport({
      rootDir,
      artifactsDir,
      requireProviderSmoke: true
    })).rejects.toThrow("live provider smoke");

    const { jsonPath, markdownPath, report } = await writeProductReadinessReport({ rootDir, artifactsDir });
    expect(report.status).toBe("internal-ready");
    expect(JSON.parse(await readFile(jsonPath, "utf8"))).toMatchObject({ status: "internal-ready" });
    const markdown = await readFile(markdownPath, "utf8");
    expect(markdown).toContain("# Sigma Code Product Readiness");
    expect(markdown).toContain("## Release Checks");
  });
});
