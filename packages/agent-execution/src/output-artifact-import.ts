import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BrokerProtocolError } from "./errors.js";
import { SecretRedactor } from "./redaction.js";
import type { ProcessOutputArtifact } from "./types.js";
import type { OutputArtifactValue } from "./values.js";

const MAX_IMPORTED_ARTIFACT_BYTES = 64 * 1024 * 1024;
type ArtifactRootRemover = (root: string) => Promise<void>;

async function removeArtifactRoot(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
}

function pathWithin(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function readPinnedFile(filePath: string, expectedSize: number): Promise<Buffer> {
  const before = await lstat(filePath);
  if (!before.isFile() || before.isSymbolicLink() || before.size !== expectedSize) {
    throw new BrokerProtocolError("Output artifact file metadata does not match the broker receipt.");
  }
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const handle = await open(filePath, constants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size !== expectedSize
      || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new BrokerProtocolError("Output artifact identity changed before import.");
    }
    const content = await handle.readFile();
    const after = await handle.stat();
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) {
      throw new BrokerProtocolError("Output artifact changed during import.");
    }
    return content;
  } finally {
    await handle.close();
  }
}

/** Owns the short-lived trust boundary between broker spool files and durable CAS import. */
export class BrokerOutputArtifactImporter {
  private artifactRoot?: string;
  private readonly consumed = new Set<string>();
  private readonly paths = new Map<string, string>();
  private cleanupPromise?: Promise<void>;
  private activeOperations = 0;
  private idlePromise?: Promise<void>;
  private resolveIdle?: () => void;
  private closing = false;
  private cleaned = false;

  constructor(
    private readonly redactor: SecretRedactor,
    private readonly releaseRemote: (artifactIds: string[]) => Promise<unknown>,
    private readonly removeRoot: ArtifactRootRemover = removeArtifactRoot,
    private readonly trustedRootParent?: string
  ) {}

  async configureRoot(value: string | undefined): Promise<void> {
    if (value === undefined) return;
    if (this.closing || this.cleaned) {
      throw new BrokerProtocolError("Broker output artifact importer is already closing.");
    }
    if (!value || !path.isAbsolute(value)) {
      throw new BrokerProtocolError("Broker artifactRoot must be an absolute path.");
    }
    const resolved = path.resolve(value);
    if (!path.basename(resolved).startsWith("sigma-exec-artifacts-")) {
      throw new BrokerProtocolError("Broker artifactRoot is not a dedicated sigma-exec artifact directory.");
    }
    const info = await lstat(resolved).catch(() => undefined);
    if (!info?.isDirectory() || info.isSymbolicLink()) {
      throw new BrokerProtocolError("Broker artifactRoot must be an existing non-symlink directory.");
    }
    const canonical = await realpath(resolved);
    const allowedParents = [await realpath(this.trustedRootParent ?? os.tmpdir())];
    if (!allowedParents.some((parent) => pathWithin(canonical, parent))) {
      throw new BrokerProtocolError("Broker artifactRoot resolves outside its trusted parent.");
    }
    this.artifactRoot = canonical;
  }

  async consume(artifacts: readonly OutputArtifactValue[]): Promise<ProcessOutputArtifact[]> {
    return await this.runOperation(async () => await this.consumeOnce(artifacts));
  }

  private async consumeOnce(artifacts: readonly OutputArtifactValue[]): Promise<ProcessOutputArtifact[]> {
    const pending = artifacts.filter((artifact) => !this.consumed.has(artifact.artifactId));
    if (pending.length === 0) return [];
    const prepared: Array<{ imported: ProcessOutputArtifact; sourcePath: string }> = [];
    for (const artifact of pending) {
      const sourcePath = await this.validArtifactPath(artifact.path);
      if (artifact.sizeBytes > MAX_IMPORTED_ARTIFACT_BYTES) {
        throw new BrokerProtocolError("Output artifact exceeds the 64 MiB import limit.");
      }
      const nativeBytes = await readPinnedFile(sourcePath, artifact.sizeBytes);
      const checksum = createHash("sha256").update(nativeBytes).digest("hex");
      if (checksum !== artifact.sha256) throw new BrokerProtocolError("Output artifact checksum mismatch.");
      let decoded: string;
      try {
        decoded = new TextDecoder("utf-8", { fatal: true }).decode(nativeBytes);
      } catch (error) {
        throw new BrokerProtocolError("Broker output artifact is not valid normalized UTF-8.", { cause: error });
      }
      const content = Buffer.from(this.redactor.redactText(decoded), "utf8");
      prepared.push({ sourcePath, imported: {
        brokerArtifactId: artifact.artifactId, name: artifact.name, stream: artifact.stream,
        brokerSha256: artifact.sha256, sizeBytes: content.byteLength,
        complete: artifact.complete, redactionLossy: artifact.redactionLossy, content
      } });
    }
    for (const { imported, sourcePath } of prepared) {
      const artifactId = imported.brokerArtifactId;
      this.consumed.add(artifactId);
      this.paths.set(artifactId, sourcePath);
    }
    return prepared.map((item) => item.imported);
  }

  async acknowledge(artifactIds: readonly string[]): Promise<void> {
    await this.runOperation(async () => await this.acknowledgeOnce(artifactIds));
  }

  private async acknowledgeOnce(artifactIds: readonly string[]): Promise<void> {
    const ids = [...new Set(artifactIds.filter((id) => this.consumed.has(id)))];
    if (ids.length === 0) return;
    try {
      await this.releaseRemote(ids);
    } finally {
      await Promise.all(ids.map(async (id) => {
        const filePath = this.paths.get(id);
        if (filePath) await rm(filePath, { force: true }).catch(() => undefined);
        this.paths.delete(id);
      }));
    }
  }

  async cleanup(): Promise<void> {
    if (this.cleaned) return;
    this.closing = true;
    const operation = this.cleanupPromise ?? this.cleanupOnce();
    this.cleanupPromise = operation;
    try {
      await operation;
      this.cleaned = true;
    } finally {
      if (!this.cleaned && this.cleanupPromise === operation) this.cleanupPromise = undefined;
    }
  }

  private async cleanupOnce(): Promise<void> {
    if (this.activeOperations > 0) await this.idlePromise;
    const root = this.artifactRoot;
    if (root) await this.removeRoot(root);
    this.artifactRoot = undefined;
    this.paths.clear();
    this.consumed.clear();
  }

  private async runOperation<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing || this.cleaned) {
      throw new BrokerProtocolError("Broker output artifact importer is closing.");
    }
    if (this.activeOperations === 0) {
      this.idlePromise = new Promise<void>((resolve) => { this.resolveIdle = resolve; });
    }
    this.activeOperations += 1;
    try {
      return await operation();
    } finally {
      this.activeOperations -= 1;
      if (this.activeOperations === 0) {
        this.resolveIdle?.();
        this.resolveIdle = undefined;
      }
    }
  }

  private async validArtifactPath(value: string): Promise<string> {
    if (!this.artifactRoot || !path.isAbsolute(value)) {
      throw new BrokerProtocolError("Broker output artifact root is unavailable.");
    }
    const rawInfo = await lstat(value).catch(() => undefined);
    if (!rawInfo?.isFile() || rawInfo.isSymbolicLink()) {
      throw new BrokerProtocolError("Output artifact must be an existing non-symlink file.");
    }
    const root = await realpath(this.artifactRoot);
    const candidate = await realpath(value);
    if (path.dirname(candidate) !== root) {
      throw new BrokerProtocolError("Output artifact path escapes the broker temp root.");
    }
    return candidate;
  }
}
