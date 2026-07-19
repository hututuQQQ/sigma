import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ExecutionBroker } from "../packages/agent-execution/src/index.js";
import type { AgentEventEnvelope } from "../packages/agent-protocol/src/index.js";
import { createRuntime } from "../packages/agent-runtime/src/testing.js";
import { SegmentedJsonlStore } from "../packages/agent-store/src/index.js";
import { EffectToolRegistry, registerBuiltinTools } from "../packages/agent-tools/src/index.js";
import {
  fakeToolCall,
  fakeToolTurn,
  SmokeFakeGateway
} from "../scripts/smoke-fake-model.mjs";

async function events(store: SegmentedJsonlStore, sessionId: string): Promise<AgentEventEnvelope[]> {
  const result: AgentEventEnvelope[] = [];
  for await (const event of store.events(sessionId)) result.push(event);
  return result;
}

describe("restore_run_changes transaction control", () => {
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
      // Keep this transaction-control test outside deadline convergence so
      // the restore request reaches the active-process safety preflight.
      runDeadlineMs: 300_000
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
        diagnostics: ["tool_arguments_stale"],
        outcome: expect.objectContaining({ diagnosticCodes: ["tool_arguments_stale"] }),
        result: {
          status: "rejected",
          code: "tool_arguments_stale",
          nextArguments: { executable: "fixture", expectedChanges: ["src"] }
        }
      })
    }));
  });
});
