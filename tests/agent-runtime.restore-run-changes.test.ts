import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ExecutionBroker } from "../packages/agent-execution/src/index.js";
import type { AgentEventEnvelope, RepositoryDeltaEvidence } from "../packages/agent-protocol/src/index.js";
import { createRuntime } from "../packages/agent-runtime/src/testing.js";
import { releaseRepositoryRunBaselines } from "../packages/agent-runtime/src/runtime-restoration-control.js";
import { repositoryTransactionTool } from "../packages/agent-runtime/src/repository-transaction-tool.js";
import { SegmentedJsonlStore } from "../packages/agent-store/src/index.js";
import { EffectToolRegistry, registerBuiltinTools } from "../packages/agent-tools/src/index.js";
import {
  fakeToolCall,
  fakeToolTurn,
  fakeFinalTurn,
  SmokeFakeGateway
} from "../scripts/smoke-fake-model.mjs";
import { createHostExecutionBroker } from "./helpers/host-execution-broker.js";
import { runtimeSessionFixture } from "./testkit/runtime-session-fixture.js";

function git(repository: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: repository,
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

async function events(store: SegmentedJsonlStore, sessionId: string): Promise<AgentEventEnvelope[]> {
  const result: AgentEventEnvelope[] = [];
  for await (const event of store.events(sessionId)) result.push(event);
  return result;
}

describe("restore_run_changes transaction control", () => {
  it("releases each broker-held run baseline once when the runtime session is released", async () => {
    const workspace = path.resolve(await mkdtemp(path.join(os.tmpdir(), "sigma-baseline-release-")));
    const repositoryDelta: RepositoryDeltaEvidence = {
      evidenceId: "repository-delta",
      sessionId: "session",
      runId: "run",
      kind: "repository_delta",
      status: "passed",
      createdAt: "2026-01-01T00:00:00.000Z",
      producer: { authority: "tool", id: "git-call" },
      summary: "repository changed",
      data: {
        repositoryRoot: ".",
        operationCount: 1,
        operations: ["commit"],
        beforeStateDigest: "a".repeat(64),
        afterStateDigest: "b".repeat(64),
        headBefore: null,
        headAfter: "1".repeat(40),
        refsBeforeDigest: "c".repeat(64),
        refsAfterDigest: "d".repeat(64),
        indexBeforeDigest: "e".repeat(64),
        indexAfterDigest: "f".repeat(64),
        reachableObjectsBefore: 0,
        reachableObjectsAfter: 1
      }
    };
    const active = runtimeSessionFixture({ workspacePath: workspace });
    active.durable.state.evidence = [repositoryDelta];
    active.durable.state.mutationEvidence = [repositoryDelta];
    const requests: unknown[] = [];
    const execution = {
      releaseRepositoryRunBaseline: async (request: unknown) => {
        requests.push(request);
        return {
          protocolVersion: 1 as const,
          status: "released" as const,
          baselineId: "baseline",
          sessionId: "session",
          runId: "run",
          repositoryRoot: workspace
        };
      }
    } as unknown as ExecutionBroker;

    await releaseRepositoryRunBaselines(execution, active);
    expect(requests).toEqual([expect.objectContaining({
      sessionId: "session", runId: "run", repositoryRoot: workspace
    })]);
  });

  it("restores every current-run checkpoint as one baseline transaction and completes from restoration evidence", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-restore-run-group-"));
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);
    await writeFile(path.join(workspace, "state.txt"), "baseline", "utf8");
    const storeRootDir = path.join(root, "state");
    const store = new SegmentedJsonlStore({ rootDir: storeRootDir });
    const runtime = createRuntime({
      gateway: new SmokeFakeGateway([
        fakeToolTurn([fakeToolCall("first", "write", { path: "state.txt", content: "changed" })]),
        fakeToolTurn([fakeToolCall("second", "write", { path: "extra.txt", content: "temporary" })]),
        fakeToolTurn([fakeToolCall("restore-all", "restore_run_changes", {})]),
        fakeFinalTurn("All run changes were restored.")
      ]),
      tools: registerBuiltinTools(new EffectToolRegistry()),
      store,
      storeRootDir,
      permissionMode: "auto",
      runDeadlineMs: 60_000
    });
    const session = await runtime.createSession({ workspacePath: workspace, mode: "change" });

    await runtime.command({ type: "submit", sessionId: session.sessionId, text: "Make temporary changes, then restore them." });
    await expect(runtime.waitForOutcome(session.sessionId)).resolves.toMatchObject({
      kind: "completed",
      message: expect.stringContaining("All run changes were restored.")
    });
    await expect(readFile(path.join(workspace, "state.txt"), "utf8")).resolves.toBe("baseline");
    await expect(readFile(path.join(workspace, "extra.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    const stored = await events(store, session.sessionId);
    expect(stored.filter((event) => event.type === "checkpoint.restored")).toHaveLength(2);
    expect(stored).toContainEqual(expect.objectContaining({
      type: "evidence.recorded",
      payload: expect.objectContaining({ kind: "restoration", status: "passed" })
    }));
  }, 30_000);

  it("restores broker-held repository metadata before confirming the run baseline", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-restore-repository-"));
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);
    git(workspace, ["init", "-q", "--initial-branch=main"]);
    git(workspace, ["config", "user.email", "sigma@example.invalid"]);
    git(workspace, ["config", "user.name", "Sigma"]);
    await writeFile(path.join(workspace, "state.txt"), "baseline", "utf8");
    git(workspace, ["add", "state.txt"]);
    git(workspace, ["commit", "-qm", "baseline"]);
    const baselineHead = git(workspace, ["rev-parse", "HEAD"]);
    const storeRootDir = path.join(root, "state");
    const store = new SegmentedJsonlStore({ rootDir: storeRootDir });
    const broker = createHostExecutionBroker();
    const tools = registerBuiltinTools(new EffectToolRegistry(), { broker });
    tools.register(repositoryTransactionTool(broker));
    const runtime = createRuntime({
      gateway: new SmokeFakeGateway([
        fakeToolTurn([fakeToolCall("write", "write", {
          path: "state.txt", content: "temporary"
        })]),
        fakeToolTurn([fakeToolCall("commit", "git_transaction", {
          operations: [
            { op: "add", paths: ["state.txt"] },
            { op: "commit", message: "temporary" }
          ]
        })]),
        fakeToolTurn([fakeToolCall("restore", "restore_run_changes", {})]),
        fakeFinalTurn("All workspace and repository changes were restored.")
      ]),
      tools,
      execution: broker,
      store,
      storeRootDir,
      permissionMode: "auto",
      runDeadlineMs: 60_000
    });
    const session = await runtime.createSession({ workspacePath: workspace, mode: "change" });

    await runtime.command({
      type: "submit",
      sessionId: session.sessionId,
      text: "Make a temporary commit and then restore every run change."
    });
    await expect(runtime.waitForOutcome(session.sessionId)).resolves.toMatchObject({
      kind: "completed"
    });
    expect(git(workspace, ["rev-parse", "HEAD"])).toBe(baselineHead);
    expect(git(workspace, ["status", "--porcelain", "--untracked-files=no"])).toBe("");
    await expect(readFile(path.join(workspace, "state.txt"), "utf8"))
      .resolves.toBe("baseline");
    expect(await events(store, session.sessionId)).toContainEqual(expect.objectContaining({
      type: "evidence.recorded",
      payload: expect.objectContaining({
        kind: "restoration",
        status: "passed",
        data: expect.objectContaining({
          repository: expect.objectContaining({ status: "restored" })
        })
      })
    }));
    await runtime.releaseSession(session.sessionId);
    await broker.close();
  }, 60_000);

  it("restores the latest mutation from this run without creating a nested checkpoint", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-restore-run-"));
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);
    const storeRootDir = path.join(root, "state");
    const store = new SegmentedJsonlStore({ rootDir: storeRootDir });
    const runtime = createRuntime({
      gateway: new SmokeFakeGateway([
        fakeToolTurn([fakeToolCall("write", "write", {
          path: "temporary.txt",
          content: "temporary"
        })]),
        fakeToolTurn([fakeToolCall("restore", "restore_run_changes", {})]),
        fakeToolTurn([fakeToolCall("done", "request_user_input", { message: "Restore complete." })])
      ]),
      tools: registerBuiltinTools(new EffectToolRegistry()),
      store,
      storeRootDir,
      permissionMode: "auto",
      runDeadlineMs: 60_000
    });
    const session = await runtime.createSession({ workspacePath: workspace, mode: "change" });

    await runtime.command({ type: "submit", sessionId: session.sessionId, text: "Create and then restore a file." });
    await expect(runtime.waitForOutcome(session.sessionId)).resolves.toMatchObject({
      kind: "needs_input",
      requestId: "done"
    });
    await expect(readFile(path.join(workspace, "temporary.txt"))).rejects.toMatchObject({ code: "ENOENT" });

    const stored = await events(store, session.sessionId);
    expect(stored.filter((event) => event.type === "checkpoint.created")).toHaveLength(1);
    expect(stored.filter((event) => event.type === "checkpoint.sealed")).toHaveLength(1);
    expect(stored.filter((event) => event.type === "checkpoint.restored")).toHaveLength(1);
    expect(stored).toContainEqual(expect.objectContaining({
      type: "execution.planned",
      payload: expect.objectContaining({
        toolCallId: "restore",
        plan: expect.objectContaining({
          checkpointAction: expect.objectContaining({ kind: "restore" }),
          writePaths: ["temporary.txt"]
        })
      })
    }));
  });

  it("refuses to restore while a child agent can still mutate the workspace", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-restore-child-"));
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);
    const storeRootDir = path.join(root, "state");
    const store = new SegmentedJsonlStore({ rootDir: storeRootDir });
    const runtime = createRuntime({
      gateway: new SmokeFakeGateway([
        fakeToolTurn([fakeToolCall("write", "write", { path: "retained.txt", content: "retained" })]),
        fakeToolTurn([fakeToolCall("restore", "restore_run_changes", {})]),
        fakeToolTurn([fakeToolCall("done", "request_user_input", { message: "Restore was blocked." })])
      ]),
      tools: registerBuiltinTools(new EffectToolRegistry()),
      store,
      storeRootDir,
      permissionMode: "auto",
      runDeadlineMs: 60_000,
      hasActiveChildren: () => true
    });
    const session = await runtime.createSession({ workspacePath: workspace, mode: "change" });

    await runtime.command({ type: "submit", sessionId: session.sessionId, text: "Try an unsafe restore." });
    await expect(runtime.waitForOutcome(session.sessionId)).resolves.toMatchObject({ requestId: "done" });
    await expect(readFile(path.join(workspace, "retained.txt"), "utf8")).resolves.toBe("retained");
    expect(await events(store, session.sessionId)).toContainEqual(expect.objectContaining({
      type: "tool.failed",
      payload: expect.objectContaining({ diagnostics: ["checkpoint_children_active"] })
    }));
  });

  it("refuses to restore while a background process is still active", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-restore-process-"));
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);
    const storeRootDir = path.join(root, "state");
    const store = new SegmentedJsonlStore({ rootDir: storeRootDir });
    const unused = async (): Promise<never> => await Promise.reject(new Error("unused"));
    const broker: ExecutionBroker = {
      lostProcessHandles: [],
      connect: unused,
      doctor: unused,
      execute: unused,
      spawn: async () => ({ id: "active-process", brokerInstanceId: "fixture-broker" }),
      poll: unused,
      write: unused,
      terminate: unused,
      close: async () => undefined
    };
    const runtime = createRuntime({
      gateway: new SmokeFakeGateway([
        fakeToolTurn([fakeToolCall("write", "write", { path: "retained.txt", content: "retained" })]),
        fakeToolTurn([fakeToolCall("spawn", "process_spawn", {
          executable: "fixture-process",
          args: []
        })]),
        fakeToolTurn([fakeToolCall("restore", "restore_run_changes", {})]),
        fakeToolTurn([fakeToolCall("done", "request_user_input", { message: "Restore was blocked." })])
      ]),
      tools: registerBuiltinTools(new EffectToolRegistry(), {
        broker, runtimeCommands: ["fixture-process"]
      }),
      store,
      storeRootDir,
      permissionMode: "auto",
      runDeadlineMs: 60_000
    });
    const session = await runtime.createSession({ workspacePath: workspace, mode: "change" });

    await runtime.command({ type: "submit", sessionId: session.sessionId, text: "Try restore with a live process." });
    await expect(runtime.waitForOutcome(session.sessionId)).resolves.toMatchObject({ requestId: "done" });
    await expect(readFile(path.join(workspace, "retained.txt"), "utf8")).resolves.toBe("retained");
    const stored = await events(store, session.sessionId);
    expect(stored).toContainEqual(expect.objectContaining({
      type: "tool.failed",
      payload: expect.objectContaining({ diagnostics: ["checkpoint_processes_active"] })
    }));
    expect(stored.some((event) => event.type === "checkpoint.restored")).toBe(false);
  });

  it("turns typed prepare failures into model-visible structured receipts", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-prepare-receipt-"));
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);
    const storeRootDir = path.join(root, "state");
    const store = new SegmentedJsonlStore({ rootDir: storeRootDir });
    const runtime = createRuntime({
      gateway: new SmokeFakeGateway([
        fakeToolTurn([fakeToolCall("invalid-write-plan", "exec", {
          executable: "fixture",
          access: "write",
          writeRoots: ["src"]
        })]),
        fakeToolTurn([fakeToolCall("done", "request_user_input", { message: "Prepare failure observed." })])
      ]),
      tools: registerBuiltinTools(new EffectToolRegistry(), { runtimeCommands: ["fixture"] }),
      store,
      storeRootDir,
      permissionMode: "auto",
      runDeadlineMs: 60_000
    });
    const session = await runtime.createSession({ workspacePath: workspace, mode: "change" });

    await runtime.command({ type: "submit", sessionId: session.sessionId, text: "Exercise invalid planning." });
    await expect(runtime.waitForOutcome(session.sessionId)).resolves.toMatchObject({ requestId: "done" });
    expect(await events(store, session.sessionId)).toContainEqual(expect.objectContaining({
      type: "tool.failed",
      payload: expect.objectContaining({
        callId: "invalid-write-plan",
        diagnostics: ["write_scope_required"],
        outcome: expect.objectContaining({ diagnosticCodes: ["write_scope_required"] })
      })
    }));
  });
});
