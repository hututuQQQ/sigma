import { mkdir, mkdtemp, readFile, rename, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type {
  BrokerDoctorReport,
  ExecutionBroker,
  ExecutionRequest,
  ExecutionResult
} from "../packages/agent-execution/src/index.js";
import type {
  JsonValue,
  ToolExecutionContext,
  ToolPreparationContext,
  ToolRequest
} from "../packages/agent-protocol/src/index.js";
import { EffectToolRegistry, registerBuiltinTools } from "../packages/agent-tools/src/index.js";

const report: BrokerDoctorReport = {
  protocolVersion: 1,
  brokerVersion: "test",
  platform: process.platform,
  architecture: process.arch,
  sandbox: { available: true, backend: "test", selfTestPassed: true, setupRequired: false },
  capabilities: {
    foreground: true,
    background: true,
    stdin: true,
    pty: true,
    networkModes: ["none", "full"]
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

function brokerFixture(): { broker: ExecutionBroker; executions: ExecutionRequest[] } {
  const executions: ExecutionRequest[] = [];
  return {
    executions,
    broker: {
      lostProcessHandles: [],
      connect: async () => report,
      doctor: async () => report,
      execute: async (input) => { executions.push(input); return exited; },
      spawn: async () => ({ id: "process", brokerInstanceId: "broker" }),
      poll: async () => ({ ...exited, handle: { id: "process", brokerInstanceId: "broker" } }),
      write: async () => undefined,
      terminate: async () => ({ ...exited, handle: { id: "process", brokerInstanceId: "broker" } }),
      close: async () => undefined
    }
  };
}

function request(callId: string, name: string, argumentsValue: JsonValue): ToolRequest {
  return { callId, name, arguments: argumentsValue };
}

function preparation(workspacePath: string, runMode: "analyze" | "change" = "change"): ToolPreparationContext {
  return { sessionId: "session", runId: "run", workspacePath, runMode };
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
    createArtifact: async ({ name }) => name
  };
}

describe("typed workspace mutation contracts", () => {
  it("rejects prepared effects outside a tool's declared maximum", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-effect-plan-maximum-"));
    const tools = new EffectToolRegistry();
    tools.register({
      descriptor: {
        name: "underdeclared",
        description: "fixture",
        inputSchema: { type: "object" },
        possibleEffects: ["filesystem.read"],
        maximumEffects: ["filesystem.read"],
        availableModes: ["analyze", "change"],
        executionMode: "parallel",
        resourceKeys: [],
        approval: "auto",
        idempotent: true,
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
      execute: async () => await Promise.reject(new Error("must not execute"))
    });

    await expect(tools.prepare(
      request("underdeclared", "underdeclared", {}),
      preparation(workspace, "analyze")
    )).rejects.toMatchObject({ code: "effect_plan_invalid" });
  });

  it("deletes one regular file through an approved checkpoint-sized plan and reports its delta", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-delete-file-"));
    await mkdir(path.join(workspace, "src"));
    await writeFile(path.join(workspace, "src", "obsolete.txt"), "obsolete", "utf8");
    const tools = registerBuiltinTools(new EffectToolRegistry());
    const call = request("delete", "delete_file", { path: "src/obsolete.txt" });

    expect(tools.descriptor("delete_file")).toMatchObject({
      approval: "prompt",
      availableModes: ["change"],
      executionMode: "exclusive",
      possibleEffects: ["filesystem.read", "filesystem.write", "destructive"],
      writePathArguments: ["path"]
    });
    await expect(tools.prepare(call, preparation(workspace))).resolves.toEqual({
      exactEffects: ["filesystem.read", "filesystem.write", "destructive"],
      readPaths: ["src/obsolete.txt"],
      writePaths: ["src/obsolete.txt"],
      network: "none",
      processMode: "none",
      checkpointScope: ["src/obsolete.txt"],
      idempotence: "non_replayable"
    });
    await expect(tools.execute(call, execution(workspace))).resolves.toMatchObject({
      ok: true,
      actualEffects: ["filesystem.read", "filesystem.write", "destructive"],
      workspaceDelta: { added: [], modified: [], deleted: ["src/obsolete.txt"] }
    });
    await expect(readFile(path.join(workspace, "src", "obsolete.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed for missing, escaping, protected, directory, and linked delete targets", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-delete-guards-"));
    await mkdir(path.join(workspace, ".git"));
    await mkdir(path.join(workspace, ".agent"));
    await mkdir(path.join(workspace, "directory"));
    await mkdir(path.join(workspace, "real"));
    await writeFile(path.join(workspace, ".git", "config"), "protected", "utf8");
    await writeFile(path.join(workspace, ".agent", "state"), "protected", "utf8");
    await writeFile(path.join(workspace, "real", "file.txt"), "linked", "utf8");
    const link = path.join(workspace, "linked");
    let linked = true;
    try {
      await symlink(path.join(workspace, "real"), link, process.platform === "win32" ? "junction" : "dir");
    } catch {
      linked = false;
    }
    const tools = registerBuiltinTools(new EffectToolRegistry());
    const run = async (callId: string, target: string): Promise<unknown> => {
      const call = request(callId, "delete_file", { path: target });
      await tools.prepare(call, preparation(workspace));
      return await tools.execute(call, execution(workspace));
    };

    await expect(run("missing", "missing.txt")).rejects.toMatchObject({ code: "delete_target_missing" });
    await expect(run("root", ".")).rejects.toMatchObject({ code: "path_escape" });
    await expect(run("escape", path.join(workspace, "..", "outside.txt"))).rejects.toMatchObject({ code: "path_escape" });
    await expect(run("git", ".git/config")).rejects.toMatchObject({ code: "protected_path" });
    await expect(run("agent", ".agent/state")).rejects.toMatchObject({ code: "protected_path" });
    await expect(run("directory", "directory")).rejects.toMatchObject({ code: "delete_target_not_file" });
    if (linked) {
      await expect(run("linked", "linked/file.txt")).rejects.toMatchObject({ code: "linked_path" });
    }
    await expect(readFile(path.join(workspace, "real", "file.txt"), "utf8")).resolves.toBe("linked");
  });

  it("separates process ACL roots from expected checkpoint changes and binds execution to the prepared plan", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-exec-contract-"));
    await mkdir(path.join(workspace, "src"));
    const fixture = brokerFixture();
    const tools = registerBuiltinTools(new EffectToolRegistry(), { broker: fixture.broker });
    const call = request("write-process", "exec", {
      executable: process.execPath,
      args: ["--version"],
      access: "write",
      writeRoots: ["src"],
      expectedChanges: ["src/generated.ts"]
    });

    const plan = await tools.prepare(call, preparation(workspace));
    expect(plan).toMatchObject({
      exactEffects: ["process.spawn", "filesystem.write"],
      writePaths: ["src/generated.ts"],
      checkpointScope: ["src"]
    });
    await expect(tools.execute(call, execution(workspace))).resolves.toMatchObject({
      ok: true,
      actualEffects: plan.exactEffects
    });
    expect(fixture.executions).toHaveLength(1);
    expect(fixture.executions[0]?.policy).toMatchObject({
      sandbox: "required",
      writeRoots: [path.join(workspace, "src")]
    });

    const legacy = request("legacy", "exec", {
      executable: process.execPath,
      writePaths: ["src"]
    });
    await expect(tools.prepare(legacy, preparation(workspace))).resolves.toMatchObject({
      writePaths: ["src"],
      checkpointScope: ["src"]
    });
  });

  it("returns stable diagnostics for incomplete, inconsistent, protected, and changed write plans", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-exec-plan-guards-"));
    await mkdir(path.join(workspace, "src"));
    await mkdir(path.join(workspace, ".git"));
    await writeFile(path.join(workspace, "root-file.txt"), "root", "utf8");
    const fixture = brokerFixture();
    const tools = registerBuiltinTools(new EffectToolRegistry(), { broker: fixture.broker });
    const prepareExec = async (callId: string, args: Record<string, JsonValue>, mode: "analyze" | "change" = "change") =>
      await tools.prepare(request(callId, "exec", { executable: process.execPath, ...args }), preparation(workspace, mode));

    await expect(prepareExec("implicit", {
      writeRoots: ["src"], expectedChanges: ["src/file.ts"]
    })).rejects.toMatchObject({ code: "write_scope_required" });
    await expect(prepareExec("missing-expected", {
      access: "write", writeRoots: ["src"]
    })).rejects.toMatchObject({ code: "write_scope_required" });
    await expect(prepareExec("outside-root", {
      access: "write", writeRoots: ["src"], expectedChanges: ["other/file.ts"]
    })).rejects.toMatchObject({ code: "write_plan_invalid" });
    await expect(prepareExec("readonly-write", {
      access: "readonly", writeRoots: ["src"], expectedChanges: ["src/file.ts"]
    })).rejects.toMatchObject({ code: "write_plan_invalid" });
    await expect(prepareExec("protected", {
      access: "write", writeRoots: [".git"], expectedChanges: [".git/config"]
    })).rejects.toMatchObject({ code: "policy_denied" });
    await expect(prepareExec("analyze-write", {
      access: "write", writeRoots: ["src"], expectedChanges: ["src/file.ts"]
    }, "analyze")).rejects.toMatchObject({ code: "policy_denied" });
    await expect(prepareExec("missing-root", {
      access: "write", writeRoots: ["missing"], expectedChanges: ["missing/file.ts"]
    })).rejects.toMatchObject({ code: "write_plan_invalid" });
    await expect(prepareExec("file-root", {
      access: "write", writeRoots: ["root-file.txt"], expectedChanges: ["root-file.txt"]
    })).rejects.toMatchObject({ code: "write_plan_invalid" });

    const unplanned = request("unplanned-write", "exec", {
      executable: process.execPath,
      access: "write",
      writeRoots: ["src"],
      expectedChanges: ["src/unplanned.ts"]
    });
    await expect(tools.execute(unplanned, execution(workspace))).rejects.toMatchObject({
      code: "write_plan_missing"
    });

    const original = request("changed", "exec", {
      executable: process.execPath,
      access: "write",
      writeRoots: ["src"],
      expectedChanges: ["src/file.ts"]
    });
    await tools.prepare(original, preparation(workspace));
    await expect(tools.execute(request("changed", "exec", {
      executable: process.execPath,
      access: "write",
      writeRoots: ["."],
      expectedChanges: ["."]
    }), execution(workspace))).rejects.toMatchObject({ code: "write_plan_invalid" });
    expect(fixture.executions).toHaveLength(0);
  });

  it("rejects a write root that changes to a link after its plan is approved", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-exec-plan-drift-"));
    const authorized = path.join(workspace, "authorized");
    const original = path.join(workspace, "authorized-original");
    const other = path.join(workspace, "other");
    await mkdir(authorized);
    await mkdir(other);
    const fixture = brokerFixture();
    const tools = registerBuiltinTools(new EffectToolRegistry(), { broker: fixture.broker });
    const call = request("drifting-plan", "exec", {
      executable: process.execPath,
      access: "write",
      writeRoots: ["authorized"],
      expectedChanges: ["authorized/file.ts"]
    });
    await tools.prepare(call, preparation(workspace));
    await rename(authorized, original);
    await symlink(other, authorized, process.platform === "win32" ? "junction" : "dir");

    await expect(tools.execute(call, execution(workspace))).rejects.toMatchObject({ code: "write_plan_stale" });
    expect(fixture.executions).toHaveLength(0);
  });

  it.skipIf(process.platform !== "win32")(
    "pins approved Windows write roots until broker execution has settled",
    async () => {
      const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-exec-root-pin-"));
      const authorized = path.join(workspace, "authorized");
      const nested = path.join(authorized, "nested");
      const moved = path.join(authorized, "moved");
      await mkdir(nested, { recursive: true });
      const fixture = brokerFixture();
      let renameFailure: NodeJS.ErrnoException | undefined;
      fixture.broker.execute = async (input) => {
        fixture.executions.push(input);
        try {
          await rename(nested, moved);
        } catch (error) {
          renameFailure = error as NodeJS.ErrnoException;
        }
        return exited;
      };
      const tools = registerBuiltinTools(new EffectToolRegistry(), { broker: fixture.broker });
      const call = request("pinned-plan", "exec", {
        executable: process.execPath,
        access: "write",
        writeRoots: ["authorized"],
        expectedChanges: ["authorized/nested/file.ts"]
      });
      await tools.prepare(call, preparation(workspace));

      await expect(tools.execute(call, execution(workspace))).resolves.toMatchObject({ ok: true });
      expect(renameFailure?.code).toMatch(/^(?:EACCES|EBUSY|EPERM)$/u);
      await expect(rename(nested, moved)).resolves.toBeUndefined();
    }
  );

  it("starts cmd shells in UTF-8 mode without weakening the existing invocation flags", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-cmd-utf8-"));
    const fixture = brokerFixture();
    const tools = registerBuiltinTools(new EffectToolRegistry(), { broker: fixture.broker });
    const call = request("cmd", "shell", {
      shell: "cmd",
      command: "echo 中文",
      access: "readonly"
    });

    await tools.prepare(call, preparation(workspace));
    await tools.execute(call, execution(workspace));
    expect(fixture.executions[0]?.command).toMatchObject({
      executable: "cmd.exe",
      args: ["/d", "/s", "/c", "chcp 65001>nul & echo 中文"]
    });
  });
});
