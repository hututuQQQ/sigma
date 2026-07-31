import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  Api,
  Model,
  ModelsStore,
  ModelsStoreEntry
} from "@earendil-works/pi-ai";
import {
  acquireProcessOwnerLease,
  ensurePrivateStateDirectory,
  restrictWindowsPathToCurrentUser,
  syncDirectory
} from "agent-platform";

interface ModelsDocument {
  version: 1;
  providers: Record<string, ModelsStoreEntry>;
}

export interface FileModelsStoreOptions {
  filePath?: string;
  homeDir?: string;
}

export function defaultSigmaModelsPath(homeDir = os.homedir()): string {
  return path.join(homeDir, ".sigma", "models.json");
}

function emptyDocument(): ModelsDocument {
  return { version: 1, providers: {} };
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isModelCost(value: unknown): value is Model<Api>["cost"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const cost = value as Record<string, unknown>;
  return isNonNegativeFiniteNumber(cost.input)
    && isNonNegativeFiniteNumber(cost.output)
    && isNonNegativeFiniteNumber(cost.cacheRead)
    && isNonNegativeFiniteNumber(cost.cacheWrite);
}

function hasModelIdentity(model: Record<string, unknown>): boolean {
  return typeof model.id === "string"
    && model.id.length > 0
    && typeof model.name === "string"
    && model.name.length > 0
    && typeof model.api === "string"
    && model.api.length > 0
    && typeof model.provider === "string"
    && model.provider.length > 0
    && typeof model.baseUrl === "string";
}

function hasModelCapabilities(model: Record<string, unknown>): boolean {
  return typeof model.reasoning === "boolean"
    && isPositiveSafeInteger(model.contextWindow)
    && isPositiveSafeInteger(model.maxTokens)
    && Array.isArray(model.input)
    && model.input.length > 0
    && model.input.every((input) => input === "text" || input === "image");
}

function isModel(value: unknown): value is Model<Api> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const model = value as Record<string, unknown>;
  return hasModelIdentity(model)
    && hasModelCapabilities(model)
    && isModelCost(model.cost);
}

function isEntry(value: unknown): value is ModelsStoreEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return Array.isArray(entry.models)
    && entry.models.every(isModel)
    && (entry.lastModified === undefined || isNonNegativeFiniteNumber(entry.lastModified))
    && (entry.checkedAt === undefined || isNonNegativeFiniteNumber(entry.checkedAt))
    && (entry.etag === undefined || typeof entry.etag === "string");
}

function parseDocument(value: unknown): ModelsDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) return emptyDocument();
  const candidate = value as { version?: unknown; providers?: unknown };
  if (candidate.version !== 1 || !candidate.providers
    || typeof candidate.providers !== "object" || Array.isArray(candidate.providers)) {
    return emptyDocument();
  }
  return {
    version: 1,
    providers: Object.fromEntries(
      Object.entries(candidate.providers).filter(
        (entry): entry is [string, ModelsStoreEntry] => Boolean(entry[0]) && isEntry(entry[1])
      )
    )
  };
}

async function readPrivateJson(filePath: string): Promise<ModelsDocument> {
  const info = await lstat(filePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!info) return emptyDocument();
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error("Sigma model catalog path is not a regular file.");
  }
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
    throw new Error("Sigma model catalog file permissions are not private.");
  }
  const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
  const handle = await open(filePath, constants.O_RDONLY | noFollow);
  try {
    const content = await handle.readFile("utf8");
    try {
      return parseDocument(JSON.parse(content) as unknown);
    } catch {
      throw new Error("Sigma model catalog file contains invalid JSON.");
    }
  } finally {
    await handle.close();
  }
}

async function writePrivateJson(filePath: string, content: string): Promise<void> {
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  let published = false;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await restrictWindowsPathToCurrentUser(temporary, { directory: false });
    await rename(temporary, filePath);
    published = true;
    await syncDirectory(path.dirname(filePath));
  } finally {
    if (!published) await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export class FileModelsStore implements ModelsStore {
  readonly filePath: string;

  constructor(options: FileModelsStoreOptions = {}) {
    this.filePath = path.resolve(options.filePath ?? defaultSigmaModelsPath(options.homeDir));
  }

  private async prepareDirectory(): Promise<void> {
    const directory = await ensurePrivateStateDirectory(path.dirname(this.filePath));
    await restrictWindowsPathToCurrentUser(directory, { directory: true });
  }

  private async update(run: (document: ModelsDocument) => void): Promise<void> {
    await this.prepareDirectory();
    const lease = await acquireProcessOwnerLease(
      `${this.filePath}.lock`,
      { pid: process.pid, instanceId: randomUUID(), startedAt: new Date().toISOString() },
      { label: "Sigma model catalog", timeoutMs: 30_000 }
    );
    try {
      const document = await readPrivateJson(this.filePath);
      run(document);
      await writePrivateJson(this.filePath, `${JSON.stringify(document, null, 2)}\n`);
    } finally {
      await lease.release();
    }
  }

  async read(providerId: string): Promise<ModelsStoreEntry | undefined> {
    return (await readPrivateJson(this.filePath)).providers[providerId];
  }

  async write(providerId: string, entry: ModelsStoreEntry): Promise<void> {
    await this.update((document) => {
      document.providers[providerId] = {
        ...entry,
        models: [...entry.models]
      };
    });
  }

  async delete(providerId: string): Promise<void> {
    await this.update((document) => {
      delete document.providers[providerId];
    });
  }
}
