import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ProcessExecutionPort } from "../packages/agent-platform/src/index.js";
import type { JsonValue, ToolExecutionContext, ToolReceipt } from "../packages/agent-protocol/src/index.js";
import {
  recoverInterruptedRepositoryTransactions,
  repositoryTransactionTool
} from "../packages/agent-runtime/src/repository-transaction-tool.js";
import { EffectToolRegistry } from "../packages/agent-tools/src/index.js";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { createHostExecutionBroker } from "./helpers/host-execution-broker.js";

const workspaces: string[] = [];
let callNumber = 0;
const execution = createHostExecutionBroker();

function git(repository: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: repository,
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

async function repository(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "sigma-git-tool-"));
  workspaces.push(root);
  git(root, ["init", "-q", "--initial-branch=main"]);
  git(root, ["config", "user.email", "sigma@example.invalid"]);
  git(root, ["config", "user.name", "Sigma"]);
  await writeFile(path.join(root, "seed.txt"), "seed\n", "utf8");
  git(root, ["add", "seed.txt"]);
  git(root, ["commit", "-qm", "seed"]);
  return root;
}

function registry(
  limits: { maxFiles?: number; maxBytes?: number } = {},
  processExecution: ProcessExecutionPort = execution
): EffectToolRegistry {
  const tools = new EffectToolRegistry();
  tools.register(repositoryTransactionTool(processExecution, limits));
  return tools;
}

async function transact(
  tools: EffectToolRegistry,
  workspacePath: string,
  operations: JsonValue[],
  sessionId = "git-session"
): Promise<ToolReceipt> {
  return await transactArguments(tools, workspacePath, { operations }, sessionId);
}

async function transactArguments(
  tools: EffectToolRegistry,
  workspacePath: string,
  transactionArguments: JsonValue,
  sessionId = "git-session",
  runId = "git-run"
): Promise<ToolReceipt> {
  callNumber += 1;
  const request = {
    callId: `git-call-${callNumber}`,
    name: "git_transaction",
    arguments: transactionArguments
  };
  const base = { sessionId, runId, workspacePath, runMode: "change" as const };
  const callPlan = await tools.prepare(request, base);
  const context: ToolExecutionContext = {
    ...base,
    callPlan,
    ...(callPlan.exactEffects.includes("filesystem.read.external") ? {
      approval: {
        callId: request.callId,
        authority: "user" as const,
        networkApproved: false,
        externalReadApproved: true,
        processHandoffApproved: false,
        openWorldApproved: false
      }
    } : {}),
    signal: new AbortController().signal,
    progress: async () => undefined,
    createArtifact: async ({ name }) => name
  };
  return await tools.execute(request, context);
}

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map(async (item) => await rm(item, { recursive: true, force: true })));
});

afterAll(async () => await execution.close());

describe("controlled Git transactions", () => {
  it("fails closed before the first write when the broker lacks V2 transactions", async () => {
    const root = await repository();
    const legacy: ProcessExecutionPort = {
      execute: async (request, options) => await execution.execute(request, options)
    };

    await expect(transact(registry({}, legacy), root, [
      { op: "branch", action: "create", name: "must-not-run-on-legacy" }
    ])).rejects.toMatchObject({ code: "repository_atomicity_unavailable" });
    expect(() => git(root, ["show-ref", "--verify", "refs/heads/must-not-run-on-legacy"]))
      .toThrow();
  });

  it("stages and commits while producing repository_delta evidence", async () => {
    const root = await repository();
    await writeFile(path.join(root, "seed.txt"), "updated\n", "utf8");

    const receipt = await transact(registry(), root, [
      { op: "add", paths: ["seed.txt"] },
      { op: "commit", message: "update seed" }
    ]);

    expect(receipt).toMatchObject({
      ok: true,
      observedEffects: ["repository.write"],
      evidence: [expect.objectContaining({ kind: "repository_delta", status: "passed" })]
    });
    expect(git(root, ["log", "-1", "--pretty=%s"])).toBe("update seed");
    expect(git(root, ["status", "--porcelain", "--untracked-files=no"])).toBe("");
  }, 60_000);

  it("covers refs, worktree movement, history editing, and maintenance operation classes", async () => {
    const root = await repository();
    const tools = registry();
    const seed = git(root, ["rev-parse", "HEAD"]);
    git(root, ["switch", "-qc", "topic"]);
    await writeFile(path.join(root, "topic.txt"), "topic\n", "utf8");
    git(root, ["add", "topic.txt"]);
    git(root, ["commit", "-qm", "topic change"]);
    git(root, ["switch", "-qc", "side", seed]);
    await writeFile(path.join(root, "side.txt"), "side\n", "utf8");
    git(root, ["add", "side.txt"]);
    git(root, ["commit", "-qm", "side change"]);
    const sideCommit = git(root, ["rev-parse", "HEAD"]);
    git(root, ["switch", "-q", "main"]);
    await writeFile(path.join(root, "seed.txt"), "dirty\n", "utf8");

    await transact(tools, root, [
      { op: "restore", paths: ["seed.txt"], worktree: true },
      { op: "branch", action: "create", name: "test-aux", startPoint: seed },
      { op: "tag", action: "create", name: "v-test", target: seed },
      { op: "update_ref", ref: "refs/sigma/marker", newValue: seed },
      { op: "switch", target: "topic" },
      { op: "switch", target: "main" },
      { op: "merge", target: "topic" },
      { op: "cherry_pick", commits: [sideCommit] },
      { op: "revert", commits: ["HEAD"] },
      { op: "reset", mode: "hard", target: seed },
      { op: "rebase", upstream: "topic" },
      { op: "reflog_expire", expire: "now", all: true },
      { op: "gc", prune: "now" }
    ]);

    expect(await readFile(path.join(root, "seed.txt"), "utf8")).toBe("seed\n");
    expect(git(root, ["show-ref", "--verify", "refs/tags/v-test"])).toContain(seed);
    expect(git(root, ["show-ref", "--verify", "refs/sigma/marker"])).toContain(seed);
  }, 180_000);

  it("rolls back metadata when a later operation fails", async () => {
    const root = await repository();
    const tools = registry();

    await expect(transact(tools, root, [
      { op: "branch", action: "create", name: "must-rollback" },
      { op: "branch", action: "delete", name: "missing-branch" }
    ])).rejects.toMatchObject({ code: "repository_operation_failed" });

    expect(() => git(root, ["show-ref", "--verify", "refs/heads/must-rollback"]))
      .toThrow();
  }, 60_000);

  it("rejects an oversized metadata checkpoint before applying an operation", async () => {
    const root = await repository();
    const tools = registry({ maxBytes: 1 });

    await expect(transact(tools, root, [
      { op: "branch", action: "create", name: "must-not-exist" }
    ])).rejects.toMatchObject({ code: "repository_checkpoint_too_large" });

    expect(() => git(root, ["show-ref", "--verify", "refs/heads/must-not-exist"]))
      .toThrow();
  }, 30_000);

  it("continues a normal conflict through its broker-bound transaction handle", async () => {
    const root = await repository();
    const tools = registry();
    git(root, ["switch", "-qc", "topic"]);
    await writeFile(path.join(root, "seed.txt"), "topic\n", "utf8");
    git(root, ["add", "seed.txt"]);
    git(root, ["commit", "-qm", "topic"]);
    git(root, ["switch", "-q", "main"]);
    await writeFile(path.join(root, "seed.txt"), "main\n", "utf8");
    git(root, ["add", "seed.txt"]);
    git(root, ["commit", "-qm", "main"]);

    const pending = await transactArguments(tools, root, {
      action: "begin",
      operations: [{ op: "merge", target: "topic", noCommit: true }]
    });
    const value = JSON.parse(pending.output) as {
      status: string;
      transactionHandle: string;
      conflictCount: number;
    };
    expect(value).toMatchObject({ status: "conflicts_pending", conflictCount: 1 });

    await writeFile(path.join(root, "seed.txt"), "main + topic\n", "utf8");
    const completed = await transactArguments(tools, root, {
      action: "continue",
      transactionHandle: value.transactionHandle,
      operations: [{ op: "add", paths: ["seed.txt"] }]
    });

    expect(completed).toMatchObject({ ok: true, diagnostics: [] });
    expect(git(root, ["status", "--porcelain", "--untracked-files=no"])).toBe("");
    expect(git(root, ["rev-list", "--parents", "-n", "1", "HEAD"]).split(" "))
      .toHaveLength(3);
  }, 60_000);

  it("restores an interrupted broker-owned conflict journal", async () => {
    const root = await repository();
    const tools = registry();
    git(root, ["switch", "-qc", "topic"]);
    await writeFile(path.join(root, "seed.txt"), "topic\n", "utf8");
    git(root, ["add", "seed.txt"]);
    git(root, ["commit", "-qm", "topic"]);
    git(root, ["switch", "-q", "main"]);
    await writeFile(path.join(root, "seed.txt"), "main\n", "utf8");
    git(root, ["add", "seed.txt"]);
    git(root, ["commit", "-qm", "main"]);
    const expectedHead = git(root, ["rev-parse", "HEAD"]);
    await transactArguments(tools, root, {
      operations: [{ op: "merge", target: "topic" }]
    }, "interrupted-session", "interrupted-run");
    await writeFile(path.join(root, "seed.txt"), "partial resolution\n", "utf8");

    await recoverInterruptedRepositoryTransactions(
      execution, "interrupted-session", "interrupted-run"
    );

    expect(git(root, ["rev-parse", "HEAD"])).toBe(expectedHead);
    expect(await readFile(path.join(root, "seed.txt"), "utf8")).toBe("main\n");
    expect(git(root, ["status", "--porcelain", "--untracked-files=no"])).toBe("");
  }, 60_000);

  it("supports approved external gitdirs while rejecting broad arguments and escapes", async () => {
    const root = await repository();
    const tools = registry();
    await expect(transact(tools, root, [{ op: "add", paths: ["seed.txt"], argv: ["status"] }]))
      .rejects.toThrow();
    await expect(transact(tools, root, [{ op: "add", paths: ["../outside.txt"] }]))
      .rejects.toThrow("Unsafe Git pathspec");

    const linked = await mkdtemp(path.join(os.tmpdir(), "sigma-external-gitdir-"));
    workspaces.push(linked);
    await mkdir(path.join(linked, "repo"), { recursive: true });
    await writeFile(path.join(linked, "repo", ".git"), `gitdir: ${path.join(root, ".git")}\n`, "utf8");
    await expect(transact(tools, path.join(linked, "repo"), [
      { op: "branch", action: "create", name: "linked-approved" }
    ], "linked-session")).resolves.toMatchObject({
      ok: true,
      observedEffects: expect.arrayContaining(["repository.write", "filesystem.read.external"])
    });
    expect(git(root, ["show-ref", "--verify", "refs/heads/linked-approved"])).toContain("refs/heads/linked-approved");
  }, 60_000);
});
