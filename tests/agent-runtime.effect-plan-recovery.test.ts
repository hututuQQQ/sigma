import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type {
  BrokerDoctorReport,
  ExecutionBroker,
  ExecutionResult
} from "../packages/agent-execution/src/index.js";
import type { AgentEventEnvelope } from "../packages/agent-protocol/src/index.js";
import { createRuntime } from "../packages/agent-runtime/src/index.js";
import { SegmentedJsonlStore } from "../packages/agent-store/src/index.js";
import { EffectToolRegistry, registerBuiltinTools } from "../packages/agent-tools/src/index.js";
import {
  fakeToolCall,
  fakeToolTurn,
  SmokeFakeGateway
} from "../scripts/smoke-fake-model.mjs";

const report: BrokerDoctorReport = {
  protocolVersion: 1,
  brokerVersion: "test",
  platform: process.platform,
  architecture: process.arch,
  sandbox: { available: true, backend: "test", selfTestPassed: true, setupRequired: false },
  capabilities: {
    foreground: true,
    background: false,
    stdin: true,
    pty: false,
    networkModes: ["none"]
  }
};

const exited: ExecutionResult = {
  state: "exited",
  exitCode: 0,
  signal: null,
  durationMs: 1,
  timedOut: false,
  idleTimedOut: false,
  cancelled: false,
  stdout: "ok",
  stderr: "",
  stdoutDroppedBytes: 0,
  stderrDroppedBytes: 0,
  outputTruncated: false,
  outputArtifacts: []
};

async function events(store: SegmentedJsonlStore, sessionId: string): Promise<AgentEventEnvelope[]> {
  const result: AgentEventEnvelope[] = [];
  for await (const event of store.events(sessionId)) result.push(event);
  return result;
}

describe("effect-plan recovery", () => {
  it("denies a dynamically mutating plan in analyze mode before execution", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-analyze-plan-denial-"));
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);
    const storeRootDir = path.join(root, "state");
    const store = new SegmentedJsonlStore({ rootDir: storeRootDir });
    let executed = false;
    const tools = registerBuiltinTools(new EffectToolRegistry());
    tools.register({
      descriptor: {
        name: "dynamic_writer",
        description: "Fixture with a plan-narrowed effect contract.",
        inputSchema: { type: "object" },
        possibleEffects: ["filesystem.read"],
        maximumEffects: ["filesystem.read", "filesystem.write"],
        availableModes: ["analyze", "change"],
        executionMode: "exclusive",
        resourceKeys: ["workspace"],
        approval: "auto",
        idempotent: false,
        timeoutMs: 1_000,
        prepare: async () => ({
          exactEffects: ["filesystem.write"],
          readPaths: [],
          writePaths: ["unexpected.txt"],
          network: "none",
          processMode: "none",
          checkpointScope: ["unexpected.txt"],
          idempotence: "non_replayable"
        })
      },
      execute: async (request) => {
        executed = true;
        return {
          callId: request.callId,
          ok: true,
          output: "unexpected",
          observedEffects: ["filesystem.write"],
          artifacts: [],
          diagnostics: [],
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString()
        };
      }
    });
    const runtime = createRuntime({
      gateway: new SmokeFakeGateway([
        fakeToolTurn([fakeToolCall("dynamic", "dynamic_writer", {})]),
        fakeToolTurn([fakeToolCall("done", "request_user_input", { message: "Mutation was denied." })])
      ]),
      tools,
      store,
      storeRootDir,
      permissionMode: "auto",
      runDeadlineMs: 10_000
    });
    const session = await runtime.createSession({ workspacePath: workspace, mode: "analyze" });

    await runtime.command({ type: "submit", sessionId: session.sessionId, text: "Attempt a dynamic mutation." });
    await expect(runtime.waitForOutcome(session.sessionId)).resolves.toMatchObject({ requestId: "done" });
    expect(executed).toBe(false);
    expect(await events(store, session.sessionId)).toContainEqual(expect.objectContaining({
      type: "tool.failed",
      payload: expect.objectContaining({ diagnostics: ["mode_denied"] })
    }));
  });

  it("detects a process write outside expectedChanges and restores the complete write root", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-effect-plan-recovery-"));
    const workspace = path.join(root, "workspace");
    const source = path.join(workspace, "src");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "sibling.txt"), "before", "utf8");
    const broker: ExecutionBroker = {
      lostProcessHandles: [],
      connect: async () => report,
      doctor: async () => report,
      execute: async () => {
        await writeFile(path.join(source, "sibling.txt"), "violation", "utf8");
        return exited;
      },
      spawn: async () => ({ id: "process", brokerInstanceId: "broker" }),
      poll: async () => ({ ...exited, handle: { id: "process", brokerInstanceId: "broker" } }),
      write: async () => undefined,
      terminate: async () => ({ ...exited, handle: { id: "process", brokerInstanceId: "broker" } }),
      close: async () => undefined
    };
    const storeRootDir = path.join(root, "state");
    const store = new SegmentedJsonlStore({ rootDir: storeRootDir });
    const runtime = createRuntime({
      gateway: new SmokeFakeGateway([
        fakeToolTurn([fakeToolCall("write", "exec", {
          executable: "fixture",
          access: "write",
          writeRoots: ["src"],
          expectedChanges: ["src/expected.txt"]
        })]),
        fakeToolTurn([fakeToolCall("done", "request_user_input", { message: "Violation handled." })])
      ]),
      tools: registerBuiltinTools(new EffectToolRegistry(), { broker }),
      store,
      storeRootDir,
      permissionMode: "auto",
      runDeadlineMs: 10_000
    });
    const session = await runtime.createSession({ workspacePath: workspace, mode: "change" });

    await runtime.command({ type: "submit", sessionId: session.sessionId, text: "Run the scoped mutation." });
    await expect(runtime.waitForOutcome(session.sessionId)).resolves.toMatchObject({
      kind: "needs_input",
      requestId: "done"
    });
    await expect(readFile(path.join(source, "sibling.txt"), "utf8")).resolves.toBe("before");

    const stored = await events(store, session.sessionId);
    expect(stored).toContainEqual(expect.objectContaining({
      type: "execution.failed",
      payload: expect.objectContaining({ code: "effect_plan_violation" })
    }));
    expect(stored.some((event) => event.type === "checkpoint.restored"
      && event.authority === "runtime")).toBe(true);
    expect(stored.some((event) => event.type === "checkpoint.sealed")).toBe(false);
  });

  it("allows only regular parent directories needed to create an approved nested file", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-effect-plan-parent-"));
    const workspace = path.join(root, "workspace");
    const source = path.join(workspace, "src");
    const expected = path.join(source, "generated", "nested", "file.ts");
    await mkdir(source, { recursive: true });
    const broker: ExecutionBroker = {
      lostProcessHandles: [],
      connect: async () => report,
      doctor: async () => report,
      execute: async () => {
        await mkdir(path.dirname(expected), { recursive: true });
        await writeFile(expected, "export {};", "utf8");
        return exited;
      },
      spawn: async () => ({ id: "process", brokerInstanceId: "broker" }),
      poll: async () => ({ ...exited, handle: { id: "process", brokerInstanceId: "broker" } }),
      write: async () => undefined,
      terminate: async () => ({ ...exited, handle: { id: "process", brokerInstanceId: "broker" } }),
      close: async () => undefined
    };
    const storeRootDir = path.join(root, "state");
    const store = new SegmentedJsonlStore({ rootDir: storeRootDir });
    const runtime = createRuntime({
      gateway: new SmokeFakeGateway([
        fakeToolTurn([fakeToolCall("write", "exec", {
          executable: "fixture",
          access: "write",
          writeRoots: ["src"],
          expectedChanges: ["src/generated/nested/file.ts"]
        })]),
        fakeToolTurn([fakeToolCall("done", "request_user_input", { message: "Nested write handled." })])
      ]),
      tools: registerBuiltinTools(new EffectToolRegistry(), { broker }),
      store,
      storeRootDir,
      permissionMode: "auto",
      runDeadlineMs: 10_000
    });
    const session = await runtime.createSession({ workspacePath: workspace, mode: "change" });

    await runtime.command({ type: "submit", sessionId: session.sessionId, text: "Create the nested file." });
    await expect(runtime.waitForOutcome(session.sessionId)).resolves.toMatchObject({ requestId: "done" });
    await expect(readFile(expected, "utf8")).resolves.toBe("export {};");
    const stored = await events(store, session.sessionId);
    expect(stored.some((event) => event.type === "execution.failed"
      && (event.payload as { code?: string }).code === "effect_plan_violation")).toBe(false);
    expect(stored.some((event) => event.type === "checkpoint.sealed")).toBe(true);
  });

  it("fails closed when automatic rollback of an effect-plan violation cannot complete", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-effect-plan-rollback-failure-"));
    const workspace = path.join(root, "workspace");
    const source = path.join(workspace, "src");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "sibling.txt"), "before", "utf8");
    const broker: ExecutionBroker = {
      lostProcessHandles: [],
      connect: async () => report,
      doctor: async () => report,
      execute: async () => {
        await writeFile(path.join(source, "sibling.txt"), "violation", "utf8");
        return exited;
      },
      spawn: async () => ({ id: "process", brokerInstanceId: "broker" }),
      poll: async () => ({ ...exited, handle: { id: "process", brokerInstanceId: "broker" } }),
      write: async () => undefined,
      terminate: async () => ({ ...exited, handle: { id: "process", brokerInstanceId: "broker" } }),
      close: async () => undefined
    };
    const storeRootDir = path.join(root, "state");
    const store = new SegmentedJsonlStore({ rootDir: storeRootDir });
    const gateway = new SmokeFakeGateway([
      fakeToolTurn([fakeToolCall("write", "exec", {
        executable: "fixture",
        access: "write",
        writeRoots: ["src"],
        expectedChanges: ["src/expected.txt"]
      })]),
      fakeToolTurn([fakeToolCall("must-not-run", "request_user_input", {
        message: "Rollback failure was ignored."
      })])
    ]);
    const runtime = createRuntime({
      gateway,
      tools: registerBuiltinTools(new EffectToolRegistry(), { broker }),
      store,
      storeRootDir,
      permissionMode: "auto",
      runDeadlineMs: 10_000,
      checkpointRestoreFaultInjector: ({ point }) => {
        if (point === "after_install") throw new Error("injected restore failure");
        if (point === "before_rollback_restore") throw new Error("injected rollback failure");
      }
    });
    const session = await runtime.createSession({ workspacePath: workspace, mode: "change" });

    await runtime.command({ type: "submit", sessionId: session.sessionId, text: "Run the scoped mutation." });
    await expect(runtime.waitForOutcome(session.sessionId)).resolves.toMatchObject({
      kind: "needs_input",
      requestId: expect.stringMatching(/^checkpoint:/u)
    });
    expect(gateway.requests).toHaveLength(1);
    await expect(runtime.command({
      type: "submit",
      sessionId: session.sessionId,
      text: "Continue despite the failed rollback."
    })).rejects.toMatchObject({ code: "checkpoint_recovery_required" });

    const stored = await events(store, session.sessionId);
    expect(stored).toContainEqual(expect.objectContaining({
      type: "tool.failed",
      payload: expect.objectContaining({
        outcome: expect.objectContaining({ diagnosticCodes: ["checkpoint_recovery_failed"] })
      })
    }));
    expect(stored.some((event) => event.type === "checkpoint.restored")).toBe(false);
    expect(stored.some((event) => event.type === "tool.requested"
      && (event.payload as { callId?: string }).callId === "must-not-run")).toBe(false);
  });
});
