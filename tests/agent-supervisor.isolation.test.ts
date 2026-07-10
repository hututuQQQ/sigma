import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgentSupervisor,
  WorkspaceIsolationManager,
  type ChildAgentContext,
  type ChildAgentResult,
  type ChildJob
} from "../packages/agent-supervisor/src/index.js";

const fixtures: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true }).trim();
}

async function fixture(name: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), `sigma-${name}-`));
  fixtures.push(root);
  return root;
}

async function gitRepository(root: string): Promise<string> {
  const repository = path.join(root, "repository");
  await mkdir(repository, { recursive: true });
  git(repository, "init");
  git(repository, "config", "user.email", "sigma-tests@example.invalid");
  git(repository, "config", "user.name", "Sigma Tests");
  await writeFile(path.join(repository, "tracked.txt"), "base\n", "utf8");
  git(repository, "add", "tracked.txt");
  git(repository, "commit", "-m", "initial");
  return repository;
}

async function writerLockPath(lockRoot: string, workspace: string): Promise<string> {
  const canonical = await realpath(workspace);
  const name = `${createHash("sha256").update(canonical).digest("hex")}.lock`;
  return path.join(lockRoot, "writer-locks", name);
}

function result(context: ChildAgentContext): ChildAgentResult {
  return {
    childId: context.childId,
    outcome: { kind: "completed", message: "done", evidence: [] },
    report: null
  };
}

function retainedPath(job: ChildJob): string {
  const candidate = job.isolation?.worktreePath;
  if (!candidate) throw new Error("Expected the child job to expose its retained worktree path.");
  return candidate;
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function until(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for supervisor state.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

afterEach(async () => {
  for (const root of fixtures.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("AgentSupervisor writer isolation", () => {
  it("runs clean Git writers concurrently in independent worktrees and removes unchanged worktrees", async () => {
    const root = await fixture("clean-worktrees");
    const repository = await gitRepository(root);
    await mkdir(path.join(repository, ".agent"));
    await writeFile(path.join(repository, ".agent", "runtime-state"), "internal", "utf8");
    const release = deferred();
    const contexts: ChildAgentContext[] = [];
    const supervisor = new AgentSupervisor(async (context) => {
      contexts.push(context);
      await release.promise;
      return result(context);
    }, 4, new WorkspaceIsolationManager(path.join(root, "worktrees")));

    const first = supervisor.spawn({ parentId: "parent", instruction: "first", workspacePath: repository, intent: "write" });
    const second = supervisor.spawn({ parentId: "parent", instruction: "second", workspacePath: repository, intent: "write" });
    await until(() => contexts.length === 2);

    expect(contexts[0].isolation.kind).toBe("git_worktree");
    expect(contexts[1].isolation.kind).toBe("git_worktree");
    expect(contexts[0].workspacePath).not.toBe(repository);
    expect(contexts[0].workspacePath).not.toBe(contexts[1].workspacePath);
    await expect(readFile(path.join(contexts[0].workspacePath, "tracked.txt"), "utf8")).resolves.toMatch(/^base\r?\n$/);
    await expect(readFile(path.join(contexts[1].workspacePath, "tracked.txt"), "utf8")).resolves.toMatch(/^base\r?\n$/);

    const worktreePaths = contexts.map((context) => context.isolation.worktreePath!);
    release.resolve();
    const jobs = await Promise.all([supervisor.join(first.id), supervisor.join(second.id)]);
    expect(jobs.map((job) => job.isolation?.cleanup)).toEqual(["removed", "removed"]);
    expect(worktreePaths.every((candidate) => !existsSync(candidate))).toBe(true);
  });

  it("integrates one retained writer safely and refuses a conflicting second writer", async () => {
    const root = await fixture("retained-worktrees");
    const repository = await gitRepository(root);
    const supervisor = new AgentSupervisor(async (context) => {
      await writeFile(path.join(context.workspacePath, "tracked.txt"), `${context.instruction}\n`, "utf8");
      if (context.instruction === "committed") {
        git(context.workspacePath, "add", "tracked.txt");
        git(context.workspacePath, "commit", "-m", "child change");
      }
      return result(context);
    }, 2, new WorkspaceIsolationManager(path.join(root, "worktrees")));

    const uncommitted = supervisor.spawn({ parentId: "parent", instruction: "uncommitted", workspacePath: repository, intent: "write" });
    const committed = supervisor.spawn({ parentId: "parent", instruction: "committed", workspacePath: repository, intent: "write" });
    const jobs = await Promise.all([supervisor.join(uncommitted.id), supervisor.join(committed.id)]);

    expect(jobs.map((job) => job.isolation?.cleanup)).toEqual(["retained", "retained"]);
    await expect(readFile(path.join(retainedPath(jobs[0]), "tracked.txt"), "utf8")).resolves.toBe("uncommitted\n");
    await expect(readFile(path.join(retainedPath(jobs[1]), "tracked.txt"), "utf8")).resolves.toBe("committed\n");
    const integrated = await supervisor.integrate(uncommitted.id);
    expect(integrated.isolation?.cleanup).toBe("integrated");
    await expect(readFile(path.join(repository, "tracked.txt"), "utf8")).resolves.toBe("uncommitted\n");
    await expect(supervisor.integrate(committed.id)).rejects.toThrow("Source workspace changed");
    expect(existsSync(retainedPath(jobs[0]))).toBe(false);
    git(repository, "worktree", "remove", "--force", retainedPath(jobs[1]));
  });

  it.each(["dirty-git", "non-git"] as const)("serializes %s writers without blocking analyze children", async (kind) => {
    const root = await fixture(kind);
    const workspace = kind === "dirty-git" ? await gitRepository(root) : path.join(root, "workspace");
    if (kind === "dirty-git") await writeFile(path.join(workspace, "tracked.txt"), "dirty\n", "utf8");
    else await mkdir(workspace, { recursive: true });

    const writerGates: Array<ReturnType<typeof deferred>> = [];
    const writerContexts: ChildAgentContext[] = [];
    const analyzeContexts: ChildAgentContext[] = [];
    let activeWriters = 0;
    let maximumWriters = 0;
    const supervisor = new AgentSupervisor(async (context) => {
      if (context.intent === "write") {
        activeWriters += 1;
        maximumWriters = Math.max(maximumWriters, activeWriters);
        writerContexts.push(context);
        const gate = deferred();
        writerGates.push(gate);
        await gate.promise;
        activeWriters -= 1;
      } else {
        analyzeContexts.push(context);
      }
      return result(context);
    }, 4, new WorkspaceIsolationManager(path.join(root, "worktrees")));

    const first = supervisor.spawn({ parentId: "parent", instruction: "writer one", workspacePath: workspace, intent: "write" });
    await until(() => writerContexts.length === 1);
    const second = supervisor.spawn({ parentId: "parent", instruction: "writer two", workspacePath: workspace, metadata: { mode: "change" } });
    const analyzeOne = supervisor.spawn({ parentId: "parent", instruction: "analyze one", workspacePath: workspace, intent: "analyze" });
    const analyzeTwo = supervisor.spawn({ parentId: "parent", instruction: "analyze two", workspacePath: workspace, metadata: { mode: "analyze" } });

    await until(() => analyzeContexts.length === 2);
    expect(writerContexts).toHaveLength(1);
    await Promise.all([supervisor.join(analyzeOne.id), supervisor.join(analyzeTwo.id)]);
    writerGates[0].resolve();
    await supervisor.join(first.id);
    await until(() => writerContexts.length === 2);
    writerGates[1].resolve();
    await supervisor.join(second.id);

    expect(maximumWriters).toBe(1);
    expect(writerContexts.every((context) => context.workspacePath === context.sourceWorkspacePath)).toBe(true);
    expect(writerContexts.every((context) => context.isolation.kind === "exclusive_workspace")).toBe(true);
    expect(analyzeContexts.every((context) => context.isolation.kind === "shared_read")).toBe(true);
  });

  it("serializes shared-workspace writers across supervisor instances", async () => {
    const root = await fixture("cross-process-writer-lock");
    const workspace = path.join(root, "workspace");
    const lockRoot = path.join(root, "isolation");
    await mkdir(workspace);
    const firstManager = new WorkspaceIsolationManager(lockRoot);
    const secondManager = new WorkspaceIsolationManager(lockRoot);
    const first = await firstManager.allocate({ childId: "first", workspacePath: workspace, intent: "write" });
    let secondAcquired = false;
    const secondPromise = secondManager.allocate({ childId: "second", workspacePath: workspace, intent: "write" }).then((value) => {
      secondAcquired = true;
      return value;
    });
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(secondAcquired).toBe(false);
    await first.release();
    const second = await secondPromise;
    expect(second.isolation.kind).toBe("exclusive_workspace");
    await second.release();
  });

  it.each([
    ["empty", ""],
    ["truncated", '{"pid":'],
    ["malformed", '{"pid":"not-a-number","instanceId":false}']
  ])("recovers an old %s cross-process writer owner", async (_kind, contents) => {
    const root = await fixture("malformed-writer-lock");
    const workspace = path.join(root, "workspace");
    const lockRoot = path.join(root, "isolation");
    await mkdir(workspace);
    const lockFile = await writerLockPath(lockRoot, workspace);
    await mkdir(path.dirname(lockFile), { recursive: true });
    await writeFile(lockFile, contents, "utf8");
    const old = new Date(Date.now() - 60_000);
    await utimes(lockFile, old, old);
    const manager = new WorkspaceIsolationManager(lockRoot, {
      writerLeaseTimeoutMs: 250,
      malformedLockStaleMs: 10,
      retryIntervalMs: 5
    });

    const allocation = await manager.allocate({ childId: "recovery", workspacePath: workspace, intent: "write" });
    const owner = JSON.parse(await readFile(lockFile, "utf8")) as { pid: number; instanceId: string };
    expect(owner.pid).toBe(process.pid);
    expect(owner.instanceId).not.toHaveLength(0);
    await allocation.release();
    expect(existsSync(lockFile)).toBe(false);
  });

  it("times out with an explicit diagnostic for a fresh malformed writer owner", async () => {
    const root = await fixture("writer-lock-timeout");
    const workspace = path.join(root, "workspace");
    const lockRoot = path.join(root, "isolation");
    await mkdir(workspace);
    const lockFile = await writerLockPath(lockRoot, workspace);
    await mkdir(path.dirname(lockFile), { recursive: true });
    await writeFile(lockFile, "", "utf8");
    const manager = new WorkspaceIsolationManager(lockRoot, {
      writerLeaseTimeoutMs: 40,
      malformedLockStaleMs: 60_000,
      retryIntervalMs: 5
    });

    await expect(manager.allocate({ childId: "blocked", workspacePath: workspace, intent: "write" }))
      .rejects.toThrow(/Timed out waiting for cross-process writer lease.*empty malformed owner/u);
  });

  it("settles failed cleanup and schedules the next child", async () => {
    const root = await fixture("cleanup-failure-liveness");
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);
    const isolation = {
      kind: "shared_read" as const,
      intent: "analyze" as const,
      sourceWorkspacePath: workspace,
      executionWorkspacePath: workspace,
      cleanup: "not_required" as const
    };
    const manager = {
      allocate: async () => ({
        workspacePath: workspace,
        isolation,
        release: async () => { throw new Error("injected allocation cleanup failure"); }
      })
    } as unknown as WorkspaceIsolationManager;
    const started: string[] = [];
    const supervisor = new AgentSupervisor(async (context) => {
      started.push(context.childId);
      return result(context);
    }, 1, manager);

    const first = supervisor.spawn({ parentId: "parent", instruction: "first", workspacePath: workspace });
    const second = supervisor.spawn({ parentId: "parent", instruction: "second", workspacePath: workspace });
    const jobs = await Promise.all([supervisor.join(first.id), supervisor.join(second.id)]);
    expect(started).toHaveLength(2);
    expect(jobs.map((job) => job.status)).toEqual(["failed", "failed"]);
    expect(jobs.every((job) => job.error?.includes("injected allocation cleanup failure"))).toBe(true);
  });

  it("cancels non-detached children and rejects parent join promptly when its signal aborts", async () => {
    const root = await fixture("parent-cancel");
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);
    const started: string[] = [];
    const supervisor = new AgentSupervisor(async (context) => {
      started.push(context.childId);
      await new Promise<void>((_resolve, reject) => {
        const onAbort = (): void => reject(context.signal.reason ?? new Error("cancelled"));
        if (context.signal.aborted) onAbort();
        else context.signal.addEventListener("abort", onAbort, { once: true });
      });
      return result(context);
    }, 1, new WorkspaceIsolationManager(path.join(root, "worktrees")));
    const running = supervisor.spawn({ parentId: "parent", instruction: "running", workspacePath: workspace, intent: "analyze" });
    const queued = supervisor.spawn({ parentId: "parent", instruction: "queued", workspacePath: workspace, intent: "analyze" });
    await until(() => started.length === 1);

    const controller = new AbortController();
    const joined = supervisor.joinParent("parent", controller.signal);
    const startedAt = Date.now();
    controller.abort(new Error("parent deadline"));
    await expect(joined).rejects.toThrow("parent deadline");
    expect(Date.now() - startedAt).toBeLessThan(500);
    await expect(supervisor.join(running.id)).resolves.toMatchObject({ status: "cancelled" });
    await expect(supervisor.join(queued.id)).resolves.toMatchObject({ status: "cancelled" });
  });
});
