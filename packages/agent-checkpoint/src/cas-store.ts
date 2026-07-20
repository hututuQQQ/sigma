import { createHash, randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { link, mkdir, open, rm } from "node:fs/promises";
import path from "node:path";
import { CheckpointConflictError, type CheckpointCasIdentity } from "./types.js";

const CAS_CHUNK_BYTES = 64 * 1024;

export interface CasWriteResult {
  digest: string;
  size: number;
  identity: CheckpointCasIdentity;
}

export interface CasPrefix {
  content: Buffer;
  size: number;
  truncated: boolean;
}

function identity(info: BigIntStats): CheckpointCasIdentity {
  return {
    dev: info.dev.toString(),
    ino: info.ino.toString(),
    mode: info.mode.toString(),
    size: info.size.toString(),
    mtimeNs: info.mtimeNs.toString(),
    ctimeNs: info.ctimeNs.toString()
  };
}

function sameIdentity(left: CheckpointCasIdentity, right: CheckpointCasIdentity): boolean {
  const fields = ["dev", "ino", "mode", "size", "mtimeNs", "ctimeNs"] as const;
  return fields.every((field) => left[field] === right[field]);
}

function safeSize(value: bigint, digest: string): number {
  const size = Number(value);
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new CheckpointConflictError(`Checkpoint CAS object is too large to address safely: ${digest}`);
  }
  return size;
}

function validateDigest(digest: string): void {
  if (!/^[a-f0-9]{64}$/u.test(digest)) throw new Error("Invalid checkpoint CAS digest.");
}

function validateReadLimit(maxBytes: number): void {
  if (maxBytes !== Number.POSITIVE_INFINITY && (!Number.isSafeInteger(maxBytes) || maxBytes < 0)) {
    throw new RangeError("Checkpoint CAS read limit must be a non-negative safe integer.");
  }
}

async function statIdentity(
  handle: Awaited<ReturnType<typeof open>>,
  digest: string
): Promise<{ identity: CheckpointCasIdentity; size: number }> {
  const info = await handle.stat({ bigint: true });
  if (!info.isFile()) throw new CheckpointConflictError(`Checkpoint CAS object is not a file: ${digest}`);
  return { identity: identity(info), size: safeSize(info.size, digest) };
}

async function writeChunk(
  handle: Awaited<ReturnType<typeof open>>,
  chunk: Uint8Array,
  position: number
): Promise<number> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset, position + offset);
    if (bytesWritten <= 0) throw new Error("Checkpoint CAS write made no progress.");
    offset += bytesWritten;
  }
  return offset;
}

export class CheckpointCasStore {
  private readonly directory: string;

  constructor(rootDir: string) {
    this.directory = path.join(rootDir, "checkpoints", "cas");
  }

  async putBytes(content: Uint8Array): Promise<string> {
    const result = await this.putStream((async function* (): AsyncGenerator<Uint8Array> {
      yield content;
    })());
    return result.digest;
  }

  async putStream(content: AsyncIterable<Uint8Array>): Promise<CasWriteResult> {
    await mkdir(this.directory, { recursive: true });
    const temporary = path.join(this.directory, `.${randomUUID()}.tmp`);
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    const hash = createHash("sha256");
    let size = 0;
    try {
      for await (const chunk of content) {
        if (!(chunk instanceof Uint8Array)) throw new TypeError("Checkpoint CAS source yielded a non-byte chunk.");
        if (chunk.byteLength === 0) continue;
        hash.update(chunk);
        size += await writeChunk(handle, chunk, size);
      }
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
    await handle.close();
    const digest = hash.digest("hex");
    const target = this.pathFor(digest);
    let reused = false;
    try {
      await link(temporary, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
      }
      reused = true;
    }
    await rm(temporary, { force: true });
    const verified = reused ? await this.verify(digest, { expectedSize: size }) : await this.inspect(digest);
    return { digest, size, identity: verified.identity };
  }

  async readVerifiedAll(digest: string, maxBytes = Number.POSITIVE_INFINITY): Promise<Buffer> {
    validateReadLimit(maxBytes);
    const chunks: Buffer[] = [];
    const verified = await this.verify(digest, {
      maxBytes,
      collect: (chunk) => chunks.push(chunk)
    });
    return Buffer.concat(chunks, verified.size);
  }

  async readPrefix(
    digest: string,
    maxBytes: number,
    expectedIdentity: CheckpointCasIdentity
  ): Promise<CasPrefix> {
    validateReadLimit(maxBytes);
    const handle = await this.openRead(digest);
    let before: { identity: CheckpointCasIdentity; size: number } | undefined;
    try {
      before = await statIdentity(handle, digest);
      if (!sameIdentity(before.identity, expectedIdentity)) {
        throw new CheckpointConflictError(`Checkpoint CAS identity no longer matches its manifest: ${digest}`);
      }
      const length = Math.min(before.size, maxBytes);
      const content = Buffer.allocUnsafe(length);
      let position = 0;
      while (position < length) {
        const { bytesRead } = await handle.read(content, position, length - position, position);
        if (bytesRead <= 0) break;
        position += bytesRead;
      }
      const after = await statIdentity(handle, digest);
      if (!sameIdentity(before.identity, after.identity)) {
        throw new CheckpointConflictError(`Checkpoint CAS object changed while reading: ${digest}`);
      }
      const prefix = position === content.byteLength ? content : content.subarray(0, position);
      return { content: prefix, size: before.size, truncated: position < before.size };
    } finally {
      await handle.close();
    }
  }

  async *stream(
    digest: string,
    maxBytes = Number.POSITIVE_INFINITY,
    expectedIdentity?: CheckpointCasIdentity
  ): AsyncGenerator<Buffer> {
    validateReadLimit(maxBytes);
    const handle = await this.openRead(digest);
    const hash = createHash("sha256");
    let before: { identity: CheckpointCasIdentity; size: number } | undefined;
    let position = 0;
    let changed: boolean;
    try {
      before = await statIdentity(handle, digest);
      if (expectedIdentity && !sameIdentity(before.identity, expectedIdentity)) {
        throw new CheckpointConflictError(`Checkpoint CAS identity no longer matches its manifest: ${digest}`);
      }
      while (position < before.size && position < maxBytes) {
        const length = Math.min(CAS_CHUNK_BYTES, before.size - position, maxBytes - position);
        const buffer = Buffer.allocUnsafe(length);
        const { bytesRead } = await handle.read(buffer, 0, length, position);
        if (bytesRead <= 0) break;
        position += bytesRead;
        const chunk = bytesRead === buffer.byteLength ? buffer : buffer.subarray(0, bytesRead);
        hash.update(chunk);
        yield chunk;
      }
    } finally {
      const after = await statIdentity(handle, digest).catch(() => undefined);
      await handle.close();
      changed = Boolean(before && (!after || !sameIdentity(before.identity, after.identity)));
    }
    if (changed) {
      throw new CheckpointConflictError(`Checkpoint CAS object changed while reading: ${digest}`);
    }
    if (before && maxBytes >= before.size
      && (position !== before.size || hash.digest("hex") !== digest)) {
      throw new CheckpointConflictError(`Checkpoint CAS content is corrupt: ${digest}`);
    }
  }

  private async verify(digest: string, options: {
    expectedSize?: number;
    maxBytes?: number;
    collect?: (chunk: Buffer) => void;
  } = {}): Promise<{ identity: CheckpointCasIdentity; size: number }> {
    const handle = await this.openRead(digest);
    const hash = createHash("sha256");
    let before: { identity: CheckpointCasIdentity; size: number } | undefined;
    let position = 0;
    try {
      before = await statIdentity(handle, digest);
      if (before.size > (options.maxBytes ?? Number.POSITIVE_INFINITY)) {
        throw new CheckpointConflictError(`Checkpoint CAS object exceeds its bounded read limit: ${digest}`);
      }
      while (position < before.size) {
        const length = Math.min(CAS_CHUNK_BYTES, before.size - position);
        const buffer = Buffer.allocUnsafe(length);
        const { bytesRead } = await handle.read(buffer, 0, length, position);
        if (bytesRead <= 0) break;
        const chunk = bytesRead === buffer.byteLength ? buffer : buffer.subarray(0, bytesRead);
        hash.update(chunk);
        options.collect?.(chunk);
        position += bytesRead;
      }
      const after = await statIdentity(handle, digest);
      if (!sameIdentity(before.identity, after.identity)) {
        throw new CheckpointConflictError(`Checkpoint CAS object changed while verifying: ${digest}`);
      }
    } finally {
      await handle.close();
    }
    if (!before || position !== before.size || hash.digest("hex") !== digest
      || (options.expectedSize !== undefined && position !== options.expectedSize)) {
      throw new CheckpointConflictError(`Checkpoint CAS content is corrupt: ${digest}`);
    }
    return before;
  }

  private async inspect(digest: string): Promise<{ identity: CheckpointCasIdentity; size: number }> {
    const handle = await this.openRead(digest);
    try {
      return await statIdentity(handle, digest);
    } finally {
      await handle.close();
    }
  }

  private async openRead(digest: string): Promise<Awaited<ReturnType<typeof open>>> {
    return await open(this.pathFor(digest), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  }

  private pathFor(digest: string): string {
    validateDigest(digest);
    return path.join(this.directory, digest);
  }
}
