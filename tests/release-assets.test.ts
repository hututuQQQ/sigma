import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assembleReleaseAssets,
  assertReleaseAssetWhitelist,
  expectedPublicReleaseAssets
} from "../scripts/release/assemble-release-assets.mjs";

const version = "0.1.8";

function evidenceInputs(includeLiveEval = true): string[] {
  const runtime = [
    ["linux-x64", "tgz"], ["win32-x64", "zip"], ["darwin-arm64", "tgz"]
  ].flatMap(([target, extension]) => [
    `agent-cli-${target}.${extension}.sha256`, `agent-cli-${target}.sbom.cdx.json`,
    `agent-cli-${target}.provenance.json`, `agent-cli-package-verify-${target}.json`,
    `sandbox-smoke-${target}.json`, `lsp-sandbox-smoke-${target}.json`,
    `product-readiness-${target}.json`, `product-readiness-${target}.md`,
    ...(includeLiveEval ? [`live-eval-quick-${target}.json`] : [])
  ]);
  return [
    ...runtime,
    ...["x64.exe", "arm64.dmg"].flatMap((suffix) => [
      `Sigma-Code-${version}-${suffix}.sha256`,
      `Sigma-Code-${version}-${suffix}.desktop-provenance.json`,
      `Sigma-Code-${version}-${suffix}.signing.json`
    ]),
    "release-provenance-public.pem"
  ];
}

describe("release asset assembly", () => {
  it("rejects missing and extra public attachments", () => {
    expect(() => assertReleaseAssetWhitelist([], version)).toThrow("missing=");
    expect(() => assertReleaseAssetWhitelist([
      ...expectedPublicReleaseAssets(version), "latest.yml"
    ], version)).toThrow("extra=latest.yml");
  });

  it("produces exactly six attachments with unified checksums and evidence", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-release-assets-test-"));
    const inputDir = path.join(root, "inputs");
    const outputDir = path.join(root, "release-assets");
    await mkdir(inputDir);
    for (const name of [
      `Sigma-Code-${version}-arm64.dmg`, `Sigma-Code-${version}-x64.exe`,
      "agent-cli-linux-x64.tgz", "agent-cli-win32-x64.zip",
      ...evidenceInputs()
    ]) {
      await writeFile(path.join(inputDir, name), `fixture:${name}\n`, "utf8");
    }
    const result = await assembleReleaseAssets({ inputDir, outputDir, version });
    expect(result.assets).toEqual(expectedPublicReleaseAssets(version));
    expect(await readdir(outputDir)).toHaveLength(6);
    const checksums = await readFile(path.join(outputDir, "SHA256SUMS.txt"), "utf8");
    expect(checksums).toContain(`Sigma-Code-${version}-arm64.dmg`);
    expect(checksums).toContain(`sigma-release-evidence-${version}.zip`);
    expect(checksums).not.toContain("SHA256SUMS.txt");
  });

  it("substitutes one authorized override record for platform live-evaluation reports", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-release-override-test-"));
    const inputDir = path.join(root, "inputs");
    const outputDir = path.join(root, "release-assets");
    await mkdir(inputDir);
    for (const name of [
      `Sigma-Code-${version}-arm64.dmg`, `Sigma-Code-${version}-x64.exe`,
      "agent-cli-linux-x64.tgz", "agent-cli-win32-x64.zip",
      ...evidenceInputs(false), "release-live-evaluation-override.json"
    ]) {
      await writeFile(path.join(inputDir, name), `fixture:${name}\n`, "utf8");
    }
    const result = await assembleReleaseAssets({
      inputDir,
      outputDir,
      version,
      includeLiveEvalOverride: true
    });
    expect(result.assets).toEqual(expectedPublicReleaseAssets(version));
  });
});
