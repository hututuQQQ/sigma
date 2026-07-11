import { createHash, randomUUID } from "node:crypto";
import { access, cp, mkdir, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  acquireProcessOwnerLease,
  resolveWorkspacePath,
  selfContainedGitRoot,
  type ProcessExecutionPort
} from "agent-platform";
import { runGit } from "./git-execution.js";
import { nulPaths, outsideWriteScope } from "./integration-paths.js";

export type ChildRunIntent = "analyze" | "write";
export type WorkspaceIsolationKind = "shared_read" | "git_worktree" | "exclusive_workspace";
export type WorkspaceCleanupState = "not_required" | "pending" | "removed" | "retained" | "integrated";

export interface ChildWorkspaceIsolation {
  kind: WorkspaceIsolationKind;
  intent: ChildRunIntent;
  sourceWorkspacePath: string;
  executionWorkspacePath: string;
  cleanup: WorkspaceCleanupState;
  repositoryRoot?: string;
  worktreePath?: string;
  baseHead?: string;
  reason?: string;
}

export interface WorkspaceAllocation {
  readonly workspacePath: string;
  readonly isolation: ChildWorkspaceIsolation;
  release(): Promise<ChildWorkspaceIsolation>;
}

interface MutexWaiter {
  active: boolean;
  resolve(release: () => void): void;
  reject(error: unknown): void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

class AsyncMutex {
  private locked = false;
  private readonly waiters: MutexWaiter[] = [];

  async acquire(signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted();
    if (!this.locked) {
      this.locked = true;
      return this.releaseHandle();
    }
    return await new Promise<() => void>((resolve, reject) => {
      const waiter: MutexWaiter = { active: true, resolve, reject, signal };
      waiter.onAbort = () => {
        if (!waiter.active) return;
        waiter.active = false;
        reject(signal?.reason ?? new Error("Workspace allocation was cancelled."));
      };
      signal?.addEventListener("abort", waiter.onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  private releaseHandle(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      while (this.waiters.length > 0) {
        const waiter = this.waiters.shift()!;
        if (!waiter.active) continue;
        waiter.active = false;
        if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
        waiter.resolve(this.releaseHandle());
        return;
      }
      this.locked = false;
    };
  }
}

async function canonical(candidate: string): Promise<string> {
  const resolved = path.resolve(candidate);
  try {
    return await realpath(resolved);
  } catch {
    return resolved;
  }
}

function mutex(map: Map<string, AsyncMutex>, key: string): AsyncMutex {
  const existing = map.get(key);
  if (existing) return existing;
  const created = new AsyncMutex();
  map.set(key, created);
  return created;
}

function staticAllocation(isolation: ChildWorkspaceIsolation, unlock?: () => void | Promise<void>): WorkspaceAllocation {
  let releasePromise: Promise<ChildWorkspaceIsolation> | undefined;
  return {
    workspacePath: isolation.executionWorkspacePath,
    isolation,
    release: () => releasePromise ??= (async () => {
      try {
        await unlock?.();
        return isolation;
      } catch (error) {
        releasePromise = undefined;
        throw error;
      }
    })()
  };
}

function hasUserChanges(status: string): boolean {
  return status.split(/\r?\n/u).filter(Boolean).some((line) => {
    const file = line.slice(3).replace(/^"|"$/gu, "").replaceAll("\\", "/");
    return file !== ".agent" && !file.startsWith(".agent/");
  });
}

export interface WorkspaceIsolationManagerOptions {
  writerLeaseTimeoutMs?: number;
  malformedLockStaleMs?: number;
  retryIntervalMs?: number;
  execution?: ProcessExecutionPort;
}

export class WorkspaceIsolationManager {
  private readonly exclusive = new Map<string, AsyncMutex>();
  private readonly gitMutation = new Map<string, AsyncMutex>();

  constructor(
    private readonly worktreeRoot = path.join(os.tmpdir(), "sigma-agent-worktrees"),
    private readonly options: WorkspaceIsolationManagerOptions = {}
  ) {}

  private async acquireProcessWriterLease(workspace: string, signal?: AbortSignal): Promise<() => Promise<void>> {
    const directory = path.join(this.worktreeRoot, "writer-locks");
    const lockPath = path.join(directory, `${createHash("sha256").update(workspace).digest("hex")}.lock`);
    const lease = await acquireProcessOwnerLease(lockPath, {
      pid: process.pid,
      instanceId: randomUUID(),
      startedAt: new Date().toISOString()
    }, {
      label: "cross-process writer lease",
      timeoutMs: this.options.writerLeaseTimeoutMs,
      malformedStaleMs: this.options.malformedLockStaleMs,
      retryIntervalMs: this.options.retryIntervalMs,
      activeOwner: "wait",
      signal
    });
    return lease.release;
  }

  private async exclusiveAllocation(
    isolation: ChildWorkspaceIsolation,
    key: string,
    signal?: AbortSignal
  ): Promise<WorkspaceAllocation> {
    const unlockLocal = await mutex(this.exclusive, key).acquire(signal);
    try {
      const unlockProcess = await this.acquireProcessWriterLease(key, signal);
      return staticAllocation(isolation, async () => {
        try {
          await unlockProcess();
        } finally {
          unlockLocal();
        }
      });
    } catch (error) {
      unlockLocal();
      throw error;
    }
  }

  async allocate(input: {
    childId: string;
    workspacePath: string;
    intent: ChildRunIntent;
    signal?: AbortSignal;
  }): Promise<WorkspaceAllocation> {
    const source = await canonical(input.workspacePath);
    if (input.intent === "analyze") {
      return staticAllocation({
        kind: "shared_read",
        intent: input.intent,
        sourceWorkspacePath: source,
        executionWorkspacePath: source,
        cleanup: "not_required"
      });
    }

    const repository = await this.inspectRepository(source, input.signal);
    if (!repository || !repository.clean) {
      const key = repository?.root ?? source;
      return await this.exclusiveAllocation({
        kind: "exclusive_workspace",
        intent: input.intent,
        sourceWorkspacePath: source,
        executionWorkspacePath: source,
        cleanup: "not_required",
        repositoryRoot: repository?.root,
        reason: repository ? "Git workspace has uncommitted or untracked changes." : "Workspace is not a Git worktree."
      }, key, input.signal);
    }

    try {
      return await this.createWorktree(input.childId, source, repository.root, repository.head, input.signal);
    } catch (error) {
      input.signal?.throwIfAborted();
      return await this.exclusiveAllocation({
        kind: "exclusive_workspace",
        intent: input.intent,
        sourceWorkspacePath: source,
        executionWorkspacePath: source,
        cleanup: "not_required",
        repositoryRoot: repository.root,
        reason: `Independent worktree creation failed; using a single-writer lease: ${error instanceof Error ? error.message : String(error)}`
      }, repository.root, input.signal);
    }
  }

  private async inspectRepository(source: string, signal?: AbortSignal): Promise<{ root: string; head: string; clean: boolean } | undefined> {
    try {
      const root = this.options.execution
        ? await selfContainedGitRoot(source, signal, this.options.execution) : undefined;
      if (!root) return undefined;
      const [head, status] = await Promise.all([
        runGit(this.options.execution, ["-C", root, "rev-parse", "HEAD"], root, signal),
        runGit(this.options.execution, ["-C", root, "status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none"], root, signal)
      ]);
      return { root, head, clean: !hasUserChanges(status) };
    } catch {
      signal?.throwIfAborted();
      return undefined;
    }
  }

  private async createWorktree(
    childId: string,
    source: string,
    repositoryRoot: string,
    baseHead: string,
    signal?: AbortSignal
  ): Promise<WorkspaceAllocation> {
    const repositoryKey = createHash("sha256").update(repositoryRoot).digest("hex").slice(0, 16);
    const worktreePath = path.join(this.worktreeRoot, repositoryKey, childId);
    await mkdir(path.dirname(worktreePath), { recursive: true });
    const unlockGit = await mutex(this.gitMutation, repositoryRoot).acquire(signal);
    try {
      await runGit(
        this.options.execution,
        ["-C", repositoryRoot, "worktree", "add", "--detach", worktreePath, baseHead],
        repositoryRoot,
        signal,
        [repositoryRoot, path.dirname(worktreePath)]
      );
    } finally {
      unlockGit();
    }
    const relative = path.relative(repositoryRoot, source);
    const executionWorkspacePath = relative ? path.join(worktreePath, relative) : worktreePath;
    const isolation: ChildWorkspaceIsolation = {
      kind: "git_worktree",
      intent: "write",
      sourceWorkspacePath: source,
      executionWorkspacePath,
      cleanup: "pending",
      repositoryRoot,
      worktreePath,
      baseHead
    };
    let releasePromise: Promise<ChildWorkspaceIsolation> | undefined;
    return {
      workspacePath: executionWorkspacePath,
      isolation,
      release: () => releasePromise ??= (async () => {
        const final = await this.cleanupWorktree(isolation, baseHead);
        Object.assign(isolation, final);
        return isolation;
      })().catch((error: unknown) => {
        releasePromise = undefined;
        throw error;
      })
    };
  }

  private async cleanupWorktree(isolation: ChildWorkspaceIsolation, baseHead: string): Promise<ChildWorkspaceIsolation> {
    const worktreePath = isolation.worktreePath!;
    try {
      await access(worktreePath);
    } catch {
      return { ...isolation, cleanup: "removed", reason: "Worktree no longer exists." };
    }
    try {
      const [head, status] = await Promise.all([
        runGit(this.options.execution, ["-C", worktreePath, "rev-parse", "HEAD"], worktreePath),
        runGit(this.options.execution, ["-C", worktreePath, "status", "--porcelain=v1", "--untracked-files=all", "--ignored=matching"], worktreePath)
      ]);
      if (status.length > 0) {
        return { ...isolation, cleanup: "retained", reason: "Worktree contains modified, untracked, or ignored files." };
      }
      if (head !== baseHead) {
        return { ...isolation, cleanup: "retained", reason: "Worktree HEAD changed; commits are retained for integration." };
      }
      const unlockGit = await mutex(this.gitMutation, isolation.repositoryRoot!).acquire();
      try {
        await runGit(this.options.execution, ["-C", isolation.repositoryRoot!, "worktree", "remove", worktreePath], isolation.repositoryRoot!, undefined, [isolation.repositoryRoot!]);
        await runGit(this.options.execution, ["-C", isolation.repositoryRoot!, "worktree", "prune"], isolation.repositoryRoot!, undefined, [isolation.repositoryRoot!]);
      } finally {
        unlockGit();
      }
      return { ...isolation, cleanup: "removed", reason: "Clean, unchanged worktree removed safely." };
    } catch (error) {
      return {
        ...isolation,
        cleanup: "retained",
        reason: `Safe cleanup could not prove the worktree disposable: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }

  async integrateWorktree(
    isolation: ChildWorkspaceIsolation,
    writeScope: string[],
    signal?: AbortSignal
  ): Promise<ChildWorkspaceIsolation> {
    if (isolation.kind !== "git_worktree" || isolation.cleanup !== "retained" || !isolation.worktreePath
      || !isolation.repositoryRoot || !isolation.baseHead) throw new Error("Child has no retained Git worktree to integrate.");
    const unlockWorkspace = await mutex(this.exclusive, isolation.repositoryRoot).acquire(signal);
    let unlockProcess: (() => Promise<void>) | undefined;
    let unlockGit: (() => void) | undefined;
    try {
      unlockProcess = await this.acquireProcessWriterLease(isolation.repositoryRoot, signal);
      unlockGit = await mutex(this.gitMutation, isolation.repositoryRoot).acquire(signal);
      const [sourceHead, sourceStatus] = await Promise.all([
        runGit(this.options.execution, ["-C", isolation.repositoryRoot, "rev-parse", "HEAD"], isolation.repositoryRoot, signal),
        runGit(this.options.execution, ["-C", isolation.repositoryRoot, "status", "--porcelain=v1", "--untracked-files=all"], isolation.repositoryRoot, signal)
      ]);
      if (sourceHead !== isolation.baseHead || hasUserChanges(sourceStatus)) {
        throw new Error("Source workspace changed after child isolation; refusing unsafe integration.");
      }
      const [copyOutput, deleteOutput, untrackedOutput, ignoredOutput] = await Promise.all([
        runGit(this.options.execution, ["-C", isolation.worktreePath, "diff", "--name-only", "-z", "--no-renames", "--diff-filter=ACMRTUXB", isolation.baseHead], isolation.worktreePath, signal),
        runGit(this.options.execution, ["-C", isolation.worktreePath, "diff", "--name-only", "-z", "--no-renames", "--diff-filter=D", isolation.baseHead], isolation.worktreePath, signal),
        runGit(this.options.execution, ["-C", isolation.worktreePath, "ls-files", "--others", "--exclude-standard", "-z"], isolation.worktreePath, signal),
        runGit(this.options.execution, ["-C", isolation.worktreePath, "ls-files", "--others", "--ignored", "--exclude-standard", "-z"], isolation.worktreePath, signal)
      ]);
      const ignored = nulPaths(ignoredOutput);
      if (ignored.length > 0) throw new Error(`Child produced ignored files that require manual review: ${ignored.join(", ")}`);
      const copies = [...new Set([...nulPaths(copyOutput), ...nulPaths(untrackedOutput)])];
      const deletions = [...new Set(nulPaths(deleteOutput))];
      const outside = outsideWriteScope(isolation, writeScope, [...copies, ...deletions]);
      if (outside.length > 0) throw new Error(`Child changed files outside write scope: ${outside.join(", ")}`);
      for (const file of copies) {
        const source = await resolveWorkspacePath(isolation.worktreePath, file);
        const target = await resolveWorkspacePath(isolation.repositoryRoot, file);
        await mkdir(path.dirname(target), { recursive: true });
        await cp(source, target, { recursive: true, force: true });
      }
      for (const file of deletions) {
        await rm(await resolveWorkspacePath(isolation.repositoryRoot, file), { force: true, recursive: true });
      }
      await runGit(this.options.execution, ["-C", isolation.repositoryRoot, "worktree", "remove", "--force", isolation.worktreePath], isolation.repositoryRoot, signal, [isolation.repositoryRoot]);
      await runGit(this.options.execution, ["-C", isolation.repositoryRoot, "worktree", "prune"], isolation.repositoryRoot, signal, [isolation.repositoryRoot]);
      return { ...isolation, cleanup: "integrated", reason: `Integrated ${copies.length} changed and ${deletions.length} deleted files.` };
    } finally {
      unlockGit?.();
      try {
        await unlockProcess?.();
      } finally {
        unlockWorkspace();
      }
    }
  }
}
