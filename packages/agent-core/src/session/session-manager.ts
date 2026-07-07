import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { redactSecrets, redactSecretText } from "../redaction.js";
import type { AgentEvent, AgentRunResult, SummaryJson } from "../types.js";
import { JsonlSessionStore } from "./jsonl-session-store.js";
import {
  appendSessionIndexRecord,
  defaultSessionRootDir,
  sessionDir,
  sessionIndexPath,
  sessionIndexRecordFromMeta
} from "./session-index.js";
import type { DurableSessionMeta, SessionPaths } from "./session-types.js";
import { GitCheckpointManager } from "./checkpoints.js";

export interface CreateSessionManagerOptions {
  sessionId?: string;
  runId: string;
  instruction: string;
  workspacePath: string;
  provider: string;
  model: string;
  sessionRootDir?: string;
  traceJsonlPath?: string;
  sessionJsonlPath?: string;
  summaryJsonPath?: string;
  parentSessionId?: string;
  forkedFromSessionId?: string;
}

function safeSessionId(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120) || randomUUID();
}

export function generateSessionId(date = new Date()): string {
  const stamp = date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `${stamp}-${randomUUID().slice(0, 8)}`;
}

function titleFromInstruction(instruction: string): string {
  const first = redactSecretText(instruction).split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  if (!first) return "Untitled run";
  return first.length <= 90 ? first : `${first.slice(0, 87)}...`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function pathsForSession(rootDir: string, sessionId: string): SessionPaths {
  const sessionPath = sessionDir(rootDir, sessionId);
  return {
    rootDir,
    sessionDir: sessionPath,
    metaPath: path.join(sessionPath, "meta.json"),
    eventsPath: path.join(sessionPath, "events.jsonl"),
    summaryPath: path.join(sessionPath, "summary.json"),
    checkpointsDir: path.join(sessionPath, "checkpoints"),
    indexPath: sessionIndexPath(rootDir)
  };
}

export class SessionManager {
  readonly sessionId: string;
  readonly paths: SessionPaths;
  readonly eventStore: JsonlSessionStore;
  readonly checkpoints: GitCheckpointManager;
  private meta: DurableSessionMeta;

  private constructor(meta: DurableSessionMeta, paths: SessionPaths) {
    this.sessionId = meta.sessionId;
    this.paths = paths;
    this.meta = meta;
    this.eventStore = new JsonlSessionStore(paths.eventsPath);
    this.checkpoints = new GitCheckpointManager({
      sessionId: meta.sessionId,
      workspacePath: meta.workspacePath,
      checkpointsDir: paths.checkpointsDir
    });
  }

  static async create(options: CreateSessionManagerOptions): Promise<SessionManager> {
    const rootDir = path.resolve(options.sessionRootDir ?? defaultSessionRootDir(options.workspacePath));
    const sessionId = safeSessionId(options.sessionId ?? generateSessionId());
    const paths = pathsForSession(rootDir, sessionId);
    const timestamp = nowIso();
    const meta: DurableSessionMeta = {
      sessionId,
      runId: options.runId,
      title: titleFromInstruction(options.instruction),
      instruction: redactSecretText(options.instruction),
      workspacePath: path.resolve(options.workspacePath),
      provider: options.provider,
      model: options.model,
      status: "running",
      createdAt: timestamp,
      updatedAt: timestamp,
      changedFiles: [],
      summaryPath: paths.summaryPath,
      eventsPath: paths.eventsPath,
      checkpointsDir: paths.checkpointsDir,
      ...(options.traceJsonlPath ? { traceJsonlPath: path.resolve(options.traceJsonlPath) } : {}),
      ...(options.sessionJsonlPath ? { sessionJsonlPath: path.resolve(options.sessionJsonlPath) } : {}),
      ...(options.summaryJsonPath ? { compatibilitySummaryPath: path.resolve(options.summaryJsonPath) } : {}),
      ...(options.parentSessionId ? { parentSessionId: options.parentSessionId } : {}),
      ...(options.forkedFromSessionId ? { forkedFromSessionId: options.forkedFromSessionId } : {})
    };
    const manager = new SessionManager(meta, paths);
    await manager.writeMeta();
    await manager.writeIndex();
    return manager;
  }

  async appendEvent(agentEvent: AgentEvent): Promise<void> {
    await this.eventStore.append({ ...agentEvent, sessionId: this.sessionId });
  }

  async complete(result: AgentRunResult, summary: SummaryJson): Promise<void> {
    this.meta = {
      ...this.meta,
      status: result.status,
      finishReason: result.finishReason,
      updatedAt: nowIso(),
      durationMs: result.durationMs,
      changedFiles: result.changedFiles ?? [],
      finalMessage: result.finalMessage ? redactSecretText(result.finalMessage) : undefined,
      lastError: result.lastError,
      toolsAvailable: result.toolsAvailable
    };
    await mkdir(this.paths.sessionDir, { recursive: true });
    await writeFile(this.paths.summaryPath, `${JSON.stringify(redactSecrets(summary), null, 2)}\n`, "utf8");
    await this.writeMeta();
    await this.writeIndex();
  }

  private async writeMeta(): Promise<void> {
    await mkdir(this.paths.sessionDir, { recursive: true });
    await writeFile(this.paths.metaPath, `${JSON.stringify(redactSecrets(this.meta), null, 2)}\n`, "utf8");
  }

  private async writeIndex(): Promise<void> {
    await appendSessionIndexRecord(this.paths.rootDir, sessionIndexRecordFromMeta(this.meta));
  }
}

export async function createSessionManager(options: CreateSessionManagerOptions): Promise<SessionManager> {
  return await SessionManager.create(options);
}
