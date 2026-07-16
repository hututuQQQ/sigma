import type { CheckpointCasStore } from "./cas-store.js";
import {
  CheckpointConflictError,
  type CheckpointEntry,
  type CheckpointManifest,
  type CheckpointOpaqueArtifact,
  type CheckpointRecord
} from "./types.js";

async function isOpaque(entry: CheckpointEntry, cas: CheckpointCasStore): Promise<boolean> {
  if (!entry.digest) return false;
  if (!entry.casIdentity) {
    throw new CheckpointConflictError(`Checkpoint manifest lacks a trusted CAS identity: ${entry.path}`);
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let opaque = false;
  for await (const chunk of cas.stream(entry.digest, Number.POSITIVE_INFINITY, entry.casIdentity)) {
    if (chunk.some((byte) => byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d)
      || chunk.includes(0x7f)) {
      opaque = true;
      continue;
    }
    if (opaque) continue;
    try {
      decoder.decode(chunk, { stream: true });
    } catch {
      opaque = true;
    }
  }
  if (opaque) return true;
  try {
    decoder.decode();
    return false;
  } catch {
    return true;
  }
}

export async function checkpointOpaqueArtifacts(
  checkpoint: CheckpointRecord,
  before: CheckpointManifest,
  after: CheckpointManifest,
  cas: CheckpointCasStore
): Promise<CheckpointOpaqueArtifact[]> {
  const beforeByPath = new Map(before.entries.map((entry) => [entry.path, entry]));
  const afterByPath = new Map(after.entries.map((entry) => [entry.path, entry]));
  const result: CheckpointOpaqueArtifact[] = [];
  for (const file of [...new Set([
    ...checkpoint.delta!.added, ...checkpoint.delta!.modified, ...checkpoint.delta!.deleted
  ])].sort()) {
    const left = beforeByPath.get(file);
    const right = afterByPath.get(file);
    const beforeOpaque = left?.kind === "file" && await isOpaque(left, cas);
    const afterOpaque = right?.kind === "file" && await isOpaque(right, cas);
    if (!beforeOpaque && !afterOpaque) continue;
    result.push({
      path: file,
      ...(beforeOpaque && left.digest ? { before: { digest: left.digest, sizeBytes: left.size } } : {}),
      ...(afterOpaque && right.digest ? { after: { digest: right.digest, sizeBytes: right.size } } : {})
    });
  }
  return result;
}
