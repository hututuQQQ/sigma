#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function expectedPublicReleaseAssets(version) {
  return [
    `Sigma-Code-${version}-arm64.dmg`,
    `Sigma-Code-${version}-x64.exe`,
    "agent-cli-linux-x64.tgz",
    "agent-cli-win32-x64.zip",
    "SHA256SUMS.txt",
    `sigma-release-evidence-${version}.zip`
  ].sort((left, right) => left.localeCompare(right, "en"));
}

export function assertReleaseAssetWhitelist(names, version) {
  const actual = [...names].sort((left, right) => left.localeCompare(right, "en"));
  const expected = expectedPublicReleaseAssets(version);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    const actualSet = new Set(actual);
    const expectedSet = new Set(expected);
    const missing = expected.filter((name) => !actualSet.has(name));
    const extra = actual.filter((name) => !expectedSet.has(name));
    throw new Error([
      "Release attachment whitelist mismatch.",
      `missing=${missing.join(",") || "none"}`,
      `extra=${extra.join(",") || "none"}`
    ].join(" "));
  }
  return actual;
}

async function sha256(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

async function requireFile(root, name) {
  const filePath = path.join(root, name);
  if (!existsSync(filePath)) throw new Error(`Required release input is missing: ${name}`);
  return filePath;
}

function evidenceInputNames(version, includeLiveEvalOverride) {
  const runtime = [
    ["linux-x64", "tgz"],
    ["win32-x64", "zip"],
    ["darwin-arm64", "tgz"]
  ].flatMap(([target, extension]) => [
    `agent-cli-${target}.${extension}.sha256`,
    `agent-cli-${target}.sbom.cdx.json`,
    `agent-cli-${target}.provenance.json`,
    `agent-cli-package-verify-${target}.json`,
    `sandbox-smoke-${target}.json`,
    `lsp-sandbox-smoke-${target}.json`,
    `product-readiness-${target}.json`,
    `product-readiness-${target}.md`,
    ...(!includeLiveEvalOverride ? [`live-eval-quick-${target}.json`] : [])
  ]);
  const desktop = ["x64.exe", "arm64.dmg"].flatMap((suffix) => [
    `Sigma-Code-${version}-${suffix}.sha256`,
    `Sigma-Code-${version}-${suffix}.desktop-provenance.json`,
    `Sigma-Code-${version}-${suffix}.signing.json`
  ]);
  return [
    ...runtime,
    ...desktop,
    "release-provenance-public.pem",
    ...(includeLiveEvalOverride ? ["release-live-evaluation-override.json"] : [])
  ];
}

function runDeterministicZip(sourceDir, destination) {
  const script = [
    "import pathlib, sys, zipfile",
    "root = pathlib.Path(sys.argv[1])",
    "dest = pathlib.Path(sys.argv[2])",
    "with zipfile.ZipFile(dest, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:",
    "    for item in sorted(p for p in root.rglob('*') if p.is_file()):",
    "        relative = item.relative_to(root).as_posix()",
    "        info = zipfile.ZipInfo(relative, (1980, 1, 1, 0, 0, 0))",
    "        info.compress_type = zipfile.ZIP_DEFLATED",
    "        info.external_attr = 0o100644 << 16",
    "        archive.writestr(info, item.read_bytes(), compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)"
  ].join("\n");
  let last;
  for (const command of process.platform === "win32" ? ["python", "python3"] : ["python3", "python"]) {
    last = spawnSync(command, ["-c", script, sourceDir, destination], { encoding: "utf8" });
    if (!last.error && last.status === 0) return;
  }
  throw new Error(`Could not create deterministic evidence ZIP: ${last?.stderr || last?.error?.message}`);
}

async function writeChecksums(filePaths, destination) {
  const records = [];
  for (const filePath of filePaths.sort((left, right) => path.basename(left).localeCompare(path.basename(right), "en"))) {
    records.push(`${await sha256(filePath)}  ${path.basename(filePath)}`);
  }
  await writeFile(destination, `${records.join("\n")}\n`, "utf8");
}

export async function assembleReleaseAssets(options) {
  const inputDir = path.resolve(options.inputDir);
  const outputDir = path.resolve(options.outputDir);
  const version = String(options.version ?? "");
  if (!/^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){2}(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
    throw new Error(`Invalid release version: ${version}`);
  }
  if (inputDir === outputDir || path.dirname(outputDir) === outputDir) {
    throw new Error("Release input and output directories must be distinct scoped paths.");
  }
  const includeLiveEvalOverride = options.includeLiveEvalOverride === true;
  const primaryNames = [
    `Sigma-Code-${version}-arm64.dmg`,
    `Sigma-Code-${version}-x64.exe`,
    "agent-cli-linux-x64.tgz",
    "agent-cli-win32-x64.zip"
  ];
  const primarySources = await Promise.all(primaryNames.map((name) => requireFile(inputDir, name)));
  const evidenceNames = evidenceInputNames(version, includeLiveEvalOverride);
  const evidenceSources = await Promise.all(evidenceNames.map((name) => requireFile(inputDir, name)));

  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  for (let index = 0; index < primaryNames.length; index += 1) {
    await cp(primarySources[index], path.join(outputDir, primaryNames[index]));
  }

  const temporary = await mkdtemp(path.join(os.tmpdir(), "sigma-release-evidence-"));
  try {
    const evidenceRoot = path.join(temporary, `sigma-release-evidence-${version}`);
    await mkdir(evidenceRoot, { recursive: true });
    for (let index = 0; index < evidenceNames.length; index += 1) {
      await cp(evidenceSources[index], path.join(evidenceRoot, evidenceNames[index]));
    }
    const buildSource = {
      schemaVersion: 1,
      kind: "sigma.release-evidence",
      version,
      repository: process.env.GITHUB_REPOSITORY ?? null,
      commit: process.env.GITHUB_SHA ?? null,
      workflowRunId: process.env.GITHUB_RUN_ID ?? null,
      workflowRunAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
      ref: process.env.GITHUB_REF ?? null
    };
    await writeFile(
      path.join(evidenceRoot, "build-source.json"),
      `${JSON.stringify(buildSource, null, 2)}\n`,
      "utf8"
    );
    await writeChecksums(
      [...primarySources, ...evidenceSources],
      path.join(evidenceRoot, "ARTIFACT-SHA256SUMS.txt")
    );
    const evidenceFiles = (await readdir(evidenceRoot)).sort((left, right) => left.localeCompare(right, "en"));
    const manifestEntries = [];
    for (const name of evidenceFiles) {
      const filePath = path.join(evidenceRoot, name);
      manifestEntries.push({ name, sha256: await sha256(filePath) });
    }
    await writeFile(
      path.join(evidenceRoot, "evidence-manifest.json"),
      `${JSON.stringify({ schemaVersion: 1, version, files: manifestEntries }, null, 2)}\n`,
      "utf8"
    );
    const evidencePath = path.join(outputDir, `sigma-release-evidence-${version}.zip`);
    runDeterministicZip(evidenceRoot, evidencePath);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }

  const publicChecksumInputs = (await readdir(outputDir))
    .filter((name) => name !== "SHA256SUMS.txt")
    .map((name) => path.join(outputDir, name));
  await writeChecksums(publicChecksumInputs, path.join(outputDir, "SHA256SUMS.txt"));
  const names = await readdir(outputDir);
  assertReleaseAssetWhitelist(names, version);
  return { outputDir, assets: names.sort((left, right) => left.localeCompare(right, "en")) };
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--include-live-eval-override") {
      options.includeLiveEvalOverride = true;
      continue;
    }
    const value = argv[index + 1];
    if (!["--input", "--output", "--version"].includes(argument) || !value) {
      throw new Error(`Unknown or incomplete argument '${argument}'.`);
    }
    options[argument === "--input" ? "inputDir" : argument === "--output" ? "outputDir" : "version"] = value;
    index += 1;
  }
  if (!options.inputDir || !options.outputDir || !options.version) {
    throw new Error("--input, --output, and --version are required.");
  }
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await assembleReleaseAssets(parseArgs(process.argv.slice(2)));
    console.log(`PASS release asset whitelist (${result.assets.length} attachments)`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
