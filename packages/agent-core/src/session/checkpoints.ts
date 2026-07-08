import { mkdtemp, mkdir, readFile, readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import type { ToolCall } from "agent-ai";
import { truncateMiddle } from "../compaction.js";
import { runCommand } from "../command-runner.js";
import { resolveWorkspacePath } from "../policy.js";
import type { ToolResult, WorkspaceManifest } from "../types.js";
import { toolAllMetadata, toolModelContent } from "../types.js";
import { changedWorkspaceFiles, listWorkspaceManifest } from "../harness/manifest.js";
import { gitCommandSpec } from "../tools/git-command.js";
import type { CheckpointRecord, CheckpointRestoreResult } from "./session-types.js";

interface GitSnapshot {
  tree: string;
}

interface PendingCheckpoint {
  sequence: number;
  toolCall: ToolCall;
  before: GitSnapshot;
}

interface FileSnapshotState {
  kind: "file" | "missing" | "skipped";
  sha256?: string;
  size?: number;
  content?: string;
  reason?: string;
}

interface FileCheckpointEntry {
  path: string;
  before: FileSnapshotState;
  after: FileSnapshotState;
}

interface FileCheckpointSnapshot {
  version: 1;
  entries: FileCheckpointEntry[];
}

interface PendingFileCheckpoint {
  sequence: number;
  toolCall: ToolCall;
  beforeManifest: WorkspaceManifest;
  beforeFiles: Map<string, FileSnapshotState>;
}

export interface CheckpointManager {
  beforeTool(toolCall: ToolCall): Promise<PendingCheckpoint | PendingFileCheckpoint | null>;
  afterTool(pending: PendingCheckpoint | PendingFileCheckpoint | null, result: ToolResult): Promise<CheckpointRecord | null>;
}

export interface GitCheckpointManagerOptions {
  sessionId: string;
  workspacePath: string;
  checkpointsDir: string;
}

const CHECKPOINTED_TOOLS = new Set(["write", "edit", "apply_patch", "bash", "shell_session", "service"]);
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const MAX_FILE_CHECKPOINT_BYTES = 512 * 1024;

function nowIso(): string {
  return new Date().toISOString();
}

function checkpointId(sequence: number): string {
  return String(sequence).padStart(4, "0");
}

function isCheckpointedTool(call: ToolCall): boolean {
  if (!CHECKPOINTED_TOOLS.has(call.function.name)) return false;
  if (call.function.name === "shell_session") {
    return argsObject(call.function.arguments)?.action === "send";
  }
  if (call.function.name === "service") {
    const action = argsObject(call.function.arguments)?.action;
    return action === "start" || action === "stop";
  }
  return true;
}

function argsObject(args: unknown): Record<string, unknown> | null {
  if (!args || typeof args !== "object") return null;
  return args as Record<string, unknown>;
}

function trimOutput(value: string, maxChars = 4000): string {
  return value.length <= maxChars ? value : value.slice(-maxChars);
}

function parsePatchChangedFiles(patch: string): string[] {
  const files = new Set<string>();
  for (const line of patch.split(/\r?\n/)) {
    if (!line.startsWith("diff --git ")) continue;
    const match = line.match(/^diff --git (?:a\/)?(.+?) (?:b\/)?(.+)$/);
    if (!match) continue;
    for (const raw of [match[1], match[2]]) {
      const normalized = raw.replace(/^"|"$/g, "").replace(/\\/g, "/");
      if (normalized && normalized !== "/dev/null") files.add(normalized);
    }
  }
  return [...files].sort((a, b) => a.localeCompare(b, "en"));
}

function toolCandidateFiles(call: ToolCall): string[] {
  const args = argsObject(call.function.arguments) ?? {};
  if (call.function.name === "write" || call.function.name === "edit") {
    return typeof args.path === "string" ? [args.path] : [];
  }
  if (call.function.name === "apply_patch") {
    if (Array.isArray(args.expectedFiles)) {
      return args.expectedFiles.filter((item): item is string => typeof item === "string");
    }
    return typeof args.patch === "string" ? parsePatchChangedFiles(args.patch) : [];
  }
  return [];
}

function hashBuffer(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

async function snapshotFile(workspacePath: string, relativePath: string, captureContent: boolean): Promise<FileSnapshotState> {
  let absolutePath: string;
  try {
    absolutePath = resolveWorkspacePath(workspacePath, relativePath);
  } catch (error) {
    return { kind: "skipped", reason: error instanceof Error ? error.message : String(error) };
  }
  try {
    const info = await stat(absolutePath);
    if (!info.isFile()) return { kind: "skipped", reason: "not a file" };
    if (info.size > MAX_FILE_CHECKPOINT_BYTES) {
      return { kind: "skipped", size: info.size, reason: `file exceeds ${MAX_FILE_CHECKPOINT_BYTES} bytes` };
    }
    const buffer = await readFile(absolutePath);
    const state: FileSnapshotState = { kind: "file", sha256: hashBuffer(buffer), size: buffer.byteLength };
    if (captureContent) state.content = buffer.toString("utf8");
    return state;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOENT") return { kind: "missing" };
    return { kind: "skipped", reason: error instanceof Error ? error.message : String(error) };
  }
}

function resultChangedFiles(result: ToolResult): string[] {
  const metadata = toolAllMetadata(result);
  const changedFiles = metadata.changedFiles;
  if (Array.isArray(changedFiles)) {
    return changedFiles.filter((file): file is string => typeof file === "string" && file.length > 0);
  }
  return typeof metadata.relativePath === "string" ? [metadata.relativePath] : [];
}

function deletedWorkspaceFiles(before: WorkspaceManifest, after: WorkspaceManifest): string[] {
  return Object.keys(before).filter((filePath) => !after[filePath]).sort((a, b) => a.localeCompare(b, "en"));
}

function sameFileState(current: FileSnapshotState, expected: FileSnapshotState): boolean {
  if (expected.kind === "missing") return current.kind === "missing";
  if (expected.kind !== "file") return false;
  return current.kind === "file" && current.sha256 === expected.sha256;
}

async function gitOutput(options: {
  workspacePath: string;
  args: string[];
  stdin?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): Promise<{ ok: boolean; stdout: string; stderr: string; exitCode: number | null; durationMs: number }> {
  const git = gitCommandSpec();
  const result = await runCommand({
    command: git.command,
    args: [...git.argsPrefix, ...options.args],
    cwd: options.workspacePath,
    stdin: options.stdin,
    env: options.env ?? process.env,
    timeoutMs: options.timeoutMs ?? 30000
  });
  return {
    ok: !result.error && !result.timedOut && result.exitCode === 0,
    stdout: result.stdout.toString("utf8"),
    stderr: result.error ? result.error.message : result.stderr.toString("utf8"),
    exitCode: result.error ? 127 : result.timedOut ? 124 : result.exitCode,
    durationMs: result.durationMs
  };
}

async function isGitWorkspace(workspacePath: string): Promise<boolean> {
  const result = await gitOutput({ workspacePath, args: ["rev-parse", "--is-inside-work-tree"], timeoutMs: 5000 });
  return result.ok && result.stdout.trim() === "true";
}

async function hasHead(workspacePath: string): Promise<boolean> {
  return (await gitOutput({ workspacePath, args: ["rev-parse", "--verify", "HEAD"], timeoutMs: 5000 })).ok;
}

async function snapshotTree(workspacePath: string): Promise<GitSnapshot | null> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "sigma-git-index-"));
  const indexPath = path.join(tempDir, "index");
  const env = { ...process.env, GIT_INDEX_FILE: indexPath };
  try {
    const readTreeArgs = await hasHead(workspacePath) ? ["read-tree", "HEAD"] : ["read-tree", "--empty"];
    const readTree = await gitOutput({ workspacePath, args: readTreeArgs, env, timeoutMs: 10000 });
    if (!readTree.ok) return null;
    const add = await gitOutput({ workspacePath, args: ["add", "-A", "--", "."], env, timeoutMs: 30000 });
    if (!add.ok) return null;
    const tree = await gitOutput({ workspacePath, args: ["write-tree"], env, timeoutMs: 10000 });
    if (!tree.ok) return null;
    return { tree: tree.stdout.trim() || EMPTY_TREE };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function diffTrees(workspacePath: string, beforeTree: string, afterTree: string): Promise<string | null> {
  const diff = await gitOutput({
    workspacePath,
    args: ["diff", "--binary", "--no-ext-diff", "--find-renames", beforeTree, afterTree, "--"],
    timeoutMs: 30000
  });
  return diff.ok ? diff.stdout : null;
}

async function readCheckpointRecord(filePath: string): Promise<CheckpointRecord | null> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as CheckpointRecord;
  } catch {
    return null;
  }
}

export class GitCheckpointManager {
  readonly sessionId: string;
  readonly workspacePath: string;
  readonly checkpointsDir: string;
  private sequence = 0;
  private gitWorkspace: boolean | null = null;

  constructor(options: GitCheckpointManagerOptions) {
    this.sessionId = options.sessionId;
    this.workspacePath = path.resolve(options.workspacePath);
    this.checkpointsDir = path.resolve(options.checkpointsDir);
  }

  async beforeTool(toolCall: ToolCall): Promise<PendingCheckpoint | null> {
    if (!isCheckpointedTool(toolCall)) return null;
    if (this.gitWorkspace === null) {
      this.gitWorkspace = await isGitWorkspace(this.workspacePath);
    }
    if (!this.gitWorkspace) return null;
    const before = await snapshotTree(this.workspacePath);
    if (!before) return null;
    this.sequence += 1;
    return { sequence: this.sequence, toolCall, before };
  }

  async afterTool(pending: PendingCheckpoint | null, result: ToolResult): Promise<CheckpointRecord | null> {
    if (!pending) return null;
    const after = await snapshotTree(this.workspacePath);
    if (!after) return null;
    if (after.tree === pending.before.tree) return null;
    const patch = await diffTrees(this.workspacePath, pending.before.tree, after.tree);
    if (!patch || patch.trim().length === 0) return null;

    await mkdir(this.checkpointsDir, { recursive: true });
    const id = checkpointId(pending.sequence);
    const patchPath = path.join(this.checkpointsDir, `${id}.patch`);
    const metaPath = path.join(this.checkpointsDir, `${id}.json`);
    const record: CheckpointRecord = {
      id,
      sessionId: this.sessionId,
      sequence: pending.sequence,
      createdAt: nowIso(),
      workspacePath: this.workspacePath,
      mode: "git",
      toolName: pending.toolCall.function.name,
      toolCallId: pending.toolCall.id,
      ok: result.ok,
      changedFiles: parsePatchChangedFiles(patch),
      patchPath,
      beforeTree: pending.before.tree,
      afterTree: after.tree,
      resultSummary: truncateMiddle(toolModelContent(result).replace(/\s+/g, " ").trim(), 500).text
    };
    await writeFile(patchPath, patch, "utf8");
    await writeFile(metaPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    return record;
  }
}

export class FileBackedCheckpointManager {
  readonly sessionId: string;
  readonly workspacePath: string;
  readonly checkpointsDir: string;
  private sequence = 0;

  constructor(options: GitCheckpointManagerOptions) {
    this.sessionId = options.sessionId;
    this.workspacePath = path.resolve(options.workspacePath);
    this.checkpointsDir = path.resolve(options.checkpointsDir);
  }

  async beforeTool(toolCall: ToolCall): Promise<PendingFileCheckpoint | null> {
    if (!isCheckpointedTool(toolCall)) return null;
    const beforeManifest = await listWorkspaceManifest(this.workspacePath);
    const candidates = new Set(toolCandidateFiles(toolCall));
    const beforeFiles = new Map<string, FileSnapshotState>();
    for (const filePath of candidates) {
      beforeFiles.set(filePath.replace(/\\/g, "/"), await snapshotFile(this.workspacePath, filePath, true));
    }
    this.sequence += 1;
    return { sequence: this.sequence, toolCall, beforeManifest, beforeFiles };
  }

  async afterTool(pending: PendingFileCheckpoint | null, result: ToolResult): Promise<CheckpointRecord | null> {
    if (!pending) return null;
    const afterManifest = await listWorkspaceManifest(this.workspacePath);
    const changed = new Set([
      ...resultChangedFiles(result),
      ...changedWorkspaceFiles(pending.beforeManifest, afterManifest),
      ...deletedWorkspaceFiles(pending.beforeManifest, afterManifest),
      ...pending.beforeFiles.keys()
    ].map((file) => file.replace(/\\/g, "/")));
    if (changed.size === 0) return null;

    const entries: FileCheckpointEntry[] = [];
    const skippedFiles: string[] = [];
    for (const filePath of [...changed].sort((a, b) => a.localeCompare(b, "en"))) {
      const before = pending.beforeFiles.get(filePath) ??
        (pending.beforeManifest[filePath] ? { kind: "skipped", reason: "before content was not captured for this command" } : { kind: "missing" });
      const after = await snapshotFile(this.workspacePath, filePath, false);
      if (before.kind === "skipped" || after.kind === "skipped") skippedFiles.push(filePath);
      entries.push({ path: filePath, before, after });
    }
    await mkdir(this.checkpointsDir, { recursive: true });
    const id = checkpointId(pending.sequence);
    const snapshotPath = path.join(this.checkpointsDir, `${id}.files.json`);
    const metaPath = path.join(this.checkpointsDir, `${id}.json`);
    const snapshot: FileCheckpointSnapshot = { version: 1, entries };
    const record: CheckpointRecord = {
      id,
      sessionId: this.sessionId,
      sequence: pending.sequence,
      createdAt: nowIso(),
      workspacePath: this.workspacePath,
      mode: "file",
      toolName: pending.toolCall.function.name,
      toolCallId: pending.toolCall.id,
      ok: result.ok,
      changedFiles: entries.map((entry) => entry.path),
      fileSnapshotPath: snapshotPath,
      skippedFiles,
      resultSummary: truncateMiddle(toolModelContent(result).replace(/\s+/g, " ").trim(), 500).text
    };
    await writeFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    await writeFile(metaPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    return record;
  }
}

export class HybridCheckpointManager implements CheckpointManager {
  private readonly git: GitCheckpointManager;
  private readonly fileBacked: FileBackedCheckpointManager;
  private gitWorkspace: boolean | null = null;

  constructor(options: GitCheckpointManagerOptions) {
    this.git = new GitCheckpointManager(options);
    this.fileBacked = new FileBackedCheckpointManager(options);
  }

  async beforeTool(toolCall: ToolCall): Promise<PendingCheckpoint | PendingFileCheckpoint | null> {
    if (this.gitWorkspace === null) this.gitWorkspace = await isGitWorkspace(this.git.workspacePath);
    return this.gitWorkspace
      ? await this.git.beforeTool(toolCall)
      : await this.fileBacked.beforeTool(toolCall);
  }

  async afterTool(pending: PendingCheckpoint | PendingFileCheckpoint | null, result: ToolResult): Promise<CheckpointRecord | null> {
    if (!pending) return null;
    return "beforeManifest" in pending
      ? await this.fileBacked.afterTool(pending, result)
      : await this.git.afterTool(pending, result);
  }
}

export async function listCheckpoints(options: {
  sessionId: string;
  workspacePath?: string;
  sessionRootDir?: string;
  checkpointsDir?: string;
}): Promise<CheckpointRecord[]> {
  const checkpointsDir = options.checkpointsDir ??
    path.join(path.resolve(options.sessionRootDir ?? path.join(options.workspacePath ?? process.cwd(), ".agent", "sessions")), options.sessionId, "checkpoints");
  let entries: string[] = [];
  try {
    entries = await readdir(checkpointsDir);
  } catch {
    return [];
  }
  const records = await Promise.all(
    entries
      .filter((entry) => entry.endsWith(".json"))
      .filter((entry) => !entry.endsWith(".files.json"))
      .sort((a, b) => a.localeCompare(b, "en"))
      .map((entry) => readCheckpointRecord(path.join(checkpointsDir, entry)))
  );
  return records.filter((record): record is CheckpointRecord => Boolean(record));
}

export async function loadCheckpoint(options: {
  sessionId: string;
  checkpointId: string;
  workspacePath?: string;
  sessionRootDir?: string;
  checkpointsDir?: string;
}): Promise<CheckpointRecord | null> {
  const id = options.checkpointId.padStart(4, "0");
  const checkpointsDir = options.checkpointsDir ??
    path.join(path.resolve(options.sessionRootDir ?? path.join(options.workspacePath ?? process.cwd(), ".agent", "sessions")), options.sessionId, "checkpoints");
  return await readCheckpointRecord(path.join(checkpointsDir, `${id}.json`));
}

async function readFileCheckpointSnapshot(record: CheckpointRecord): Promise<FileCheckpointSnapshot | null> {
  if (!record.fileSnapshotPath) return null;
  try {
    return JSON.parse(await readFile(record.fileSnapshotPath, "utf8")) as FileCheckpointSnapshot;
  } catch {
    return null;
  }
}

async function restoreFileEntry(workspacePath: string, entry: FileCheckpointEntry): Promise<void> {
  const absolutePath = resolveWorkspacePath(workspacePath, entry.path);
  if (entry.before.kind === "missing") {
    await unlink(absolutePath).catch((error: unknown) => {
      if ((error as { code?: string }).code !== "ENOENT") throw error;
    });
    return;
  }
  if (entry.before.kind !== "file" || entry.before.content === undefined) {
    throw new Error(`${entry.path}: before content was not captured`);
  }
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, entry.before.content, "utf8");
}

async function restoreFileCheckpoint(
  record: CheckpointRecord,
  workspacePath: string,
  force: boolean
): Promise<CheckpointRestoreResult> {
  const startedAt = Date.now();
  const snapshot = await readFileCheckpointSnapshot(record);
  if (!snapshot) {
    return {
      ok: false,
      checkpointId: record.id,
      command: "file checkpoint restore",
      exitCode: 1,
      stdout: "",
      stderr: `checkpoint file snapshot is unreadable: ${record.fileSnapshotPath ?? "(missing path)"}`,
      durationMs: Date.now() - startedAt
    };
  }
  const mismatches: string[] = [];
  const skipped: string[] = [];
  for (const entry of snapshot.entries) {
    if (entry.before.kind === "skipped" || entry.after.kind === "skipped") {
      skipped.push(entry.path);
      continue;
    }
    if (!force) {
      const current = await snapshotFile(workspacePath, entry.path, false);
      if (!sameFileState(current, entry.after)) mismatches.push(entry.path);
    }
  }
  if (skipped.length > 0) {
    return {
      ok: false,
      checkpointId: record.id,
      command: "file checkpoint restore",
      exitCode: 1,
      stdout: "",
      stderr: `checkpoint has skipped files that cannot be restored safely: ${skipped.join(", ")}`,
      durationMs: Date.now() - startedAt
    };
  }
  if (mismatches.length > 0) {
    return {
      ok: false,
      checkpointId: record.id,
      command: "file checkpoint restore --check",
      exitCode: 1,
      stdout: "",
      stderr: `current files differ from checkpoint after-state; refusing restore without --force: ${mismatches.join(", ")}`,
      durationMs: Date.now() - startedAt
    };
  }
  try {
    for (const entry of snapshot.entries) {
      await restoreFileEntry(workspacePath, entry);
    }
    return {
      ok: true,
      checkpointId: record.id,
      command: force ? "file checkpoint restore --force" : "file checkpoint restore",
      exitCode: 0,
      stdout: `restored ${snapshot.entries.length} file(s)`,
      stderr: "",
      durationMs: Date.now() - startedAt
    };
  } catch (error) {
    return {
      ok: false,
      checkpointId: record.id,
      command: "file checkpoint restore",
      exitCode: 1,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - startedAt
    };
  }
}

export async function restoreCheckpoint(options: {
  sessionId: string;
  checkpointId: string;
  workspacePath?: string;
  sessionRootDir?: string;
  checkpointsDir?: string;
  force?: boolean;
}): Promise<CheckpointRestoreResult> {
  const record = await loadCheckpoint(options);
  if (!record) {
    return {
      ok: false,
      checkpointId: options.checkpointId,
      command: "git apply -R --check",
      exitCode: 1,
      stdout: "",
      stderr: "checkpoint not found",
      durationMs: 0
    };
  }
  const workspacePath = path.resolve(options.workspacePath ?? record.workspacePath);
  if (record.mode === "file" || record.fileSnapshotPath) {
    return await restoreFileCheckpoint(record, workspacePath, options.force === true);
  }
  if (!record.patchPath) {
    return {
      ok: false,
      checkpointId: record.id,
      command: "git apply -R --check --whitespace=nowarn",
      exitCode: 1,
      stdout: "",
      stderr: "checkpoint patch path is missing",
      durationMs: 0
    };
  }
  let patch: string;
  try {
    patch = await readFile(record.patchPath, "utf8");
  } catch (error) {
    return {
      ok: false,
      checkpointId: record.id,
      command: "git apply -R --check --whitespace=nowarn",
      exitCode: 1,
      stdout: "",
      stderr: `checkpoint patch is unreadable: ${record.patchPath}: ${error instanceof Error ? error.message : String(error)}`,
      durationMs: 0
    };
  }
  const check = await gitOutput({
    workspacePath,
    args: ["apply", "-R", "--check", "--whitespace=nowarn"],
    stdin: patch,
    timeoutMs: 30000
  });
  if (!check.ok) {
    return {
      ok: false,
      checkpointId: record.id,
      command: "git apply -R --check --whitespace=nowarn",
      exitCode: check.exitCode,
      stdout: trimOutput(check.stdout),
      stderr: trimOutput(check.stderr),
      durationMs: check.durationMs
    };
  }
  const applied = await gitOutput({
    workspacePath,
    args: ["apply", "-R", "--whitespace=nowarn"],
    stdin: patch,
    timeoutMs: 30000
  });
  return {
    ok: applied.ok,
    checkpointId: record.id,
    command: "git apply -R --whitespace=nowarn",
    exitCode: applied.exitCode,
    stdout: trimOutput(applied.stdout),
    stderr: trimOutput(applied.stderr),
    durationMs: applied.durationMs
  };
}
