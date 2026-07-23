import { createHash } from "node:crypto";
import { manifestEqual } from "./restore-manifest-validation.js";
import type { CheckpointManifest, CheckpointRecord } from "./types.js";

export interface RunCheckpointImage {
  record: CheckpointRecord;
  before: CheckpointManifest;
  after: CheckpointManifest;
}

function inScopes(entryPath: string, scopes: readonly string[]): boolean {
  return scopes.some((scope) => scope === "." || entryPath === scope || entryPath.startsWith(`${scope}/`));
}

function manifest(entries: CheckpointManifest["entries"]): CheckpointManifest {
  const ordered = [...entries].sort((left, right) => left.path.localeCompare(right.path));
  return {
    entries: ordered,
    fileCount: ordered.length,
    totalBytes: ordered.reduce((total, entry) => total + (entry.kind === "file" ? entry.size : 0), 0)
  };
}

function scoped(source: CheckpointManifest, scopes: readonly string[]): CheckpointManifest {
  return manifest(source.entries.filter((entry) => inScopes(entry.path, scopes)));
}

function replaceScopes(
  source: CheckpointManifest,
  scopes: readonly string[],
  replacement: CheckpointManifest
): CheckpointManifest {
  return manifest([
    ...source.entries.filter((entry) => !inScopes(entry.path, scopes)),
    ...replacement.entries
  ]);
}

/** Reconstruct the state before the first checkpoint without touching the
 * workspace. Reverse postimage checks establish that a destructive restore
 * still starts from the exact recorded checkpoint chain. */
export function reconstructRunBaseline(
  current: CheckpointManifest,
  images: readonly RunCheckpointImage[]
): { desired: CheckpointManifest; chainMatches: boolean } {
  let image = current;
  let chainMatches = true;
  for (const checkpoint of [...images].reverse()) {
    if (!manifestEqual(scoped(image, checkpoint.record.scopePaths), checkpoint.after)) {
      chainMatches = false;
    }
    image = replaceScopes(image, checkpoint.record.scopePaths, checkpoint.before);
  }
  return { desired: image, chainMatches };
}

export function runScopePaths(records: readonly CheckpointRecord[]): string[] {
  const candidates = [...new Set(records.flatMap((record) => record.scopePaths))]
    .sort((left, right) => left.length - right.length || left.localeCompare(right));
  return candidates.filter((value, index) => !candidates.slice(0, index).some((parent) =>
    parent === "." || value === parent || value.startsWith(`${parent}/`)));
}

export function semanticManifestDigest(value: CheckpointManifest): string {
  return createHash("sha256").update(JSON.stringify(value.entries.map((entry) => ({
    path: entry.path,
    kind: entry.kind,
    mode: entry.mode,
    size: entry.size,
    digest: entry.digest ?? null,
    linkTarget: entry.linkTarget ?? null,
    linkType: entry.linkType ?? null
  })))).digest("hex");
}
