import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const sigmaManifestPath = path.join(rootDir, "sigma-manifest.json");
export const sigmaManifest = Object.freeze(JSON.parse(readFileSync(sigmaManifestPath, "utf8")));

export function assertSigmaManifest(value = sigmaManifest) {
  const digest = /^[a-f0-9]{64}$/u;
  if (value?.schemaVersion !== 1 || typeof value?.productVersion !== "string") {
    throw new Error("sigma-manifest.json has an unsupported schema.");
  }
  for (const key of ["node", "pnpm", "rust", "rustCoverage"]) {
    if (typeof value.toolchains?.[key] !== "string" || !value.toolchains[key]) {
      throw new Error(`sigma-manifest.json is missing toolchains.${key}.`);
    }
  }
  if (!Array.isArray(value.release?.targets) || value.release.targets.length === 0) {
    throw new Error("sigma-manifest.json requires release targets.");
  }
  const patch = value.release.windowsNodePatch;
  for (const key of ["sourceSha256", "unsignedPatchedSha256", "normalizedContentSha256"]) {
    if (!digest.test(String(patch?.[key] ?? ""))) throw new Error(`Invalid Windows Node patch ${key}.`);
  }
  if (!value.evaluation?.provider || !value.evaluation?.model) {
    throw new Error("sigma-manifest.json requires an evaluation provider and model.");
  }
  return value;
}

assertSigmaManifest();
