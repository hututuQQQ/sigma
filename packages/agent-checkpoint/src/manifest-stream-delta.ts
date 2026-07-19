import {
  readCheckpointManifestMerkleStream,
  type CheckpointManifestCas
} from "./manifest-store.js";
import { entryEqual } from "./restore-manifest-validation.js";
import type { CheckpointDelta, CheckpointEntry } from "./types.js";

interface EntryCursor {
  iterator: AsyncIterator<CheckpointEntry>;
  value: CheckpointEntry | undefined;
}

async function cursor(entries: AsyncIterable<CheckpointEntry>): Promise<EntryCursor> {
  const iterator = entries[Symbol.asyncIterator]();
  const next = await iterator.next();
  return { iterator, value: next.done ? undefined : next.value };
}

async function advance(current: EntryCursor): Promise<void> {
  const next = await current.iterator.next();
  current.value = next.done ? undefined : next.value;
}

/** Exact O(n) merge over two verified canonical manifest streams. */
export async function checkpointDeltaFromMerkle(
  cas: CheckpointManifestCas,
  beforeDigest: string,
  afterDigest: string
): Promise<CheckpointDelta> {
  const before = await readCheckpointManifestMerkleStream(cas, beforeDigest);
  const after = await readCheckpointManifestMerkleStream(cas, afterDigest);
  const left = await cursor(before.entries);
  const right = await cursor(after.entries);
  const delta: CheckpointDelta = { added: [], modified: [], deleted: [] };
  while (left.value || right.value) {
    if (!left.value || (right.value && right.value.path < left.value.path)) {
      delta.added.push(right.value!.path);
      await advance(right);
    } else if (!right.value || left.value.path < right.value.path) {
      delta.deleted.push(left.value.path);
      await advance(left);
    } else {
      if (!entryEqual(left.value, right.value)) delta.modified.push(left.value.path);
      await advance(left);
      await advance(right);
    }
  }
  return delta;
}
