import { createHash } from "node:crypto";
import { mkdir, open, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { CheckpointConflictError, type CheckpointEntry, type CheckpointManifest } from "./types.js";

export type RestoreCasReader = (digest: string) => AsyncIterable<Uint8Array>;

export async function validateRestoreCas(
  manifest: CheckpointManifest,
  readCas: RestoreCasReader
): Promise<void> {
  for (const entry of manifest.entries) {
    if (entry.kind !== "file") continue;
    const hash = createHash("sha256");
    let size = 0;
    for await (const chunk of readCas(entry.digest!)) {
      hash.update(chunk);
      size += chunk.byteLength;
    }
    if (hash.digest("hex") !== entry.digest || size !== entry.size) {
      throw new CheckpointConflictError(`Checkpoint CAS content is corrupt: ${entry.path}`);
    }
  }
}

async function stageCasFile(
  readCas: RestoreCasReader,
  target: string,
  entry: CheckpointEntry
): Promise<void> {
  const handle = await open(target, "wx", entry.mode);
  const hash = createHash("sha256");
  let size = 0;
  try {
    for await (const chunk of readCas(entry.digest!)) {
      hash.update(chunk);
      let offset = 0;
      while (offset < chunk.byteLength) {
        const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset, size + offset);
        if (bytesWritten <= 0) throw new Error("Checkpoint restore staging write made no progress.");
        offset += bytesWritten;
      }
      size += chunk.byteLength;
    }
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(target, { force: true }).catch(() => undefined);
    throw error;
  }
  await handle.close();
  if (hash.digest("hex") !== entry.digest || size !== entry.size) {
    await rm(target, { force: true });
    throw new CheckpointConflictError(`Checkpoint CAS changed while staging: ${entry.path}`);
  }
}

export async function stageRestoreEntry(
  readCas: RestoreCasReader,
  target: string,
  entry: CheckpointEntry,
  symlinkType?: "file" | "junction"
): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  if (entry.kind === "reproducible_root") {
    throw new CheckpointConflictError(
      `A reproducible-root marker cannot be installed as a checkpoint preimage: ${entry.path}`
    );
  }
  if (entry.kind === "directory") await mkdir(target, { recursive: true });
  else if (entry.kind === "symlink") await symlink(entry.linkTarget!, target, symlinkType);
  else await stageCasFile(readCas, target, entry);
}
