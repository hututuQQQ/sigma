import { CheckpointConflictError } from "./types.js";

export const MANIFEST_CHUNK_TARGET_BYTES = 64 * 1024;
export const MANIFEST_CHUNK_MAX_BYTES = 256 * 1024;

export interface MerkleChunkRef {
  digest: string;
  sizeBytes: number;
  itemCount: number;
  firstKey: string;
  lastKey: string;
}

export interface CheckpointManifestStreamObserver {
  writeBuffer?(items: number, bytes: number): void;
  readBuffer?(bytes: number): void;
  sortRun?(items: number, bytes: number): void;
  mergeHeads?(heads: number): void;
}

export interface CheckpointMerkleCas {
  putStream(content: AsyncIterable<Uint8Array>): Promise<{ digest: string; size: number }>;
  readVerifiedAll(digest: string, maxBytes?: number): Promise<Buffer>;
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new CheckpointConflictError(`Checkpoint ${label} is not valid JSON.`, { cause: error });
  }
}

/** Incremental canonical JSONL writer. At most one bounded leaf is buffered. */
export class BoundedJsonLineWriter<T> {
  private readonly chunks: MerkleChunkRef[] = [];
  private buffered: Buffer[] = [];
  private bufferedBytes = 0;
  private firstKey = "";
  private lastKey = "";
  private previousKey: string | undefined;

  constructor(
    private readonly cas: CheckpointMerkleCas,
    private readonly key: (item: T) => string,
    private readonly observer?: CheckpointManifestStreamObserver
  ) {}

  async add(item: T): Promise<void> {
    const itemKey = this.key(item);
    if (!itemKey || (this.previousKey !== undefined && this.previousKey >= itemKey)) {
      throw new CheckpointConflictError(`Checkpoint Merkle items are not strictly ordered: ${itemKey}`);
    }
    const encoded = Buffer.from(`${JSON.stringify(item)}\n`, "utf8");
    if (encoded.byteLength > MANIFEST_CHUNK_MAX_BYTES) {
      throw new CheckpointConflictError(`Checkpoint manifest item is too large to store safely: ${itemKey}`);
    }
    if (this.buffered.length > 0
      && this.bufferedBytes + encoded.byteLength > MANIFEST_CHUNK_TARGET_BYTES) {
      await this.flush();
    }
    if (this.buffered.length === 0) this.firstKey = itemKey;
    this.lastKey = itemKey;
    this.previousKey = itemKey;
    this.buffered.push(encoded);
    this.bufferedBytes += encoded.byteLength;
    this.observer?.writeBuffer?.(this.buffered.length, this.bufferedBytes);
  }

  async finish(): Promise<MerkleChunkRef[]> {
    await this.flush();
    return this.chunks;
  }

  private async flush(): Promise<void> {
    if (this.buffered.length === 0) return;
    const source = this.buffered;
    const sizeBytes = this.bufferedBytes;
    const firstKey = this.firstKey;
    const lastKey = this.lastKey;
    this.buffered = [];
    this.bufferedBytes = 0;
    this.firstKey = "";
    this.lastKey = "";
    const stored = await this.cas.putStream((async function* (): AsyncGenerator<Buffer> {
      yield* source;
    })());
    if (stored.size !== sizeBytes) {
      throw new CheckpointConflictError("Checkpoint Merkle leaf size changed while storing.");
    }
    this.chunks.push({
      digest: stored.digest,
      sizeBytes: stored.size,
      itemCount: source.length,
      firstKey,
      lastKey
    });
  }
}

function* decodeLeaf<T>(
  content: Buffer,
  chunk: MerkleChunkRef,
  parse: (value: unknown) => T,
  key: (value: T) => string,
  order: { previousKey?: string }
): Generator<T> {
  if (content.byteLength !== chunk.sizeBytes || content.at(-1) !== 0x0a) {
    throw new CheckpointConflictError(`Checkpoint Merkle leaf metadata is inconsistent: ${chunk.digest}`);
  }
  let offset = 0;
  let itemCount = 0;
  let firstKey = "";
  let lastKey = "";
  while (offset < content.byteLength) {
    const newline = content.indexOf(0x0a, offset);
    if (newline < offset || newline === offset) {
      throw new CheckpointConflictError(`Checkpoint Merkle leaf framing is invalid: ${chunk.digest}`);
    }
    const item = parse(parseJson(content.toString("utf8", offset, newline), "Merkle leaf item"));
    const itemKey = key(item);
    if (!itemKey || (order.previousKey !== undefined && order.previousKey >= itemKey)) {
      throw new CheckpointConflictError(`Checkpoint Merkle leaf is not strictly ordered: ${chunk.digest}`);
    }
    if (itemCount === 0) firstKey = itemKey;
    lastKey = itemKey;
    order.previousKey = itemKey;
    itemCount += 1;
    offset = newline + 1;
    yield item;
  }
  if (itemCount !== chunk.itemCount || firstKey !== chunk.firstKey || lastKey !== chunk.lastKey) {
    throw new CheckpointConflictError(`Checkpoint Merkle leaf bounds are inconsistent: ${chunk.digest}`);
  }
}

/** Reads verified leaves one item at a time without split/map chunk copies. */
export async function* readJsonLineChunks<T>(
  cas: CheckpointMerkleCas,
  chunks: readonly MerkleChunkRef[],
  parse: (value: unknown) => T,
  key: (value: T) => string,
  observer?: CheckpointManifestStreamObserver
): AsyncGenerator<T> {
  const order: { previousKey?: string } = {};
  for (const chunk of chunks) {
    const content = await cas.readVerifiedAll(chunk.digest, MANIFEST_CHUNK_MAX_BYTES);
    observer?.readBuffer?.(content.byteLength);
    yield* decodeLeaf(content, chunk, parse, key, order);
  }
}
