import {
  BoundedJsonLineWriter,
  MANIFEST_CHUNK_MAX_BYTES,
  readJsonLineChunks,
  type CheckpointMerkleCas,
  type CheckpointManifestStreamObserver,
  type MerkleChunkRef
} from "./manifest-merkle-io.js";
import {
  OrderedCheckpointManifestValidator,
  type CheckpointManifestTotals
} from "./manifest-stream-validation.js";
import { validateCheckpointEntry } from "./restore-manifest-validation.js";
import { CheckpointConflictError, type CheckpointEntry } from "./types.js";

const SORT_RUN_MAX_ITEMS = 2_048;
const SORT_RUN_MAX_BYTES = 4 * 1024 * 1024;
const MERGE_MAX_RUNS = 32;

interface MergeHead {
  entry: CheckpointEntry;
  iterator: AsyncIterator<CheckpointEntry>;
  runIndex: number;
}

function compareEntries(left: CheckpointEntry, right: CheckpointEntry): number {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

function lessHead(left: MergeHead, right: MergeHead): boolean {
  const order = compareEntries(left.entry, right.entry);
  return order < 0 || (order === 0 && left.runIndex < right.runIndex);
}

function pushHeap(heap: MergeHead[], value: MergeHead): void {
  heap.push(value);
  let index = heap.length - 1;
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    if (!lessHead(heap[index]!, heap[parent]!)) return;
    [heap[index], heap[parent]] = [heap[parent]!, heap[index]!];
    index = parent;
  }
}

function popHeap(heap: MergeHead[]): MergeHead | undefined {
  const first = heap[0];
  const last = heap.pop();
  if (!first || !last || heap.length === 0) return first;
  heap[0] = last;
  let index = 0;
  while (true) {
    const left = index * 2 + 1;
    const right = left + 1;
    let smallest = index;
    if (left < heap.length && lessHead(heap[left]!, heap[smallest]!)) smallest = left;
    if (right < heap.length && lessHead(heap[right]!, heap[smallest]!)) smallest = right;
    if (smallest === index) return first;
    [heap[index], heap[smallest]] = [heap[smallest]!, heap[index]!];
    index = smallest;
  }
}

async function* mergedRuns(
  cas: CheckpointMerkleCas,
  runs: readonly (readonly MerkleChunkRef[])[],
  observer?: CheckpointManifestStreamObserver
): AsyncGenerator<CheckpointEntry> {
  const heap: MergeHead[] = [];
  for (const [runIndex, chunks] of runs.entries()) {
    const iterator = readJsonLineChunks(
      cas,
      chunks,
      checkpointEntry,
      (entry) => entry.path,
      observer
    )[Symbol.asyncIterator]();
    const next = await iterator.next();
    if (!next.done) pushHeap(heap, { entry: next.value, iterator, runIndex });
  }
  observer?.mergeHeads?.(heap.length);
  while (heap.length > 0) {
    const head = popHeap(heap)!;
    yield head.entry;
    const next = await head.iterator.next();
    if (!next.done) pushHeap(heap, { ...head, entry: next.value });
  }
}

function checkpointEntry(value: unknown): CheckpointEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CheckpointConflictError("Checkpoint manifest Merkle leaf contains an invalid item.");
  }
  const entry = value as CheckpointEntry;
  validateCheckpointEntry(entry);
  return entry;
}

async function writeCanonical(
  cas: CheckpointMerkleCas,
  entries: AsyncIterable<CheckpointEntry> | Iterable<CheckpointEntry>,
  expected: CheckpointManifestTotals,
  observer?: CheckpointManifestStreamObserver
): Promise<MerkleChunkRef[]> {
  const validator = new OrderedCheckpointManifestValidator();
  const writer = new BoundedJsonLineWriter(cas, (entry: CheckpointEntry) => entry.path, observer);
  for await (const entry of entries) {
    validator.add(entry);
    await writer.add(entry);
  }
  validator.finish(expected);
  return await writer.finish();
}

/** Fast path for a caller that already provides canonical path order. */
export async function writeCanonicalCheckpointManifest(
  cas: CheckpointMerkleCas,
  entries: AsyncIterable<CheckpointEntry> | Iterable<CheckpointEntry>,
  expected: CheckpointManifestTotals,
  observer?: CheckpointManifestStreamObserver
): Promise<MerkleChunkRef[]> {
  return await writeCanonical(cas, entries, expected, observer);
}

/**
 * External bounded-run sorter used by filesystem capture. Entry objects are
 * released after each run is persisted; final canonicalization retains only
 * run metadata and one decoded head per run.
 */
export class ExternalCheckpointManifestWriter {
  private readonly runLevels: MerkleChunkRef[][][] = [];
  private batch: CheckpointEntry[] = [];
  private batchBytes = 0;
  private firstRunTotals: CheckpointManifestTotals | undefined;
  private inputRunCount = 0;

  constructor(
    private readonly cas: CheckpointMerkleCas,
    private readonly observer?: CheckpointManifestStreamObserver
  ) {}

  async add(entry: CheckpointEntry): Promise<void> {
    validateCheckpointEntry(entry);
    const itemBytes = Buffer.byteLength(`${JSON.stringify(entry)}\n`, "utf8");
    if (itemBytes > MANIFEST_CHUNK_MAX_BYTES) {
      throw new CheckpointConflictError(`Checkpoint manifest item is too large to store safely: ${entry.path}`);
    }
    if (this.batch.length > 0 && (this.batch.length >= SORT_RUN_MAX_ITEMS
      || this.batchBytes + itemBytes > SORT_RUN_MAX_BYTES)) await this.flushRun();
    this.batch.push(entry);
    this.batchBytes += itemBytes;
    this.observer?.sortRun?.(this.batch.length, this.batchBytes);
  }

  async finish(expected: CheckpointManifestTotals): Promise<MerkleChunkRef[]> {
    await this.flushRun();
    let runs = this.runLevels.flat();
    if (this.inputRunCount === 1) {
      if (!this.firstRunTotals || this.firstRunTotals.fileCount !== expected.fileCount
        || this.firstRunTotals.totalBytes !== expected.totalBytes) {
        throw new CheckpointConflictError("Checkpoint manifest totals are inconsistent.");
      }
      return runs[0]!;
    }
    while (runs.length > MERGE_MAX_RUNS) {
      const compacted: MerkleChunkRef[][] = [];
      for (let index = 0; index < runs.length; index += MERGE_MAX_RUNS) {
        compacted.push(await this.mergeRunGroup(runs.slice(index, index + MERGE_MAX_RUNS)));
      }
      runs = compacted;
    }
    return await writeCanonical(this.cas, mergedRuns(this.cas, runs, this.observer), expected, this.observer);
  }

  private async flushRun(): Promise<void> {
    if (this.batch.length === 0) return;
    const entries = this.batch;
    this.batch = [];
    this.batchBytes = 0;
    entries.sort(compareEntries);
    const validator = new OrderedCheckpointManifestValidator();
    const writer = new BoundedJsonLineWriter(this.cas, (entry: CheckpointEntry) => entry.path, this.observer);
    for (const entry of entries) {
      validator.add(entry);
      await writer.add(entry);
    }
    if (this.inputRunCount === 0) this.firstRunTotals = validator.totals();
    this.inputRunCount += 1;
    await this.addRun(await writer.finish(), 0);
  }

  private async addRun(run: MerkleChunkRef[], level: number): Promise<void> {
    const bucket = this.runLevels[level] ?? [];
    this.runLevels[level] = bucket;
    bucket.push(run);
    if (bucket.length < MERGE_MAX_RUNS) return;
    this.runLevels[level] = [];
    await this.addRun(await this.mergeRunGroup(bucket), level + 1);
  }

  private async mergeRunGroup(runs: readonly (readonly MerkleChunkRef[])[]): Promise<MerkleChunkRef[]> {
    if (runs.length === 1) return [...runs[0]!];
    const writer = new BoundedJsonLineWriter(this.cas, (entry: CheckpointEntry) => entry.path, this.observer);
    for await (const entry of mergedRuns(this.cas, runs, this.observer)) await writer.add(entry);
    return await writer.finish();
  }
}

export const checkpointManifestSortLimits = Object.freeze({
  runMaxItems: SORT_RUN_MAX_ITEMS,
  runMaxBytes: SORT_RUN_MAX_BYTES,
  mergeMaxRuns: MERGE_MAX_RUNS
});
