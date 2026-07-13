import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface SigmaManifest {
  readonly schemaVersion: 1;
  readonly productVersion: string;
  readonly toolchains: Readonly<Record<"node" | "pnpm" | "rust" | "rustCoverage", string>>;
  readonly release: {
    readonly targets: readonly string[];
    readonly windowsNodePatch: Readonly<Record<string, string>>;
  };
  readonly evaluation: { readonly provider: string; readonly model: string };
}

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const sigmaManifestPath = path.join(rootDir, "sigma-manifest.json");
export const sigmaManifest = Object.freeze(
  JSON.parse(readFileSync(sigmaManifestPath, "utf8")) as SigmaManifest,
);
