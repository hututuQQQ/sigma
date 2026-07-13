#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { supportedReleaseTargets } from "./package-agent-cli.mjs";

export const defaultRootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function bool(value) {
  return value === true || value === "true" || value === "1";
}

function check(name, ok, detail) {
  return { name, ok: Boolean(ok), detail };
}

function productMajor(version) {
  const match = String(version ?? "").match(/^([1-9][0-9]*)\./u);
  if (!match) return null;
  const major = Number(match[1]);
  return Number.isSafeInteger(major) ? major : null;
}

function assertEvidenceFile(filePath, label, checks) {
  checks.push(check(`${label}:exists`, existsSync(filePath), filePath));
}

function benchmarkNeutralScripts(packageJson) {
  const verifyProduct = String(packageJson.scripts?.["verify:product"] ?? "");
  return !verifyProduct.includes("bench:") && !verifyProduct.toLowerCase().includes("harbor");
}

function productGateScript(packageJson) {
  return String(packageJson.scripts?.["verify:product"] ?? "");
}

function productSmokeChecks(productSmoke) {
  return [
    check("productSmoke:ok", productSmoke?.ok === true, "product smoke completed"),
    check("productSmoke:sessionId", typeof productSmoke?.sessionId === "string" && productSmoke.sessionId.length > 0, productSmoke?.sessionId ?? "missing"),
    check("productSmoke:outcome", productSmoke?.outcome?.kind === "completed", productSmoke?.outcome?.kind ?? "missing"),
    check("productSmoke:sessions", Number(productSmoke?.sessions ?? 0) >= 1, `sessions=${String(productSmoke?.sessions ?? "missing")}`),
    check("productSmoke:doctor", typeof productSmoke?.doctor?.status === "string", productSmoke?.doctor?.status ?? "missing")
  ];
}

function tuiSmokeChecks(tuiSmoke) {
  const checks = tuiSmoke?.checks ?? {};
  return [
    check("tuiSmoke:ok", tuiSmoke?.ok === true, "TUI smoke completed"),
    check("tuiSmoke:sessionId", typeof tuiSmoke?.sessionId === "string" && tuiSmoke.sessionId.length > 0, tuiSmoke?.sessionId ?? "missing"),
    check("tuiSmoke:alternateScreen", checks.alternateScreen === true, "alternate screen lifecycle"),
    check("tuiSmoke:cursorLifecycle", checks.cursorLifecycle === true, "cursor hidden/restored"),
    check("tuiSmoke:rawModeLifecycle", checks.rawModeLifecycle === true, "raw mode enabled/restored"),
    check("tuiSmoke:runCompleted", checks.runCompleted === true, "fake-model run completed"),
    check("tuiSmoke:resize", checks.resize === true, "responsive resize verified")
  ];
}

function packageChecks(packageVerify, expectedV3) {
  const checks = packageVerify?.checks ?? {};
  return [
    check("package:ok", packageVerify?.ok === true, "package verification completed"),
    check("package:readme", checks.readme === true, "bundle README verified"),
    check("package:wrapper", checks.wrapper === true, "package wrapper verified"),
    check("package:metadata", checks.metadata === true, "package metadata verified"),
    check("package:schemaVersion", !expectedV3 || packageVerify?.metadata?.schemaVersion === 3, "V3 metadata schema"),
    check("package:bundledNode", !expectedV3 || checks.bundledNode === true, "pinned bundled Node verified"),
    check("package:noSystemNodeFallback", !expectedV3 || checks.noSystemNodeFallback === true, "wrapper cannot use system Node"),
    check("package:sigmaExec", !expectedV3 || checks.sigmaExec === true, "target-native sigma-exec verified"),
    check("package:languageServerAssets", !expectedV3 || checks.languageServerAssets === true, "bundled TypeScript/Python LSP assets verified"),
    check("package:tokenizerAssets", !expectedV3 || checks.tokenizerAssets === true, "versioned tokenizer-estimator assets verified"),
    check("package:integrity", !expectedV3 || checks.integrity === true, "portable SHA-256 manifest verified"),
    check("package:sbom", !expectedV3 || checks.sbom === true, "CycloneDX SBOM verified"),
    check("package:provenance", !expectedV3 || checks.provenance === true, "archive provenance verified"),
    check("package:archiveChecksum", !expectedV3 || checks.archiveChecksum === true, "archive SHA-256 sidecar verified"),
    check("package:hostCli", checks.hostCli === true, "host Node CLI smoke passed"),
    check("package:targetWrapperKnown", typeof packageVerify?.targetWrapper?.status === "string", packageVerify?.targetWrapper?.status ?? "missing")
  ];
}

function providerSmokeReleaseChecks(providerSmoke, providerSmokePath) {
  if (!providerSmoke) {
    return [
      check("providerSmoke:present", false, `${providerSmokePath} is missing`)
    ];
  }
  return [
    check("providerSmoke:ok", providerSmoke.ok === true, providerSmoke.status ?? "unknown"),
    check("providerSmoke:doctorApi", providerSmoke.checks?.doctorApi === true, "doctor --check-api passed"),
    check("providerSmoke:runCompleted", providerSmoke.checks?.runCompleted === true, "live-provider run completed"),
    check("providerSmoke:fileContent", providerSmoke.checks?.fileContent === true, "provider-smoke.md matched expected content"),
    check("providerSmoke:inspect", providerSmoke.checks?.inspect === true, "session inspection succeeded")
  ];
}

function sandboxSmokeReleaseChecks(sandboxSmoke, sandboxSmokePath, targetPlatform, targetArch, packageVerify, expectedV3) {
  const expectedDigest = String(packageVerify?.metadata?.sigmaExec?.sha256 ?? "");
  const actualDigest = String(sandboxSmoke?.brokerSha256 ?? "");
  const targetMatches = sandboxSmoke?.targetPlatform === targetPlatform && sandboxSmoke?.targetArch === targetArch;
  const backend = String(sandboxSmoke?.backend ?? "").toLowerCase();
  const backendMatches = targetPlatform === "win32"
    ? backend.includes("appcontainer") && backend.includes("conpty")
    : backend.length > 0;
  return [
    check("sandboxSmoke:present", Boolean(sandboxSmoke), sandboxSmokePath),
    check("sandboxSmoke:ready", sandboxSmoke?.schemaVersion === 1 && sandboxSmoke?.ready === true, sandboxSmoke?.ready === true ? "passed" : "missing"),
    check("sandboxSmoke:target", targetMatches, `requested=${targetPlatform}-${targetArch}, evidence=${sandboxSmoke?.targetPlatform ?? "missing"}-${sandboxSmoke?.targetArch ?? "missing"}`),
    check("sandboxSmoke:backend", backendMatches, sandboxSmoke?.backend ?? "missing"),
    check(
      "sandboxSmoke:brokerDigest",
      !expectedV3 || (/^[a-f0-9]{64}$/u.test(expectedDigest) && actualDigest === expectedDigest),
      expectedV3 ? `expected=${expectedDigest || "missing"}, evidence=${actualDigest || "missing"}` : "not required before V3"
    )
  ];
}

function lspSandboxSmokeReleaseChecks(lspSmoke, lspSmokePath, targetPlatform, targetArch, packageVerify, expectedV3) {
  const expectedBrokerDigest = String(packageVerify?.metadata?.sigmaExec?.sha256 ?? "");
  const expectedNodeDigest = String(packageVerify?.metadata?.node?.sha256 ?? "");
  const actualBrokerDigest = String(lspSmoke?.brokerSha256 ?? "");
  const actualNodeDigest = String(lspSmoke?.bundledNodeSha256 ?? "");
  const manifestEntries = Array.isArray(packageVerify?.integrity?.manifest?.entries)
    ? packageVerify.integrity.manifest.entries
    : [];
  const manifestDigest = (assetPath) => String(
    manifestEntries.find((entry) => entry?.path === assetPath)?.sha256 ?? ""
  );
  const expectedTypescriptDigest = manifestDigest("node_modules/agent-code-intel/dist/typescript-server.mjs");
  const expectedPyrightDigest = manifestDigest("node_modules/pyright/langserver.index.js");
  const actualTypescriptDigest = String(lspSmoke?.assets?.typescriptLanguageServerSha256 ?? "");
  const actualPyrightDigest = String(lspSmoke?.assets?.pyrightSha256 ?? "");
  const expectedManifestDigest = String(packageVerify?.integrity?.manifestDigest ?? "");
  const actualManifestDigest = String(lspSmoke?.integrityManifestSha256 ?? "");
  const brokerPlatforms = targetPlatform === "win32" ? ["win32", "windows"] : ["linux"];
  const brokerArchitectures = targetArch === "x64" ? ["x64", "x86_64", "amd64"] : [targetArch];
  const targetMatches = lspSmoke?.targetPlatform === targetPlatform && lspSmoke?.targetArch === targetArch
    && brokerPlatforms.includes(String(lspSmoke?.brokerPlatform ?? "").toLowerCase())
    && brokerArchitectures.includes(String(lspSmoke?.brokerArchitecture ?? "").toLowerCase());
  const policy = lspSmoke?.sandbox ?? {};
  return [
    check("lspSandboxSmoke:present", Boolean(lspSmoke), lspSmokePath),
    check(
      "lspSandboxSmoke:ready",
      lspSmoke?.schemaVersion === 1 && lspSmoke?.kind === "lspSandboxSmoke" && lspSmoke?.ready === true,
      lspSmoke?.ready === true ? "passed" : "missing"
    ),
    check("lspSandboxSmoke:target", targetMatches, `requested=${targetPlatform}-${targetArch}, evidence=${lspSmoke?.targetPlatform ?? "missing"}-${lspSmoke?.targetArch ?? "missing"}`),
    check(
      "lspSandboxSmoke:productVersion",
      !expectedV3 || lspSmoke?.productVersion === packageVerify?.metadata?.productVersion,
      `package=${String(packageVerify?.metadata?.productVersion ?? "missing")}, evidence=${String(lspSmoke?.productVersion ?? "missing")}`
    ),
    check(
      "lspSandboxSmoke:brokerDigest",
      /^[a-f0-9]{64}$/u.test(expectedBrokerDigest) && actualBrokerDigest === expectedBrokerDigest,
      `expected=${expectedBrokerDigest || "missing"}, evidence=${actualBrokerDigest || "missing"}`
    ),
    check(
      "lspSandboxSmoke:bundledNodeDigest",
      /^[a-f0-9]{64}$/u.test(expectedNodeDigest) && actualNodeDigest === expectedNodeDigest,
      `expected=${expectedNodeDigest || "missing"}, evidence=${actualNodeDigest || "missing"}`
    ),
    check(
      "lspSandboxSmoke:typescriptDigest",
      !expectedV3 || (/^[a-f0-9]{64}$/u.test(expectedTypescriptDigest) && actualTypescriptDigest === expectedTypescriptDigest),
      `expected=${expectedTypescriptDigest || "missing"}, evidence=${actualTypescriptDigest || "missing"}`
    ),
    check(
      "lspSandboxSmoke:pyrightDigest",
      !expectedV3 || (/^[a-f0-9]{64}$/u.test(expectedPyrightDigest) && actualPyrightDigest === expectedPyrightDigest),
      `expected=${expectedPyrightDigest || "missing"}, evidence=${actualPyrightDigest || "missing"}`
    ),
    check(
      "lspSandboxSmoke:policy",
      policy.required === true && policy.network === "none" && Array.isArray(policy.writeRoots)
        && policy.writeRoots.length === 0 && policy.selfTestPassed === true,
      `required=${String(policy.required)}, network=${String(policy.network)}, writeRoots=${JSON.stringify(policy.writeRoots ?? null)}`
    ),
    check(
      "lspSandboxSmoke:integrityManifestDigest",
      !expectedV3 || (/^[a-f0-9]{64}$/u.test(expectedManifestDigest) && actualManifestDigest === expectedManifestDigest),
      `expected=${expectedManifestDigest || "missing"}, evidence=${actualManifestDigest || "missing"}`
    ),
    check("lspSandboxSmoke:discovery", !expectedV3 || lspSmoke?.checks?.languageServerDiscovery === true, "packaged default discovery"),
    check("lspSandboxSmoke:typescript", lspSmoke?.checks?.typescript?.ready === true, "symbols/definition/references/hover/rename"),
    check("lspSandboxSmoke:pyright", lspSmoke?.checks?.pyright?.ready === true, "diagnostics"),
    check(
      "lspSandboxSmoke:mcpReadOnly",
      lspSmoke?.checks?.mcp?.ready === true
        && lspSmoke?.checks?.mcp?.processStarted === true
        && lspSmoke?.checks?.mcp?.initializeWriteDenied === true
        && lspSmoke?.checks?.mcp?.idleWriteDenied === true
        && lspSmoke?.checks?.mcp?.spawnCalls === 0,
      "initialize/idle writes denied and unsafe capabilities rejected before spawn"
    )
  ];
}

function migrationPerformanceReleaseChecks(performance, performancePath) {
  return [
    check("migrationPerformance:present", Boolean(performance), performancePath),
    check(
      "migrationPerformance:100k",
      performance?.schemaVersion === 1 && performance?.kind === "v2Migration100k"
        && performance?.ok === true && performance?.events === 100_000,
      `events=${String(performance?.events ?? "missing")}, ok=${String(performance?.ok ?? false)}`
    ),
    check(
      "migrationPerformance:memory",
      Number(performance?.peakRssMiB) < 256,
      `peakRssMiB=${String(performance?.peakRssMiB ?? "missing")}`
    ),
    check(
      "migrationPerformance:sourceUnchanged",
      performance?.sourceUnchanged === true,
      `sourceUnchanged=${String(performance?.sourceUnchanged ?? false)}`
    )
  ];
}

function nativeProtocolCoverageSummary(report) {
  const files = Array.isArray(report?.data)
    ? report.data.flatMap((entry) => Array.isArray(entry?.files) ? entry.files : [])
    : [];
  const file = files.find((item) => String(item?.filename ?? "").replaceAll("\\", "/")
    .endsWith("/native/sigma-exec/src/protocol.rs"));
  return file?.summary ?? null;
}

function nativeProtocolCoverageReleaseChecks(report, reportPath) {
  const summary = nativeProtocolCoverageSummary(report);
  const branches = Number(summary?.branches?.percent);
  const branchCount = Number(summary?.branches?.count);
  const lines = Number(summary?.lines?.percent);
  return [
    check("nativeProtocolCoverage:present", Boolean(report), reportPath),
    check(
      "nativeProtocolCoverage:branches",
      branchCount > 0 && branches >= 95,
      `branches=${Number.isFinite(branches) ? branches : "missing"}%, count=${Number.isFinite(branchCount) ? branchCount : "missing"}`
    ),
    check(
      "nativeProtocolCoverage:lines",
      lines >= 95,
      `lines=${Number.isFinite(lines) ? lines : "missing"}%`
    )
  ];
}

function markdownReport(report) {
  const lines = [
    "# Sigma Code Product Readiness",
    "",
    `- status: ${report.status}`,
    `- internalReady: ${String(report.internalReady)}`,
    `- releaseReady: ${String(report.releaseReady)}`,
    `- generatedAt: ${report.generatedAt}`,
    "",
    "## Evidence",
    "",
    `- product smoke: ${report.evidence.productSmoke.path}`,
    `- TUI smoke: ${report.evidence.tuiSmoke.path}`,
    `- package verify: ${report.evidence.packageVerify.path}`,
    `- package target: ${report.evidence.packageVerify.targetPlatform ?? "unknown"}`,
    `- sandbox smoke: ${report.evidence.sandboxSmoke.path}`,
    `- LSP sandbox smoke: ${report.evidence.lspSandboxSmoke.path}`,
    `- V2 migration performance: ${report.evidence.migrationPerformance.path}`,
    `- native protocol coverage: ${report.evidence.nativeProtocolCoverage.path}`,
    "",
    "## Checks",
    "",
    ...report.checks.map((item) => `- [${item.ok ? "x" : " "}] ${item.name}: ${item.detail}`),
    "",
    "## Release Checks",
    "",
    ...report.releaseChecks.map((item) => `- [${item.ok ? "x" : " "}] ${item.name}: ${item.detail}`),
    "",
    "## Release Notes",
    "",
    ...report.releaseNotes.map((item) => `- ${item}`),
    ""
  ];
  return lines.join("\n");
}

export async function buildProductReadinessReport(options = {}) {
  const rootDir = options.rootDir ? path.resolve(options.rootDir) : defaultRootDir;
  const artifactsDir = options.artifactsDir ? path.resolve(options.artifactsDir) : path.join(rootDir, ".artifacts");
  const packageJsonPath = path.join(rootDir, "package.json");
  const productSmokePath = path.join(artifactsDir, "smoke-product", "product-smoke.json");
  const tuiSmokePath = path.join(artifactsDir, "smoke-tui-product", "tui-smoke.json");
  const requestedPlatform = options.targetPlatform ?? process.env.AGENT_TARGET_PLATFORM;
  const requestedArch = options.targetArch ?? process.env.AGENT_TARGET_ARCH ?? "x64";
  const targetedPackageVerifyPath = requestedPlatform
    ? path.join(artifactsDir, `agent-cli-package-verify-${requestedPlatform}-${requestedArch}.json`)
    : null;
  const packageVerifyPath = targetedPackageVerifyPath && existsSync(targetedPackageVerifyPath)
    ? targetedPackageVerifyPath
    : path.join(artifactsDir, "agent-cli-package-verify.json");
  const providerSmokePath = path.join(artifactsDir, "smoke-provider", "provider-smoke.json");
  const migrationPerformancePath = path.join(artifactsDir, "migration-v2-100k.json");
  const nativeProtocolCoveragePath = path.join(artifactsDir, "sigma-exec-branch-coverage.json");
  const checks = [];

  assertEvidenceFile(productSmokePath, "productSmoke", checks);
  assertEvidenceFile(tuiSmokePath, "tuiSmoke", checks);
  assertEvidenceFile(packageVerifyPath, "packageVerify", checks);

  const [
    packageJson, productSmoke, tuiSmoke, packageVerify, providerSmoke,
    migrationPerformance, nativeProtocolCoverage
  ] = await Promise.all([
    readJson(packageJsonPath),
    existsSync(productSmokePath) ? readJson(productSmokePath) : Promise.resolve(null),
    existsSync(tuiSmokePath) ? readJson(tuiSmokePath) : Promise.resolve(null),
    existsSync(packageVerifyPath) ? readJson(packageVerifyPath) : Promise.resolve(null),
    existsSync(providerSmokePath) ? readJson(providerSmokePath) : Promise.resolve(null),
    existsSync(migrationPerformancePath) ? readJson(migrationPerformancePath) : Promise.resolve(null),
    existsSync(nativeProtocolCoveragePath) ? readJson(nativeProtocolCoveragePath) : Promise.resolve(null)
  ]);

  const targetPlatform = requestedPlatform ?? packageVerify?.targetPlatform ?? "linux";
  const targetArch = requestedPlatform ? requestedArch : (packageVerify?.targetArch ?? requestedArch);
  const sandboxSmokePath = path.join(artifactsDir, `sandbox-smoke-${targetPlatform}-${targetArch}.json`);
  const sandboxSmoke = existsSync(sandboxSmokePath) ? await readJson(sandboxSmokePath) : null;
  const lspSandboxSmokePath = path.join(artifactsDir, `lsp-sandbox-smoke-${targetPlatform}-${targetArch}.json`);
  const lspSandboxSmoke = existsSync(lspSandboxSmokePath) ? await readJson(lspSandboxSmokePath) : null;

  const verifyProductScript = productGateScript(packageJson);
  checks.push(check("productGate:benchmarkNeutral", benchmarkNeutralScripts(packageJson), "verify:product excludes bench/Harbor adapters"));
  checks.push(check("productGate:noLiveProviderSmoke", !verifyProductScript.includes("smoke:provider"), "verify:product excludes live provider smoke"));
  checks.push(check("productGate:noRequiredTargetWrapper", !verifyProductScript.includes("--require-target-wrapper"), "verify:product does not require target wrapper smoke"));
  if (requestedPlatform) {
    checks.push(check(
      "package:requestedTarget",
      packageVerify?.targetPlatform === requestedPlatform && packageVerify?.targetArch === requestedArch,
      `requested=${requestedPlatform}-${requestedArch}, evidence=${packageVerify?.targetPlatform ?? "missing"}-${packageVerify?.targetArch ?? "missing"}`
    ));
  }
  checks.push(...productSmokeChecks(productSmoke));
  checks.push(...tuiSmokeChecks(tuiSmoke));
  const expectedProductVersion = String(packageJson.version ?? "");
  const expectedProductMajor = productMajor(expectedProductVersion);
  // V3 introduced the portable trust contract. Every later major must retain
  // those gates, while an unknown major remains unsupported until its package
  // schema is reviewed explicitly.
  const expectedV3 = expectedProductMajor !== null && expectedProductMajor >= 3;
  const supportedProductMajor = expectedProductMajor === 2 || expectedProductMajor === 3;
  checks.push(check(
    "productVersion:supportedMajor",
    supportedProductMajor,
    expectedProductMajor === null
      ? `invalid version=${expectedProductVersion || "missing"}`
      : `major=${expectedProductMajor}`
  ));
  checks.push(check(
    "package:productVersion",
    packageVerify?.metadata?.productVersion === expectedProductVersion,
    `workspace=${expectedProductVersion || "missing"}, package=${String(packageVerify?.metadata?.productVersion ?? "missing")}`
  ));
  checks.push(...packageChecks(packageVerify, expectedV3));

  const target = `${targetPlatform}-${targetArch}`;
  const v3IntegrityReady = !expectedV3 || packageVerify?.checks?.integrity === true;
  const provenanceTrusted = !expectedV3 || packageVerify?.checks?.provenanceSignature === true;
  const windowsSigned = targetPlatform !== "win32"
    || (expectedV3
      ? packageVerify?.signing?.policyVerified === true
      : packageVerify?.metadata?.signing?.authenticodeVerified === true);
  const releaseChecks = [
    check("package:tier1Target", supportedReleaseTargets.has(target), target),
    check("package:targetWrapper", packageVerify?.targetWrapper?.ok === true, packageVerify?.targetWrapper?.status ?? "missing"),
    check("package:integrity", v3IntegrityReady, v3IntegrityReady ? "verified" : "missing"),
    check(
      "package:provenanceSignature",
      provenanceTrusted,
      expectedV3 ? (provenanceTrusted ? "verified by an externally trusted key" : "unsigned or untrusted preview only") : "not applicable"
    ),
    check(
      "package:windowsSignerPolicy",
      windowsSigned,
      targetPlatform === "win32" ? (windowsSigned ? "approved signer verified" : "unsigned or unapproved preview only") : "not applicable"
    ),
    ...sandboxSmokeReleaseChecks(sandboxSmoke, sandboxSmokePath, targetPlatform, targetArch, packageVerify, expectedV3),
    ...lspSandboxSmokeReleaseChecks(lspSandboxSmoke, lspSandboxSmokePath, targetPlatform, targetArch, packageVerify, expectedV3),
    ...migrationPerformanceReleaseChecks(migrationPerformance, migrationPerformancePath),
    ...nativeProtocolCoverageReleaseChecks(nativeProtocolCoverage, nativeProtocolCoveragePath),
    ...providerSmokeReleaseChecks(providerSmoke, providerSmokePath)
  ];
  const internalReady = checks.every((item) => item.ok);
  const releaseReady = internalReady && releaseChecks.every((item) => item.ok);
  const status = releaseReady ? "release-ready" : internalReady ? "internal-ready" : "not-ready";
  const packageLabel = `${target} CLI wrapper`;
  const packageReleaseNote = packageVerify?.targetWrapper?.ok !== true
    ? `${packageLabel} is not proven in this environment: ${packageVerify?.targetWrapper?.status ?? "missing"}${packageVerify?.targetWrapper?.reason ? ` (${packageVerify.targetWrapper.reason})` : ""}`
    : !v3IntegrityReady
      ? `${packageLabel} ran successfully, but portable integrity evidence is missing.`
      : !provenanceTrusted
        ? `${packageLabel} and integrity evidence passed; external provenance trust is missing, so the build remains preview-only.`
        : !windowsSigned
          ? `${packageLabel}, integrity, and provenance passed; Windows signer policy is not satisfied, so the build remains preview-only.`
          : `${packageLabel} has been executed successfully with release integrity and trust gates.`;
  const releaseNotes = [
    packageReleaseNote,
    sandboxSmoke?.ready === true
      ? `Real ${target} sandbox smoke passed against the packaged broker.`
      : `Real ${target} sandbox smoke is not proven: ${sandboxSmokePath} is missing or invalid.`,
    lspSandboxSmoke?.ready === true
      ? `Bundled TypeScript, Pyright, and read-only MCP smokes passed through the packaged sandbox broker for ${target}.`
      : `Bundled LSP sandbox smoke is not proven: ${lspSandboxSmokePath} is missing or invalid.`,
    providerSmoke?.ok === true
      ? `Live provider smoke passed for ${providerSmoke.provider}${providerSmoke.model ? `/${providerSmoke.model}` : ""}.`
      : `Live provider smoke is not proven: ${providerSmoke?.status ?? "missing"}${providerSmoke?.reason ? ` (${providerSmoke.reason})` : ""}`,
    "Default product readiness remains benchmark-neutral; benchmark adapters stay outside the product gate.",
    "CI covers packaged Linux PTY and Windows ConPTY startup/cleanup; IME, rapid resize, fonts, and terminal-emulator matrix signoff remain release-hardening items."
  ];

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    status,
    internalReady,
    releaseReady,
    evidence: {
      productSmoke: { path: productSmokePath, sessionId: productSmoke?.sessionId ?? null },
      tuiSmoke: { path: tuiSmokePath, sessionId: tuiSmoke?.sessionId ?? null },
      packageVerify: {
        path: packageVerifyPath,
        archive: packageVerify?.archive ?? packageVerify?.tarball ?? null,
        tarball: packageVerify?.tarball ?? null,
        zip: packageVerify?.zip ?? null,
        targetPlatform,
        targetArch,
        targetWrapper: packageVerify?.targetWrapper ?? null
      },
      sandboxSmoke: {
        path: sandboxSmokePath,
        ready: sandboxSmoke?.ready ?? false,
        backend: sandboxSmoke?.backend ?? null,
        brokerSha256: sandboxSmoke?.brokerSha256 ?? null
      },
      lspSandboxSmoke: {
        path: lspSandboxSmokePath,
        ready: lspSandboxSmoke?.ready ?? false,
        brokerSha256: lspSandboxSmoke?.brokerSha256 ?? null,
        bundledNodeSha256: lspSandboxSmoke?.bundledNodeSha256 ?? null
      },
      migrationPerformance: {
        path: migrationPerformancePath,
        ok: migrationPerformance?.ok ?? false,
        events: migrationPerformance?.events ?? null,
        peakRssMiB: migrationPerformance?.peakRssMiB ?? null,
        sourceUnchanged: migrationPerformance?.sourceUnchanged ?? false
      },
      nativeProtocolCoverage: {
        path: nativeProtocolCoveragePath,
        branches: nativeProtocolCoverageSummary(nativeProtocolCoverage)?.branches?.percent ?? null,
        lines: nativeProtocolCoverageSummary(nativeProtocolCoverage)?.lines?.percent ?? null
      },
      providerSmoke: {
        path: providerSmokePath,
        status: providerSmoke?.status ?? (existsSync(providerSmokePath) ? "unknown" : "missing"),
        provider: providerSmoke?.provider ?? null,
        model: providerSmoke?.model ?? null,
        sessionId: providerSmoke?.sessionId ?? null
      }
    },
    checks,
    releaseChecks,
    releaseNotes
  };
}

export async function writeProductReadinessReport(options = {}) {
  const rootDir = options.rootDir ? path.resolve(options.rootDir) : defaultRootDir;
  const artifactsDir = options.artifactsDir ? path.resolve(options.artifactsDir) : path.join(rootDir, ".artifacts");
  await mkdir(artifactsDir, { recursive: true });
  const report = await buildProductReadinessReport({ ...options, rootDir, artifactsDir });
  const targetPlatform = report.evidence.packageVerify.targetPlatform ?? options.targetPlatform ?? "unknown";
  const targetArch = report.evidence.packageVerify.targetArch ?? options.targetArch ?? "unknown";
  const jsonPath = path.join(artifactsDir, `product-readiness-${targetPlatform}-${targetArch}.json`);
  const markdownPath = path.join(artifactsDir, `product-readiness-${targetPlatform}-${targetArch}.md`);
  const json = `${JSON.stringify(report, null, 2)}\n`;
  const markdown = markdownReport(report);
  await writeFile(jsonPath, json, "utf8");
  await writeFile(markdownPath, markdown, "utf8");
  await writeFile(path.join(artifactsDir, "product-readiness.json"), json, "utf8");
  await writeFile(path.join(artifactsDir, "product-readiness.md"), markdown, "utf8");

  if (bool(options.requireReleaseReady ?? process.env.AGENT_REQUIRE_RELEASE_READY) && !report.releaseReady) {
    throw new Error(`Product readiness report is not release-ready: ${report.releaseNotes[0]}`);
  }
  if (bool(options.requireProviderSmoke ?? process.env.AGENT_REQUIRE_PROVIDER_SMOKE) && !report.releaseChecks.some((item) => item.name === "providerSmoke:ok" && item.ok)) {
    throw new Error("Product readiness report is missing a passing live provider smoke.");
  }
  if (!report.internalReady) {
    throw new Error(`Product readiness report is not internally ready. Failed checks: ${report.checks.filter((item) => !item.ok).map((item) => item.name).join(", ")}`);
  }

  return { report, jsonPath, markdownPath };
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--require-release-ready") options.requireReleaseReady = true;
    if (arg === "--require-provider-smoke") options.requireProviderSmoke = true;
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { report, jsonPath, markdownPath } = await writeProductReadinessReport(parseArgs(process.argv.slice(2)));
    console.log(`PASS product readiness ${report.status}`);
    console.log(`Wrote ${path.relative(defaultRootDir, jsonPath)}`);
    console.log(`Wrote ${path.relative(defaultRootDir, markdownPath)}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
