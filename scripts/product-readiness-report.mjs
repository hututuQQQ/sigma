#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

function packageChecks(packageVerify) {
  const checks = packageVerify?.checks ?? {};
  return [
    check("package:ok", packageVerify?.ok === true, "package verification completed"),
    check("package:readme", checks.readme === true, "bundle README verified"),
    check("package:wrapper", checks.wrapper === true, "package wrapper verified"),
    check("package:metadata", checks.metadata === true, "package metadata verified"),
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
  const packageVerifyPath = path.join(artifactsDir, "agent-cli-package-verify.json");
  const providerSmokePath = path.join(artifactsDir, "smoke-provider", "provider-smoke.json");
  const checks = [];

  assertEvidenceFile(productSmokePath, "productSmoke", checks);
  assertEvidenceFile(tuiSmokePath, "tuiSmoke", checks);
  assertEvidenceFile(packageVerifyPath, "packageVerify", checks);

  const [packageJson, productSmoke, tuiSmoke, packageVerify, providerSmoke] = await Promise.all([
    readJson(packageJsonPath),
    existsSync(productSmokePath) ? readJson(productSmokePath) : Promise.resolve(null),
    existsSync(tuiSmokePath) ? readJson(tuiSmokePath) : Promise.resolve(null),
    existsSync(packageVerifyPath) ? readJson(packageVerifyPath) : Promise.resolve(null),
    existsSync(providerSmokePath) ? readJson(providerSmokePath) : Promise.resolve(null)
  ]);

  const verifyProductScript = productGateScript(packageJson);
  checks.push(check("productGate:benchmarkNeutral", benchmarkNeutralScripts(packageJson), "verify:product excludes bench/Harbor adapters"));
  checks.push(check("productGate:noLiveProviderSmoke", !verifyProductScript.includes("smoke:provider"), "verify:product excludes live provider smoke"));
  checks.push(check("productGate:noRequiredTargetWrapper", !verifyProductScript.includes("--require-target-wrapper"), "verify:product does not require target wrapper smoke"));
  checks.push(...productSmokeChecks(productSmoke));
  checks.push(...tuiSmokeChecks(tuiSmoke));
  checks.push(...packageChecks(packageVerify));

  const targetPlatform = packageVerify?.targetPlatform ?? "linux";
  const releaseChecks = [
    check("package:targetPlatform", targetPlatform === "win32", targetPlatform),
    check("package:targetWrapper", packageVerify?.targetWrapper?.ok === true, packageVerify?.targetWrapper?.status ?? "missing"),
    ...providerSmokeReleaseChecks(providerSmoke, providerSmokePath)
  ];
  const internalReady = checks.every((item) => item.ok);
  const releaseReady = internalReady && releaseChecks.every((item) => item.ok);
  const status = releaseReady ? "release-ready" : internalReady ? "internal-ready" : "not-ready";
  const packageLabel = targetPlatform === "win32" ? "Windows CLI wrapper" : "Bundled Linux wrapper";
  const packageReleaseReady = targetPlatform === "win32" && packageVerify?.targetWrapper?.ok === true;
  const releaseNotes = [
    packageReleaseReady
      ? `${packageLabel} has been executed successfully.`
      : `${packageLabel} is not proven in this environment: ${packageVerify?.targetWrapper?.status ?? "missing"}${packageVerify?.targetWrapper?.reason ? ` (${packageVerify.targetWrapper.reason})` : ""}`,
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
        targetArch: packageVerify?.targetArch ?? null,
        targetWrapper: packageVerify?.targetWrapper ?? null
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
  const jsonPath = path.join(artifactsDir, "product-readiness.json");
  const markdownPath = path.join(artifactsDir, "product-readiness.md");
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, markdownReport(report), "utf8");

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
  for (const arg of argv) {
    if (arg === "--require-release-ready") options.requireReleaseReady = true;
    if (arg === "--require-provider-smoke") options.requireProviderSmoke = true;
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
