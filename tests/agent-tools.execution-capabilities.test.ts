import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExecutionBroker, ExecutionResult } from "../packages/agent-execution/src/index.js";
import type {
  JsonValue,
  ToolExecutionContext,
  ToolPreparationContext,
  ToolRequest
} from "../packages/agent-protocol/src/index.js";
import { EffectToolRegistry, registerBuiltinTools } from "../packages/agent-tools/src/index.js";
import * as agentPlatform from "../packages/agent-platform/dist/index.js";
import { afterEach, describe, expect, it, vi } from "vitest";

const workspaces: string[] = [];

async function workspace(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "sigma-execution-capabilities-"));
  workspaces.push(root);
  return root;
}

function request(name: string, argumentsValue: JsonValue): ToolRequest {
  return { callId: `${name}-call`, name, arguments: argumentsValue };
}

function preparation(workspacePath: string): ToolPreparationContext {
  return { sessionId: "session", runId: "run", workspacePath, runMode: "change" };
}

function execution(workspacePath: string): ToolExecutionContext {
  return {
    sessionId: "session",
    runId: "run",
    workspacePath,
    runMode: "change",
    signal: new AbortController().signal,
    heartbeat: () => undefined,
    progress: async () => undefined,
    createArtifact: async () => "artifact"
  };
}

function brokerFixture(): {
  broker: ExecutionBroker;
  execute: ReturnType<typeof vi.fn>;
  spawn: ReturnType<typeof vi.fn>;
  handoff: ReturnType<typeof vi.fn>;
} {
  const exited: ExecutionResult = {
    state: "exited",
    exitCode: 0,
    signal: null,
    durationMs: 1,
    timedOut: false,
    idleTimedOut: false,
    cancelled: false,
    stdout: "",
    stderr: "",
    stdoutDroppedBytes: 0,
    stderrDroppedBytes: 0,
    outputTruncated: false,
    outputArtifacts: []
  };
  const execute = vi.fn(async () => exited);
  const spawn = vi.fn(async (input) => ({
    id: "process", brokerInstanceId: "broker", lifecycle: input.lifecycle ?? "session"
  }));
  const handoff = vi.fn(async (handle) => ({
    handle, handoffId: `handoff:${handle.id}`, systemProcessId: 4321
  }));
  const unavailable = async (): Promise<never> => await Promise.reject(new Error("not used"));
  return {
    execute,
    spawn,
    handoff,
    broker: {
      lostProcessHandles: [],
      connect: unavailable,
      doctor: unavailable,
      execute,
      spawn,
      poll: unavailable,
      write: unavailable,
      terminate: unavailable,
      handoff,
      close: async () => undefined
    }
  };
}

afterEach(async () => {
  for (const root of workspaces.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("execution tool capability closure", () => {
  it("projects and enforces only the connected process capabilities", async () => {
    const root = await workspace();
    const tools = registerBuiltinTools(new EffectToolRegistry(), {
      foreground: true,
      background: true,
      stdin: false,
      pty: false,
      networkMode: "none",
      networkModes: ["none"],
      runtimeCommands: ["runtime"]
    });

    expect(tools.descriptor("exec")?.inputSchema).toMatchObject({
      properties: {
        executable: {
          anyOf: [{ enum: ["runtime"] }, {
            pattern: process.platform === "win32" ? "[\\\\/]" : "/"
          }]
        },
        network: { enum: ["none"] }
      }
    });
    expect(tools.descriptor("process_spawn")?.inputSchema).toMatchObject({
      properties: { network: { enum: ["none"] } }
    });
    expect(tools.descriptor("process_spawn")?.inputSchema).not.toMatchObject({
      properties: { pty: expect.anything() }
    });
    expect(tools.descriptor("process_write")).toBeUndefined();

    await expect(tools.prepare(
      request("exec", { executable: "runtime", network: "full" }),
      preparation(root)
    )).rejects.toMatchObject({ code: "tool_arguments_invalid" });
    for (const pty of [false, true]) {
      await expect(tools.prepare(
        request("process_spawn", { executable: "runtime", pty }),
        preparation(root)
      )).rejects.toMatchObject({ code: "tool_arguments_invalid" });
    }
    await expect(tools.prepare(
      request("exec", { executable: "runtime" }),
      preparation(root)
    )).resolves.toMatchObject({ network: "none", processMode: "pipe" });
  });

  it("rejects unverified bare aliases before path pinning or broker execution", async () => {
    const root = await workspace();
    const fixture = brokerFixture();
    const pin = vi.spyOn(agentPlatform, "pinWorkspaceTransactionPaths");
    const tools = registerBuiltinTools(new EffectToolRegistry(), {
      broker: fixture.broker,
      foreground: true,
      background: true,
      networkMode: "none",
      networkModes: ["none"],
      runtimeCommands: ["runtime"]
    });

    try {
      for (const name of ["exec", "validate", "process_spawn"]) {
        const call = request(name, { executable: "unlisted-runtime", cwd: "missing" });
        await expect(tools.prepare(call, preparation(root)))
          .rejects.toMatchObject({ code: "tool_arguments_invalid" });
        await expect(tools.execute(call, execution(root)))
          .rejects.toMatchObject({ code: "tool_arguments_invalid" });
      }
      expect(pin).not.toHaveBeenCalled();
      expect(fixture.execute).not.toHaveBeenCalled();
      expect(fixture.spawn).not.toHaveBeenCalled();
    } finally {
      pin.mockRestore();
    }
  });

  it("does not project process tools when policy and broker network modes do not intersect", () => {
    const tools = registerBuiltinTools(new EffectToolRegistry(), {
      foreground: true,
      background: true,
      networkMode: "none",
      networkModes: []
    });

    expect(tools.descriptor("read")).toBeDefined();
    for (const name of [
      "exec", "shell", "validate", "process_spawn", "process_poll", "process_write", "process_terminate"
    ]) expect(tools.descriptor(name)).toBeUndefined();
  });

  it("projects deliverable lifecycle and handoff only when policy and broker both allow it", async () => {
    const root = await workspace();
    const fixture = brokerFixture();
    const tools = registerBuiltinTools(new EffectToolRegistry(), {
      broker: fixture.broker,
      foreground: true,
      background: true,
      handoff: true,
      processHandoff: "allow",
      networkMode: "none",
      networkModes: ["none"],
      runtimeCommands: ["runtime"]
    });
    expect(tools.descriptor("process_spawn")?.inputSchema).toMatchObject({
      properties: { lifecycle: { enum: ["session", "deliverable"] } }
    });
    expect(tools.descriptor("process_handoff")?.possibleEffects).toEqual(["process.handoff"]);

    const spawnCall = request("process_spawn", { executable: "runtime", lifecycle: "deliverable" });
    const spawnPlan = await tools.prepare(spawnCall, preparation(root));
    await expect(tools.execute(spawnCall, { ...execution(root), callPlan: spawnPlan }))
      .resolves.toMatchObject({ ok: true });
    expect(fixture.spawn).toHaveBeenCalledWith(
      expect.objectContaining({ lifecycle: "deliverable" }),
      expect.anything()
    );

    const handoffCall = request("process_handoff", {
      handleId: "process", brokerInstanceId: "broker"
    });
    const handoffPlan = await tools.prepare(handoffCall, preparation(root));
    await expect(tools.execute(handoffCall, {
      ...execution(root), callPlan: handoffPlan, approval: { processHandoffApproved: true }
    })).resolves.toMatchObject({ ok: true });
    expect(fixture.handoff).toHaveBeenCalledOnce();

    const denied = registerBuiltinTools(new EffectToolRegistry(), {
      handoff: true,
      processHandoff: "deny"
    });
    expect(denied.descriptor("process_handoff")).toBeUndefined();
    expect(denied.descriptor("process_spawn")?.inputSchema).not.toMatchObject({
      properties: { lifecycle: expect.anything() }
    });
  });

  it("keeps the shell schema aligned with verified capabilities and rejects unsupported arguments", async () => {
    const root = await workspace();
    const tools = registerBuiltinTools(new EffectToolRegistry(), {
      foreground: true,
      background: false,
      networkMode: "none",
      networkModes: ["none"],
      shells: ["bash"]
    });

    expect(tools.descriptor("shell")?.inputSchema).toMatchObject({
      properties: { shell: { enum: ["bash"] }, timeoutMs: { maximum: 600000 } }
    });
    await expect(tools.prepare(
      request("shell", { shell: "bash", command: "printf ok", unsupported: true }),
      preparation(root)
    )).rejects.toMatchObject({ code: "tool_arguments_invalid" });
    await expect(tools.prepare(
      request("shell", { shell: "bash", command: "printf ok", timeoutMs: "fast" }),
      preparation(root)
    )).rejects.toMatchObject({ code: "tool_arguments_invalid" });
  });
});
