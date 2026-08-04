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
  poll: ReturnType<typeof vi.fn>;
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
  const poll = vi.fn(async (handle) => ({
    handle,
    state: "exited" as const,
    exitCode: 0,
    signal: null,
    durationMs: 5,
    stdout: "ready",
    stderr: "",
    stdoutDroppedBytes: 0,
    stderrDroppedBytes: 0,
    outputTruncated: false,
    outputArtifacts: []
  }));
  const handoff = vi.fn(async (handle) => ({
    handle, handoffId: `handoff:${handle.id}`, systemProcessId: 4321
  }));
  const unavailable = async (): Promise<never> => await Promise.reject(new Error("not used"));
  return {
    execute,
    spawn,
    poll,
    handoff,
    broker: {
      lostProcessHandles: [],
      connect: unavailable,
      doctor: unavailable,
      execute,
      spawn,
      poll,
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
      runtimeCommands: ["runtime"],
      shells: []
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
      runtimeCommands: ["runtime"],
      shells: []
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
      runtimeCommands: ["runtime"],
      shells: []
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
      processHandoff: "deny",
      shells: []
    });
    expect(denied.descriptor("process_handoff")).toBeUndefined();
    expect(denied.descriptor("process_spawn")?.inputSchema).not.toMatchObject({
      properties: { lifecycle: expect.anything() }
    });
  });

  it("routes disposable-environment processes through the current shell contract", async () => {
    const root = await workspace();
    const fixture = brokerFixture();
    const tools = registerBuiltinTools(new EffectToolRegistry(), {
      broker: fixture.broker,
      foreground: true,
      background: true,
      readScope: "host",
      writeScope: "enclosing-container",
      enclosingContainerRoot: true,
      enclosingContainerAttestationDigest: "attested-container",
      handoff: true,
      processHandoff: "allow",
      networkMode: "none",
      networkModes: ["none"],
      runtimeCommands: ["runtime"],
      shells: ["bash"],
      directExecutableResolution: true,
      protectedPaths: [path.join(root, ".runtime")]
    });
    expect(tools.descriptor("environment_process_spawn")).toBeUndefined();
    expect(tools.descriptor("environment_shell")).toBeUndefined();
    expect(tools.descriptor("process_spawn")).toBeUndefined();
    const shell = tools.descriptor("shell");
    expect(shell?.inputSchema).toMatchObject({
      properties: {
        target: { enum: ["workspace", "environment"] },
        background: { type: "boolean" },
        lifecycle: { enum: ["session", "deliverable"] }
      }
    });
    expect(JSON.stringify(
      shell?.inputSchema.properties?.target
    )).toContain("only to later calls that also use target=environment");
    expect(shell?.description
    ).toContain("workspace-target calls use a separate sandbox view");
    expect(JSON.stringify(shell?.inputSchema)).toContain("prefer the verified shell command form");
    expect(JSON.stringify(shell?.inputSchema)).toContain("outside primary execution roots");
    expect(shell).toMatchObject({
      brokerMutationAuthority: "disposable_enclosing_container"
    });
    expect(shell?.inputSchema).not.toMatchObject({
      properties: {
        access: expect.anything(),
        writeRoots: expect.anything()
      }
    });

    const call = request("shell", {
      executable: "runtime",
      target: "environment",
      background: true,
      yieldMs: 0,
      lifecycle: "deliverable"
    });
    const plan = await tools.prepare(call, preparation(root));
    expect(plan).toMatchObject({
      mutationAuthority: "disposable_enclosing_container",
      processMode: "background",
      checkpointScope: [path.parse(path.resolve(root)).root]
    });
    await expect(tools.execute(call, {
      ...execution(root),
      callPlan: plan,
      approval: {
        callId: call.callId,
        authority: "runtime",
        networkApproved: false,
        externalReadApproved: true,
        processHandoffApproved: false,
        openWorldApproved: true
      }
    })).resolves.toMatchObject({ ok: true });
    expect(fixture.spawn).toHaveBeenLastCalledWith(expect.objectContaining({
      lifecycle: "deliverable",
      policy: expect.objectContaining({
        enclosingContainerRoot: true,
        writeRoots: [path.parse(path.resolve(root)).root],
        protectedPaths: expect.arrayContaining([
          path.resolve(root),
          path.resolve(root, ".runtime")
        ])
      })
    }), expect.anything());

    for (const retired of ["environment_process_spawn", "environment_shell", "process_spawn"]) {
      await expect(tools.prepare(
        request(retired, { executable: "runtime" }),
        preparation(root)
      )).rejects.toThrow(`Unknown tool '${retired}'.`);
    }

    const unattested = registerBuiltinTools(new EffectToolRegistry(), {
      broker: fixture.broker,
      foreground: true,
      background: true,
      readScope: "host",
      writeScope: "enclosing-container",
      enclosingContainerRoot: true,
      networkMode: "none",
      networkModes: ["none"],
      runtimeCommands: ["runtime"],
      shells: ["bash"]
    });
    expect(unattested.descriptor("environment_process_spawn")).toBeUndefined();
    expect(unattested.descriptor("environment_shell")).toBeUndefined();
    expect(unattested.descriptor("process_spawn")).toBeUndefined();
    expect(unattested.descriptor("shell")?.inputSchema.properties)
      .not.toHaveProperty("target");
  });

  it("keeps the shell schema aligned with verified capabilities and rejects unsupported arguments", async () => {
    const root = await workspace();
    const fixture = brokerFixture();
    const tools = registerBuiltinTools(new EffectToolRegistry(), {
      broker: fixture.broker,
      foreground: true,
      background: false,
      networkMode: "none",
      networkModes: ["none"],
      shells: ["bash"]
    });

    expect(tools.descriptor("shell")?.inputSchema).toMatchObject({
      properties: { shell: { enum: ["bash"] }, timeoutMs: { maximum: 600000 } }
    });
    const commandOnly = request("shell", { command: "printf ok" });
    const plan = await tools.prepare(commandOnly, preparation(root));
    await expect(tools.execute(commandOnly, { ...execution(root), callPlan: plan }))
      .resolves.toMatchObject({ ok: true });
    expect(fixture.execute).toHaveBeenCalledWith(expect.objectContaining({
      command: expect.objectContaining({
        executable: "bash",
        args: ["-lc", "printf ok"]
      })
    }), expect.anything());
    const direct = request("shell", {
      executable: process.execPath,
      args: ["--version"]
    });
    const directPlan = await tools.prepare(direct, preparation(root));
    await expect(tools.execute(direct, { ...execution(root), callPlan: directPlan }))
      .resolves.toMatchObject({ ok: true });
    expect(fixture.execute).toHaveBeenLastCalledWith(expect.objectContaining({
      command: expect.objectContaining({ executable: process.execPath, args: ["--version"] })
    }), expect.anything());
    await expect(tools.prepare(
      request("shell", { command: "printf ok", args: ["ignored"] }),
      preparation(root)
    )).rejects.toMatchObject({ code: "tool_arguments_invalid" });
    await expect(tools.prepare(
      request("shell", { shell: "bash", command: "printf ok", unsupported: true }),
      preparation(root)
    )).rejects.toMatchObject({ code: "tool_arguments_invalid" });
    await expect(tools.prepare(
      request("shell", { shell: "bash", command: "printf ok", timeoutMs: "fast" }),
      preparation(root)
    )).rejects.toMatchObject({ code: "tool_arguments_invalid" });
  });

  it("uses one model-visible shell for command, validation, and background execution", async () => {
    const root = await workspace();
    const fixture = brokerFixture();
    const tools = registerBuiltinTools(new EffectToolRegistry(), {
      broker: fixture.broker,
      foreground: true,
      background: true,
      networkMode: "none",
      networkModes: ["none"],
      runtimeCommands: ["runtime"],
      shells: ["bash"]
    });
    const modelNames = tools.modelDescriptors().map((item) => item.name);
    const runtimeNames = tools.descriptors().map((item) => item.name);
    expect(modelNames).toContain("shell");
    for (const retired of [
      "exec", "validate", "process_spawn",
      "environment_shell", "environment_process_spawn"
    ]) {
      expect(modelNames).not.toContain(retired);
      expect(runtimeNames).not.toContain(retired);
    }

    const inferredWriteCall = request("shell", {
      executable: "runtime",
      expectedChanges: ["generated.txt"]
    });
    const inferredWritePlan = await tools.prepare(inferredWriteCall, preparation(root));
    expect(inferredWritePlan).toMatchObject({
      writePaths: ["generated.txt"],
      checkpointScope: ["."],
      exactEffects: expect.arrayContaining(["filesystem.write"])
    });

    for (const oldArguments of [
      { executable: "runtime", access: "write" },
      { executable: "runtime", writeRoots: ["."] },
      { executable: "runtime", purpose: "Old validation metadata" },
      { executable: "runtime", subjects: ["generated.txt"] },
      { executable: "runtime", criterionIds: ["criterion-1"] }
    ]) {
      await expect(tools.prepare(
        request("shell", oldArguments),
        preparation(root)
      )).rejects.toMatchObject({ code: "tool_arguments_invalid" });
    }

    const validationCall = request("shell", {
      executable: "runtime",
      validation: true
    });
    const validationPlan = await tools.prepare(validationCall, preparation(root));
    expect(validationPlan).toMatchObject({
      processMode: "pipe",
      exactEffects: expect.arrayContaining(["validation"])
    });
    await expect(tools.execute(validationCall, {
      ...execution(root),
      callPlan: validationPlan
    })).resolves.toMatchObject({
      ok: true,
      evidence: [expect.objectContaining({ kind: "validation" })]
    });
    await expect(tools.prepare(request("shell", {
      executable: "runtime",
      validation: false
    }), preparation(root))).resolves.toMatchObject({
      exactEffects: expect.not.arrayContaining(["validation"])
    });
    await expect(tools.prepare(request("shell", {
      executable: "runtime",
      background: true
    }), preparation(root))).resolves.toMatchObject({
      processMode: "background",
      exactEffects: expect.not.arrayContaining(["validation"])
    });
    await expect(tools.prepare(request("shell", {
      executable: "runtime",
      background: true,
      timeoutMs: 120_000
    }), preparation(root))).resolves.toMatchObject({
      processMode: "background"
    });

    const backgroundCall = request("shell", {
      executable: "runtime",
      background: true,
      yieldMs: 0
    });
    const backgroundPlan = await tools.prepare(backgroundCall, preparation(root));
    expect(backgroundPlan).toMatchObject({ processMode: "background" });
    const receipt = await tools.execute(backgroundCall, {
      ...execution(root),
      callPlan: backgroundPlan
    });
    expect(receipt).toMatchObject({ ok: true });
    expect(JSON.parse(receipt.output)).toMatchObject({
      state: "exited",
      exitCode: 0,
      stdout: "ready",
      handle: { id: "process", brokerInstanceId: "broker" }
    });
    expect(fixture.spawn).toHaveBeenCalledOnce();
    expect(fixture.poll).toHaveBeenCalledOnce();
  });
});
