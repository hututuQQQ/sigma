import path from "node:path";
import { CheckpointCasStore } from "./cas-store.js";
import {
  captureCheckpointManifest,
  type CheckpointCaptureCache
} from "./safe-capture.js";
import {
  CheckpointConflictError,
  type CheckpointEntry,
  type CheckpointManifest
} from "./types.js";

export class CheckpointCaptureCoordinator {
  private readonly caches = new Map<string, CheckpointCaptureCache>();

  constructor(
    private readonly cas: CheckpointCasStore,
    private readonly maxFiles: number,
    private readonly maxBytes: number,
    private readonly excludedNames: ReadonlySet<string>
  ) {}

  async capture(
    workspacePath: string,
    scopePaths: readonly string[],
    ignoredRootName?: string
  ): Promise<CheckpointManifest> {
    const cacheKey = JSON.stringify([
      path.resolve(workspacePath),
      [...scopePaths],
      ignoredRootName ?? null
    ]);
    let cache = this.caches.get(cacheKey);
    if (!cache) {
      cache = { files: new Map() };
      this.caches.set(cacheKey, cache);
    }
    return await captureCheckpointManifest({
      workspacePath,
      scopePaths,
      maxFiles: this.maxFiles,
      maxBytes: this.maxBytes,
      excludedNames: this.excludedNames,
      ...(ignoredRootName ? { ignoredRootName } : {}),
      cache,
      assertReusableCas: async (entry) => await this.inspectCas(entry),
      putCas: async (content) => await this.cas.putStream(content)
    });
  }

  async inspectCas(entry: CheckpointEntry): Promise<void> {
    if (!entry.digest || !entry.casIdentity) {
      throw new CheckpointConflictError(`Checkpoint CAS identity is missing: ${entry.path}`);
    }
    await this.cas.assertIdentity(entry.digest, entry.casIdentity, entry.size);
  }
}
