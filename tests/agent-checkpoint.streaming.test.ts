import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { checkpointManifestSortLimits } from "../packages/agent-checkpoint/src/manifest-canonical-stream.js";
import {
  CheckpointManifestMerkleCaptureWriter,
  checkpointManifestStorageLimits,
  putCheckpointManifestMerkle,
  readCheckpointManifestMerkleStream,
  type CheckpointManifestCas,
  type CheckpointManifestStreamObserver
} from "../packages/agent-checkpoint/src/manifest-store.js";

class MemoryManifestCas implements CheckpointManifestCas {
  private readonly values = new Map<string, Buffer>();

  async putStream(content: AsyncIterable<Uint8Array>): Promise<{ digest: string; size: number }> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of content) {
      const copy = Buffer.from(chunk);
      chunks.push(copy);
      size += copy.byteLength;
    }
    const value = Buffer.concat(chunks, size);
    const digest = createHash("sha256").update(value).digest("hex");
    this.values.set(digest, value);
    return { digest, size };
  }

  async putBytes(content: Uint8Array): Promise<string> {
    return (await this.putStream((async function* (): AsyncGenerator<Uint8Array> {
      yield content;
    })())).digest;
  }

  async readVerifiedAll(digest: string, maxBytes = Number.POSITIVE_INFINITY): Promise<Buffer> {
    const value = this.values.get(digest);
    if (!value || value.byteLength > maxBytes
      || createHash("sha256").update(value).digest("hex") !== digest) {
      throw new Error(`Invalid in-memory checkpoint CAS read: ${digest}`);
    }
    return value;
  }
}

function metrics(): {
  observer: CheckpointManifestStreamObserver;
  maximum: { writeItems: number; writeBytes: number; readBytes: number; sortItems: number; sortBytes: number; heads: number };
} {
  const maximum = { writeItems: 0, writeBytes: 0, readBytes: 0, sortItems: 0, sortBytes: 0, heads: 0 };
  return {
    maximum,
    observer: {
      writeBuffer: (items, bytes) => {
        maximum.writeItems = Math.max(maximum.writeItems, items);
        maximum.writeBytes = Math.max(maximum.writeBytes, bytes);
      },
      readBuffer: (bytes) => { maximum.readBytes = Math.max(maximum.readBytes, bytes); },
      sortRun: (items, bytes) => {
        maximum.sortItems = Math.max(maximum.sortItems, items);
        maximum.sortBytes = Math.max(maximum.sortBytes, bytes);
      },
      mergeHeads: (heads) => { maximum.heads = Math.max(maximum.heads, heads); }
    }
  };
}

describe("checkpoint manifest bounded streaming", () => {
  it("writes and verifies 250k canonical paths with leaf-bounded buffers", async () => {
    const cas = new MemoryManifestCas();
    const observed = metrics();
    const entries = Array.from({ length: 250_000 }, (_unused, index) => ({
      path: `bulk/path-${index.toString().padStart(6, "0")}`,
      kind: "directory" as const,
      mode: 0o40755,
      size: 0
    }));
    const digest = await putCheckpointManifestMerkle(
      cas,
      { entries, fileCount: entries.length, totalBytes: 0 },
      observed.observer
    );
    const stream = await readCheckpointManifestMerkleStream(cas, digest, observed.observer);
    let count = 0;
    for await (const _entry of stream.entries) count += 1;

    expect(count).toBe(250_000);
    expect(observed.maximum.writeBytes).toBeLessThanOrEqual(checkpointManifestStorageLimits.chunkMaxBytes);
    expect(observed.maximum.readBytes).toBeLessThanOrEqual(checkpointManifestStorageLimits.chunkMaxBytes);
    expect(observed.maximum.sortItems).toBe(0);
  }, 60_000);

  it("external-merges 100k reverse-ordered capture entries with fixed run bounds", async () => {
    const cas = new MemoryManifestCas();
    const observed = metrics();
    const writer = new CheckpointManifestMerkleCaptureWriter(cas, observed.observer);
    const total = 100_000;
    for (let index = total; index > 0; index -= 1) {
      await writer.add({
        path: `capture/path-${index.toString().padStart(6, "0")}`,
        kind: "directory",
        mode: 0o40755,
        size: 0
      });
    }
    const digest = await writer.finish({ fileCount: total, totalBytes: 0 });
    const stream = await readCheckpointManifestMerkleStream(cas, digest, observed.observer);
    let count = 0;
    let first = "";
    let last = "";
    for await (const entry of stream.entries) {
      if (count === 0) first = entry.path;
      last = entry.path;
      count += 1;
    }

    expect({ count, first, last }).toEqual({
      count: total,
      first: "capture/path-000001",
      last: "capture/path-100000"
    });
    expect(observed.maximum.sortItems).toBeLessThanOrEqual(checkpointManifestSortLimits.runMaxItems);
    expect(observed.maximum.sortBytes).toBeLessThanOrEqual(checkpointManifestSortLimits.runMaxBytes);
    expect(observed.maximum.writeBytes).toBeLessThanOrEqual(checkpointManifestStorageLimits.chunkMaxBytes);
    expect(observed.maximum.readBytes).toBeLessThanOrEqual(checkpointManifestStorageLimits.chunkMaxBytes);
    expect(observed.maximum.heads).toBeLessThanOrEqual(checkpointManifestSortLimits.mergeMaxRuns);
  }, 60_000);
});
