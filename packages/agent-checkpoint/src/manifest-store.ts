import { createHash } from "node:crypto";
import {
  ExternalCheckpointManifestWriter,
  writeCanonicalCheckpointManifest
} from "./manifest-canonical-stream.js";
import {
  BoundedJsonLineWriter,
  MANIFEST_CHUNK_MAX_BYTES,
  MANIFEST_CHUNK_TARGET_BYTES,
  readJsonLineChunks,
  type CheckpointMerkleCas,
  type CheckpointManifestStreamObserver,
  type MerkleChunkRef
} from "./manifest-merkle-io.js";
import { OrderedCheckpointManifestValidator } from "./manifest-stream-validation.js";
import { validateCheckpointEntry, validateManifest } from "./restore-manifest-validation.js";
import {
  CheckpointConflictError,
  type CheckpointDelta,
  type CheckpointEntry,
  type CheckpointManifest
} from "./types.js";

const MANIFEST_DESCRIPTOR_MAX_BYTES = 8 * 1024 * 1024;
const LEGACY_MANIFEST_MAX_BYTES = 256 * 1024 * 1024;

interface ManifestMerkleDescriptorV1 {
  schemaVersion: 1;
  kind: "checkpoint_manifest_merkle_v1";
  algorithm: "sha256";
  encoding: "jsonl";
  fileCount: number;
  totalBytes: number;
  itemCount: number;
  merkleRoot: string;
  chunks: MerkleChunkRef[];
}

interface DeltaMerkleDescriptorV1 {
  schemaVersion: 1;
  kind: "checkpoint_delta_merkle_v1";
  algorithm: "sha256";
  encoding: "jsonl";
  itemCount: number;
  merkleRoot: string;
  counts: { added: number; modified: number; deleted: number };
  chunks: MerkleChunkRef[];
}

type MerkleDescriptor = ManifestMerkleDescriptorV1 | DeltaMerkleDescriptorV1;
type DeltaItem = { kind: keyof CheckpointDelta; path: string };

export interface CheckpointManifestCas extends CheckpointMerkleCas {
  putBytes(content: Uint8Array): Promise<string>;
}

function digest(value: string): boolean {
  return /^[a-f0-9]{64}$/u.test(value);
}

function safeCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function hashNode(prefix: string, ...values: readonly string[]): string {
  const hash = createHash("sha256");
  hash.update(prefix, "utf8");
  for (const value of values) {
    hash.update("\0", "utf8");
    hash.update(value, "utf8");
  }
  return hash.digest("hex");
}

/** A deterministic binary Merkle root over content-addressed JSONL leaves. */
export function checkpointChunkMerkleRoot(chunks: readonly Pick<MerkleChunkRef, "digest">[]): string {
  if (chunks.length === 0) return hashNode("checkpoint-merkle-empty-v1");
  let level = chunks.map((chunk) => hashNode("checkpoint-merkle-leaf-v1", chunk.digest));
  while (level.length > 1) {
    const next: string[] = [];
    for (let index = 0; index < level.length; index += 2) {
      const left = level[index]!;
      const right = level[index + 1] ?? left;
      next.push(hashNode("checkpoint-merkle-node-v1", left, right));
    }
    level = next;
  }
  return level[0]!;
}

function validateChunkRef(value: unknown): value is MerkleChunkRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const chunk = value as Partial<MerkleChunkRef>;
  return typeof chunk.digest === "string" && digest(chunk.digest)
    && safeCount(chunk.sizeBytes) && chunk.sizeBytes <= MANIFEST_CHUNK_MAX_BYTES
    && safeCount(chunk.itemCount) && chunk.itemCount > 0
    && typeof chunk.firstKey === "string" && chunk.firstKey.length > 0
    && typeof chunk.lastKey === "string" && chunk.lastKey.length > 0
    && chunk.firstKey <= chunk.lastKey;
}

function validDescriptorHeader(descriptor: Partial<MerkleDescriptor>): boolean {
  return descriptor.schemaVersion === 1 && descriptor.algorithm === "sha256" && descriptor.encoding === "jsonl"
    && safeCount(descriptor.itemCount) && typeof descriptor.merkleRoot === "string" && digest(descriptor.merkleRoot)
    && Array.isArray(descriptor.chunks) && descriptor.chunks.every(validateChunkRef);
}

function validDescriptorTree(descriptor: Partial<MerkleDescriptor>): boolean {
  const chunks = descriptor.chunks as MerkleChunkRef[];
  if (chunks.reduce((total, chunk) => total + chunk.itemCount, 0) !== descriptor.itemCount
    || checkpointChunkMerkleRoot(chunks) !== descriptor.merkleRoot) return false;
  for (let index = 1; index < chunks.length; index += 1) {
    if (chunks[index - 1]!.lastKey >= chunks[index]!.firstKey) return false;
  }
  return true;
}

function validManifestDescriptor(descriptor: Partial<ManifestMerkleDescriptorV1>): boolean {
  return safeCount(descriptor.fileCount) && safeCount(descriptor.totalBytes)
    && descriptor.fileCount === descriptor.itemCount;
}

function validDeltaDescriptor(descriptor: Partial<DeltaMerkleDescriptorV1>): boolean {
  const counts = descriptor.counts as Partial<DeltaMerkleDescriptorV1["counts"]> | undefined;
  if (!counts || !safeCount(counts.added) || !safeCount(counts.modified) || !safeCount(counts.deleted)) return false;
  return counts.added + counts.modified + counts.deleted === descriptor.itemCount;
}

function validateCommonDescriptor(value: unknown): value is MerkleDescriptor {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const descriptor = value as Partial<MerkleDescriptor>;
  if (!validDescriptorHeader(descriptor) || !validDescriptorTree(descriptor)) return false;
  if (descriptor.kind === "checkpoint_manifest_merkle_v1") return validManifestDescriptor(descriptor);
  return descriptor.kind === "checkpoint_delta_merkle_v1" && validDeltaDescriptor(descriptor);
}

async function putDescriptor(cas: CheckpointManifestCas, descriptor: MerkleDescriptor): Promise<string> {
  const bytes = Buffer.from(JSON.stringify(descriptor), "utf8");
  if (bytes.byteLength > MANIFEST_DESCRIPTOR_MAX_BYTES) {
    throw new CheckpointConflictError("Checkpoint Merkle descriptor exceeds its bounded storage limit.");
  }
  return await cas.putBytes(bytes);
}

async function putManifestDescriptor(
  cas: CheckpointManifestCas,
  chunks: MerkleChunkRef[],
  fileCount: number,
  totalBytes: number
): Promise<string> {
  return await putDescriptor(cas, {
    schemaVersion: 1,
    kind: "checkpoint_manifest_merkle_v1",
    algorithm: "sha256",
    encoding: "jsonl",
    fileCount,
    totalBytes,
    itemCount: fileCount,
    merkleRoot: checkpointChunkMerkleRoot(chunks),
    chunks
  });
}

export class CheckpointManifestMerkleCaptureWriter {
  private readonly writer: ExternalCheckpointManifestWriter;

  constructor(
    private readonly cas: CheckpointManifestCas,
    observer?: CheckpointManifestStreamObserver
  ) {
    this.writer = new ExternalCheckpointManifestWriter(cas, observer);
  }

  async add(entry: CheckpointEntry): Promise<void> {
    await this.writer.add(entry);
  }

  async finish(summary: { fileCount: number; totalBytes: number }): Promise<string> {
    const chunks = await this.writer.finish(summary);
    return await putManifestDescriptor(this.cas, chunks, summary.fileCount, summary.totalBytes);
  }
}

function strictlyOrdered(entries: readonly CheckpointEntry[]): boolean {
  for (let index = 1; index < entries.length; index += 1) {
    if (entries[index - 1]!.path >= entries[index]!.path) return false;
  }
  return true;
}

/** Stores entries in bounded JSONL leaves and returns the descriptor's CAS digest. */
export async function putCheckpointManifestMerkle(
  cas: CheckpointManifestCas,
  manifest: CheckpointManifest,
  observer?: CheckpointManifestStreamObserver
): Promise<string> {
  const summary = { fileCount: manifest.fileCount, totalBytes: manifest.totalBytes };
  let chunks: MerkleChunkRef[];
  if (strictlyOrdered(manifest.entries)) {
    chunks = await writeCanonicalCheckpointManifest(cas, manifest.entries, summary, observer);
  } else {
    const writer = new ExternalCheckpointManifestWriter(cas, observer);
    for (const entry of manifest.entries) await writer.add(entry);
    chunks = await writer.finish(summary);
  }
  return await putManifestDescriptor(cas, chunks, manifest.fileCount, manifest.totalBytes);
}

function deltaItems(delta: CheckpointDelta): DeltaItem[] {
  const seen = new Set<string>();
  return (["added", "modified", "deleted"] as const).flatMap((kind) =>
    [...delta[kind]].sort().map((itemPath) => {
      if (!itemPath || seen.has(itemPath)) {
        throw new CheckpointConflictError(`Checkpoint delta contains a duplicate or empty path: ${itemPath}`);
      }
      seen.add(itemPath);
      return { kind, path: itemPath };
    }));
}

function deltaKey(item: DeltaItem): string {
  const rank = item.kind === "added" ? "0" : item.kind === "modified" ? "1" : "2";
  return `${rank}:${item.path}`;
}

export async function putCheckpointDeltaMerkle(
  cas: CheckpointManifestCas,
  delta: CheckpointDelta
): Promise<string> {
  const items = deltaItems(delta);
  const writer = new BoundedJsonLineWriter(cas, deltaKey);
  for (const item of items) await writer.add(item);
  const chunks = await writer.finish();
  return await putDescriptor(cas, {
    schemaVersion: 1,
    kind: "checkpoint_delta_merkle_v1",
    algorithm: "sha256",
    encoding: "jsonl",
    itemCount: items.length,
    merkleRoot: checkpointChunkMerkleRoot(chunks),
    counts: {
      added: delta.added.length,
      modified: delta.modified.length,
      deleted: delta.deleted.length
    },
    chunks
  });
}

function parseJson(value: Buffer, label: string): unknown {
  try {
    return JSON.parse(value.toString("utf8")) as unknown;
  } catch (error) {
    throw new CheckpointConflictError(`Checkpoint ${label} is not valid JSON.`, { cause: error });
  }
}

function legacyManifest(value: unknown): value is CheckpointManifest {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && Array.isArray((value as Partial<CheckpointManifest>).entries));
}

async function readDescriptor(cas: CheckpointManifestCas, rootDigest: string): Promise<unknown> {
  return parseJson(
    await cas.readVerifiedAll(rootDigest, LEGACY_MANIFEST_MAX_BYTES),
    "manifest descriptor"
  );
}

function checkpointEntry(value: unknown): CheckpointEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CheckpointConflictError("Checkpoint manifest Merkle leaf contains an invalid item.");
  }
  const entry = value as CheckpointEntry;
  validateCheckpointEntry(entry);
  return entry;
}

function deltaItem(value: unknown): DeltaItem {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CheckpointConflictError("Checkpoint delta Merkle leaf contains an invalid item.");
  }
  const item = value as Partial<DeltaItem>;
  if (!(["added", "modified", "deleted"] as const).includes(item.kind as keyof CheckpointDelta)
    || typeof item.path !== "string" || item.path.length === 0) {
    throw new CheckpointConflictError("Checkpoint delta Merkle leaf contains an invalid item.");
  }
  return item as DeltaItem;
}

export interface CheckpointManifestMerkleStream {
  fileCount: number;
  totalBytes: number;
  entries: AsyncIterable<CheckpointEntry>;
}

async function* verifiedManifestEntries(
  cas: CheckpointManifestCas,
  descriptor: ManifestMerkleDescriptorV1,
  observer?: CheckpointManifestStreamObserver
): AsyncGenerator<CheckpointEntry> {
  const validator = new OrderedCheckpointManifestValidator();
  for await (const entry of readJsonLineChunks(
    cas,
    descriptor.chunks,
    checkpointEntry,
    (item) => item.path,
    observer
  )) {
    validator.add(entry);
    yield entry;
  }
  validator.finish({ fileCount: descriptor.fileCount, totalBytes: descriptor.totalBytes });
}

export async function readCheckpointManifestMerkleStream(
  cas: CheckpointManifestCas,
  rootDigest: string,
  observer?: CheckpointManifestStreamObserver
): Promise<CheckpointManifestMerkleStream> {
  const value = await readDescriptor(cas, rootDigest);
  if (legacyManifest(value)) {
    validateManifest(value);
    value.entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
    return {
      fileCount: value.fileCount,
      totalBytes: value.totalBytes,
      entries: (async function* (): AsyncGenerator<CheckpointEntry> { yield* value.entries; })()
    };
  }
  if (!validateCommonDescriptor(value) || value.kind !== "checkpoint_manifest_merkle_v1") {
    throw new CheckpointConflictError("Checkpoint manifest Merkle descriptor is invalid.");
  }
  return {
    fileCount: value.fileCount,
    totalBytes: value.totalBytes,
    entries: verifiedManifestEntries(cas, value, observer)
  };
}

export async function readCheckpointManifestMerkle(
  cas: CheckpointManifestCas,
  rootDigest: string,
  observer?: CheckpointManifestStreamObserver
): Promise<CheckpointManifest> {
  const stream = await readCheckpointManifestMerkleStream(cas, rootDigest, observer);
  const entries: CheckpointEntry[] = [];
  for await (const entry of stream.entries) entries.push(entry);
  return { entries, fileCount: stream.fileCount, totalBytes: stream.totalBytes };
}

export async function readCheckpointDeltaMerkle(
  cas: CheckpointManifestCas,
  rootDigest: string
): Promise<CheckpointDelta> {
  const value = await readDescriptor(cas, rootDigest);
  if (!validateCommonDescriptor(value) || value.kind !== "checkpoint_delta_merkle_v1") {
    throw new CheckpointConflictError("Checkpoint delta Merkle descriptor is invalid.");
  }
  const result: CheckpointDelta = { added: [], modified: [], deleted: [] };
  for await (const item of readJsonLineChunks(cas, value.chunks, deltaItem, deltaKey)) {
    result[item.kind].push(item.path);
  }
  if (result.added.length !== value.counts.added
    || result.modified.length !== value.counts.modified
    || result.deleted.length !== value.counts.deleted) {
    throw new CheckpointConflictError("Checkpoint delta Merkle counts are inconsistent.");
  }
  return result;
}

export const checkpointManifestStorageLimits = Object.freeze({
  chunkTargetBytes: MANIFEST_CHUNK_TARGET_BYTES,
  chunkMaxBytes: MANIFEST_CHUNK_MAX_BYTES,
  descriptorMaxBytes: MANIFEST_DESCRIPTOR_MAX_BYTES
});

export type { CheckpointManifestStreamObserver } from "./manifest-merkle-io.js";
