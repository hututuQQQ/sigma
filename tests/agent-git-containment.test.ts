import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ToolExecutionContext, ToolRequest } from "../packages/agent-protocol/src/index.js";
import { afterEach, describe, expect, it } from "vitest";
import { RepositoryContextProvider } from "../packages/agent-context/src/index.js";
import { gitPorcelain, selfContainedGitRoot } from "../packages/agent-platform/src/index.js";
import { WorkspaceIsolationManager } from "../packages/agent-supervisor/src/index.js";
import { EffectToolRegistry, registerBuiltinTools } from "../packages/agent-tools/src/index.js";

const fixtures: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true }).trim();
}

async function fixture(name: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), `sigma-git-containment-${name}-`));
  fixtures.push(root);
  return root;
}

function initializeRepository(root: string): void {
  git(root, "init", "-q");
  git(root, "config", "user.email", "sigma-tests@example.invalid");
  git(root, "config", "user.name", "Sigma Tests");
  git(root, "config", "core.autocrlf", "false");
}

function request(callId: string, name: string): ToolRequest {
  return { callId, name, arguments: {} };
}

function toolContext(
  workspacePath: string,
  artifacts = new Map<string, string>()
): ToolExecutionContext {
  return {
    sessionId: "session",
    runId: "run",
    workspacePath,
    runMode: "change",
    signal: new AbortController().signal,
    heartbeat: () => undefined,
    progress: async () => undefined,
    createArtifact: async ({ name, content }) => {
      artifacts.set(name, content);
      return `artifact:${name}`;
    }
  };
}

afterEach(async () => {
  for (const root of fixtures.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("Git workspace containment", () => {
  it("treats a child directory of an outer repository as non-Git without leaking parent state", async () => {
    const outer = await fixture("outer");
    const workspace = path.join(outer, "workspace");
    await mkdir(workspace);
    await writeFile(path.join(outer, "outside-secret.txt"), "safe baseline\n", "utf8");
    await writeFile(path.join(workspace, "inside.txt"), "inside only\n", "utf8");
    initializeRepository(outer);
    git(outer, "add", ".");
    git(outer, "commit", "-qm", "initial");
    await writeFile(path.join(outer, "outside-secret.txt"), "PARENT_SECRET_MUST_NOT_LEAK\n", "utf8");

    const signal = new AbortController().signal;
    await expect(selfContainedGitRoot(workspace, signal)).resolves.toBeNull();
    await expect(gitPorcelain(workspace, signal)).resolves.toMatchObject({
      exitCode: 128,
      stdout: "",
      stderr: "Workspace is not a self-contained Git repository."
    });
    const contextItems = await new RepositoryContextProvider().collect(workspace, "secret", signal);
    const contextText = contextItems.map((item) => item.content).join("\n");
    expect(contextText).toContain("inside.txt");
    expect(contextText).not.toContain("outside-secret.txt");
    expect(contextText).not.toContain("PARENT_SECRET_MUST_NOT_LEAK");
    expect(contextItems.some((item) => item.provenance === "current Git diff")).toBe(false);

    const tools = registerBuiltinTools(new EffectToolRegistry());
    const status = await tools.execute(request("status", "git_status"), toolContext(workspace));
    const diff = await tools.execute(request("diff", "git_diff"), toolContext(workspace));
    expect(status).toMatchObject({ ok: false, diagnostics: ["workspace_not_git_root"] });
    expect(diff).toMatchObject({ ok: false, diagnostics: ["workspace_not_git_root"] });
    expect(`${status.output}\n${diff.output}`).not.toContain("PARENT_SECRET_MUST_NOT_LEAK");

    const allocation = await new WorkspaceIsolationManager(path.join(outer, "isolation")).allocate({
      childId: "child",
      workspacePath: workspace,
      intent: "write"
    });
    expect(allocation.isolation).toMatchObject({
      kind: "exclusive_workspace",
      sourceWorkspacePath: await realpath(workspace)
    });
    expect(allocation.isolation.repositoryRoot).toBeUndefined();
    await allocation.release();
  });

  it("keeps context, Git tools, and worktree isolation enabled for a repository rooted at the workspace", async () => {
    const workspace = await fixture("root");
    initializeRepository(workspace);
    await writeFile(path.join(workspace, "tracked.txt"), "base\n", "utf8");
    git(workspace, "add", ".");
    git(workspace, "commit", "-qm", "initial");
    await writeFile(path.join(workspace, "tracked.txt"), "SELF_CONTAINED_CHANGE\n", "utf8");

    const signal = new AbortController().signal;
    await expect(selfContainedGitRoot(workspace, signal)).resolves.toBe(await realpath(workspace));
    const contextItems = await new RepositoryContextProvider().collect(workspace, "tracked", signal);
    expect(contextItems.find((item) => item.provenance === "current Git diff")?.content).toContain("SELF_CONTAINED_CHANGE");
    const tools = registerBuiltinTools(new EffectToolRegistry());
    await expect(tools.execute(request("status", "git_status"), toolContext(workspace))).resolves.toMatchObject({ ok: true });
    await expect(tools.execute(request("diff", "git_diff"), toolContext(workspace))).resolves.toMatchObject({ ok: true });

    git(workspace, "add", ".");
    git(workspace, "commit", "-qm", "change");
    const allocation = await new WorkspaceIsolationManager(path.join(path.dirname(workspace), "worktrees")).allocate({
      childId: "clean-child",
      workspacePath: workspace,
      intent: "write"
    });
    expect(allocation.isolation.kind).toBe("git_worktree");
    expect(allocation.workspacePath).not.toBe(workspace);
    await allocation.release();
  });

  it("returns a bounded head/tail preview and stores the complete large diff as an artifact", async () => {
    const workspace = await fixture("large-diff");
    initializeRepository(workspace);
    const base = ["HEAD_SENTINEL_BASE", ...Array.from({ length: 12_000 }, (_, index) => `old-${index}`), "TAIL_SENTINEL_BASE"].join("\n");
    const changed = ["HEAD_SENTINEL_CHANGED", ...Array.from({ length: 12_000 }, (_, index) => `new-${index}`), "TAIL_SENTINEL_CHANGED"].join("\n");
    await writeFile(path.join(workspace, "large.txt"), `${base}\n`, "utf8");
    git(workspace, "add", ".");
    git(workspace, "commit", "-qm", "initial");
    await writeFile(path.join(workspace, "large.txt"), `${changed}\n`, "utf8");

    const artifacts = new Map<string, string>();
    const tools = registerBuiltinTools(new EffectToolRegistry());
    const receipt = await tools.execute(request("large-diff", "git_diff"), toolContext(workspace, artifacts));
    const complete = artifacts.get("git-diff.patch");
    expect(receipt.ok).toBe(true);
    expect(receipt.output.length).toBeLessThan(33_000);
    expect(receipt.output).toContain("characters omitted; complete Git diff artifact: artifact:git-diff.patch");
    expect(receipt.output).toContain("HEAD_SENTINEL_BASE");
    expect(receipt.output).toContain("TAIL_SENTINEL_CHANGED");
    expect(receipt.artifacts).toEqual(["artifact:git-diff.patch"]);
    expect(complete?.length).toBeGreaterThan(receipt.output.length);
    expect(complete).toContain("HEAD_SENTINEL_CHANGED");
    expect(complete).toContain("new-6000");
    expect(complete).toContain("TAIL_SENTINEL_CHANGED");
    expect(await readFile(path.join(workspace, "large.txt"), "utf8")).toBe(`${changed}\n`);
  });
});
