import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  PersistedAcpSession,
  ResolvedSession,
  SigmaAcpAgentOptions,
  SigmaAcpRuntimeHandle
} from "./sigma-acp-shared.js";

const SESSION_INDEX_FILE = "acp-sessions.json";
const INDEX_VERSION = 1;

interface PersistedAcpIndex {
  version: typeof INDEX_VERSION;
  sessions: PersistedAcpSession[];
}

function normalizeIndex(value: unknown): PersistedAcpIndex {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { version: INDEX_VERSION, sessions: [] };
  }
  const input = value as Record<string, unknown>;
  if (input.version !== INDEX_VERSION || !Array.isArray(input.sessions)) {
    return { version: INDEX_VERSION, sessions: [] };
  }
  const sessions = input.sessions.filter((item): item is PersistedAcpSession => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const record = item as Record<string, unknown>;
    return typeof record.sessionId === "string"
      && typeof record.runtimeSessionId === "string"
      && typeof record.cwd === "string"
      && typeof record.modelId === "string"
      && (record.mode === "analyze" || record.mode === "change")
      && typeof record.createdAt === "string"
      && typeof record.updatedAt === "string"
      && typeof record.started === "boolean"
      && Number.isSafeInteger(record.lastSeq)
      && Number(record.lastSeq) >= 0;
  });
  return { version: INDEX_VERSION, sessions };
}

export class SigmaAcpSessionRegistry {
  private readonly handles = new Map<string, Promise<SigmaAcpRuntimeHandle>>();
  private readonly indexes = new Map<string, PersistedAcpIndex>();
  private readonly indexWrites = new Map<string, Promise<void>>();
  private readonly sessionRoots = new Map<string, string>();
  private readonly attached = new Set<string>();

  constructor(private readonly options: SigmaAcpAgentOptions) {}

  async close(): Promise<void> {
    const handles = await Promise.allSettled(this.handles.values());
    await Promise.all(handles.flatMap((result) =>
      result.status === "fulfilled" ? [result.value.close()] : []
    ));
    this.handles.clear();
  }

  markAttached(record: PersistedAcpSession): void {
    this.attached.add(this.attachmentKey(record));
  }

  detach(record: PersistedAcpSession): void {
    this.attached.delete(this.attachmentKey(record));
  }

  handle(cwd: string, modelId: string): Promise<SigmaAcpRuntimeHandle> {
    const key = `${path.resolve(cwd)}\0${modelId}`;
    let handle = this.handles.get(key);
    if (!handle) {
      handle = this.options.runtimeFactory(path.resolve(cwd), modelId);
      this.handles.set(key, handle);
      void handle.catch(() => this.handles.delete(key));
    }
    return handle;
  }

  async index(storeRootDir: string): Promise<PersistedAcpIndex> {
    const key = path.resolve(storeRootDir);
    const cached = this.indexes.get(key);
    if (cached) return cached;
    let value: unknown;
    try {
      value = JSON.parse(await readFile(path.join(key, SESSION_INDEX_FILE), "utf8")) as unknown;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    const index = normalizeIndex(value);
    this.indexes.set(key, index);
    for (const record of index.sessions) this.sessionRoots.set(record.sessionId, key);
    return index;
  }

  async upsert(storeRootDir: string, record: PersistedAcpSession): Promise<void> {
    const root = path.resolve(storeRootDir);
    const previous = this.indexWrites.get(root) ?? Promise.resolve();
    const write = previous.then(async () => {
      const index = await this.index(root);
      const existing = index.sessions.findIndex((candidate) => candidate.sessionId === record.sessionId);
      const snapshot = { ...record };
      if (existing >= 0) index.sessions[existing] = snapshot;
      else index.sessions.push(snapshot);
      this.sessionRoots.set(record.sessionId, root);
      await mkdir(root, { recursive: true });
      const target = path.join(root, SESSION_INDEX_FILE);
      const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(index, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600
      });
      await rename(temporary, target);
    });
    this.indexWrites.set(root, write);
    try {
      await write;
    } finally {
      if (this.indexWrites.get(root) === write) this.indexWrites.delete(root);
    }
  }

  async resolveSession(sessionId: string, cwdHint?: string): Promise<ResolvedSession> {
    const knownRoot = cwdHint ? undefined : this.sessionRoots.get(sessionId);
    if (knownRoot) {
      const knownIndex = await this.index(knownRoot);
      const knownRecord = knownIndex.sessions.find((candidate) => candidate.sessionId === sessionId);
      if (knownRecord) {
        return {
          record: knownRecord,
          handle: await this.handle(knownRecord.cwd, knownRecord.modelId)
        };
      }
    }
    const cwd = path.resolve(cwdHint ?? process.cwd());
    const catalog = await this.options.modelCatalog(cwd);
    const defaultHandle = await this.handle(cwd, catalog.currentModelId);
    const index = await this.index(defaultHandle.storeRootDir);
    let record = index.sessions.find((candidate) => candidate.sessionId === sessionId);
    if (!record) {
      const native = (await defaultHandle.runtime.listSessions(Number.MAX_SAFE_INTEGER))
        .find((candidate) => candidate.sessionId === sessionId);
      if (!native) throw new Error(`Unknown Sigma ACP session '${sessionId}'.`);
      record = {
        sessionId,
        runtimeSessionId: sessionId,
        cwd: native.workspacePath,
        modelId: catalog.currentModelId,
        mode: native.mode,
        ...(native.lastMessage ? { title: native.lastMessage.slice(0, 96) } : {}),
        createdAt: native.updatedAt,
        updatedAt: native.updatedAt,
        started: native.lastSeq > 1,
        lastSeq: native.lastSeq
      };
      await this.upsert(defaultHandle.storeRootDir, record);
    }
    if (cwdHint && path.resolve(record.cwd) !== cwd) {
      throw new Error(`Sigma ACP session '${sessionId}' belongs to '${record.cwd}', not '${cwd}'.`);
    }
    return {
      record,
      handle: record.modelId === catalog.currentModelId
        ? defaultHandle
        : await this.handle(record.cwd, record.modelId)
    };
  }

  async ensureAttached(resolved: ResolvedSession): Promise<void> {
    const key = this.attachmentKey(resolved.record);
    if (this.attached.has(key)) return;
    await resolved.handle.runtime.command({
      type: "resume",
      sessionId: resolved.record.runtimeSessionId
    });
    this.attached.add(key);
  }

  private attachmentKey(record: PersistedAcpSession): string {
    return `${record.modelId}\0${record.runtimeSessionId}`;
  }
}
