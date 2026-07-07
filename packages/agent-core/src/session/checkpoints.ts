import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ToolCall } from "agent-ai";
import { truncateMiddle } from "../compaction.js";
import { runCommand } from "../command-runner.js";
import type { ToolResult } from "../types.js";
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

export interface GitCheckpointManagerOptions {
  sessionId: string;
  workspacePath: string;
  checkpointsDir: string;
}

const CHECKPOINTED_TOOLS = new Set(["write", "edit", "apply_patch", "bash", "shell_session", "service"]);
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

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
      toolName: pending.toolCall.function.name,
      toolCallId: pending.toolCall.id,
      ok: result.ok,
      changedFiles: parsePatchChangedFiles(patch),
      patchPath,
      beforeTree: pending.before.tree,
      afterTree: after.tree,
      resultSummary: truncateMiddle(result.content.replace(/\s+/g, " ").trim(), 500).text
    };
    await writeFile(patchPath, patch, "utf8");
    await writeFile(metaPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    return record;
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

export async function restoreCheckpoint(options: {
  sessionId: string;
  checkpointId: string;
  workspacePath?: string;
  sessionRootDir?: string;
  checkpointsDir?: string;
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
  const patch = await readFile(record.patchPath, "utf8");
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
