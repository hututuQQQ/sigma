import { mkdir, mkdtemp, readFile, rename, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type {
  BrokerDoctorReport,
  ExecutionBroker,
  ExecutionRequest,
  ExecutionResult,
  ProcessSpawnRequest
} from "../packages/agent-execution/src/index.js";
import type {
  JsonValue,
  ToolExecutionContext,
  ToolPreparationContext,
  ToolRequest
} from "../packages/agent-protocol/src/index.js";
import { EffectToolRegistry, executionTools, registerBuiltinTools } from "../packages/agent-tools/src/index.js";

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

function brokerFixture(): {
  broker: ExecutionBroker;
  executions: ExecutionRequest[];
  spawns: ProcessSpawnRequest[];
} {
  const executions: ExecutionRequest[] = [];
  const spawns: ProcessSpawnRequest[] = [];
  return {
    executions,
    spawns,
    broker: {
      lostProcessHandles: [],
      connect: async () => report,
      doctor: async () => report,
      execute: async (input) => { executions.push(input); return exited; },
      spawn: async (input) => {
        spawns.push(input);
        return { id: "process", brokerInstanceId: "broker" };
      },
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

  it("limits every process tool to its approved cwd and explicit read roots", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-exec-read-scope-"));
    await mkdir(path.join(workspace, "work"));
    await mkdir(path.join(workspace, "inputs"));
    const fixture = brokerFixture();
    const tools = registerBuiltinTools(new EffectToolRegistry(), {
      broker: fixture.broker,
      shells: ["powershell"]
    });
    const calls = [
      request("read-exec", "exec", {
        executable: process.execPath, cwd: "work", readRoots: ["inputs"]
      }),
      request("read-shell", "shell", {
        shell: "powershell", command: "Get-Location", cwd: "work", readRoots: ["inputs"]
      }),
      request("read-validate", "validate", {
        executable: process.execPath, cwd: "work", readRoots: ["inputs"]
      }),
      request("read-spawn", "process_spawn", {
        executable: process.execPath, cwd: "work", readRoots: ["inputs"]
      })
    ];

    for (const call of calls) {
      await expect(tools.prepare(call, preparation(workspace))).resolves.toMatchObject({
        readPaths: ["work", "inputs"]
      });
      await expect(tools.execute(call, execution(workspace))).resolves.toMatchObject({ ok: true });
    }
    const expected = [path.join(workspace, "work"), path.join(workspace, "inputs")];
    expect(fixture.executions).toHaveLength(3);
    for (const item of fixture.executions) {
      expect(item.policy.readRoots).toEqual(expected);
      expect(item.policy.readRoots).not.toContain(workspace);
    }
    expect(fixture.spawns).toHaveLength(1);
    expect(fixture.spawns[0]?.policy.readRoots).toEqual(expected);
    for (const name of ["exec", "shell", "validate", "process_spawn"]) {
      expect(tools.descriptor(name)?.inputSchema).toMatchObject({
        properties: { readRoots: { type: "array", minItems: 1, uniqueItems: true } }
      });
    }
  });

  it("rejects escaping or unstable read roots and binds approved read paths into the plan signature", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-exec-read-guards-"));
    const approvedRoot = path.join(workspace, "approved");
    const replacement = path.join(workspace, "replacement");
    await mkdir(approvedRoot);
    await mkdir(replacement);
    await writeFile(path.join(workspace, "file.txt"), "not a directory", "utf8");
    const fixture = brokerFixture();
    const exec = executionTools({
      broker: fixture.broker, sandboxMode: "required", networkMode: "none"
    }).find((tool) => tool.descriptor.name === "exec")!;

    for (const readRoot of ["../outside", "missing", "file.txt"]) {
      await expect(exec.descriptor.prepare!({
        executable: process.execPath,
        readRoots: [readRoot]
      }, preparation(workspace))).rejects.toMatchObject({ code: "policy_denied" });
    }

    const originalInput = { executable: process.execPath, cwd: "approved" };
    const approvedPlan = await exec.descriptor.prepare!(originalInput, preparation(workspace));
    await expect(exec.execute(request("forged-read-plan", "exec", originalInput), {
      ...execution(workspace),
      callPlan: { ...approvedPlan, readPaths: ["."] }
    })).rejects.toMatchObject({ code: "write_plan_stale" });

    await rename(approvedRoot, path.join(workspace, "approved-original"));
    await symlink(replacement, approvedRoot, process.platform === "win32" ? "junction" : "dir");
    await expect(exec.execute(request("drifting-read-root", "exec", originalInput), {
      ...execution(workspace),
      callPlan: approvedPlan
    })).rejects.toMatchObject({ code: "write_plan_stale" });
    expect(fixture.executions).toHaveLength(0);
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

  it.skipIf(process.platform !== "win32")(
    "pins approved Windows read roots through foreground and background dispatch",
    async () => {
      const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-exec-read-pin-"));
      const foreground = path.join(workspace, "foreground");
      const background = path.join(workspace, "background");
      await Promise.all([mkdir(foreground), mkdir(background)]);
      const fixture = brokerFixture();
      const renameFailures: Array<string | undefined> = [];
      fixture.broker.execute = async (input) => {
        fixture.executions.push(input);
        try { await rename(foreground, `${foreground}-moved`); }
        catch (error) { renameFailures.push((error as NodeJS.ErrnoException).code); }
        return exited;
      };
      fixture.broker.spawn = async (input) => {
        fixture.spawns.push(input);
        try { await rename(background, `${background}-moved`); }
        catch (error) { renameFailures.push((error as NodeJS.ErrnoException).code); }
        return { id: "process", brokerInstanceId: "broker" };
      };
      const tools = registerBuiltinTools(new EffectToolRegistry(), { broker: fixture.broker });
      const foregroundCall = request("pinned-read-exec", "exec", {
        executable: process.execPath, cwd: "foreground"
      });
      const backgroundCall = request("pinned-read-spawn", "process_spawn", {
        executable: process.execPath, cwd: "background"
      });
      await tools.prepare(foregroundCall, preparation(workspace));
      await tools.prepare(backgroundCall, preparation(workspace));

      await expect(tools.execute(foregroundCall, execution(workspace)))
        .resolves.toMatchObject({ ok: true });
      await expect(tools.execute(backgroundCall, execution(workspace)))
        .resolves.toMatchObject({ ok: true });
      expect(renameFailures).toHaveLength(2);
      expect(renameFailures).toEqual(expect.arrayContaining([
        expect.stringMatching(/^(?:EACCES|EBUSY|EPERM)$/u),
        expect.stringMatching(/^(?:EACCES|EBUSY|EPERM)$/u)
      ]));
      await expect(rename(foreground, `${foreground}-moved`)).resolves.toBeUndefined();
      await expect(rename(background, `${background}-moved`)).resolves.toBeUndefined();
    }
  );

  it.runIf(process.platform === "win32")(
    "starts cmd shells in UTF-8 mode without weakening the existing invocation flags",
    async () => {
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
    }
  );
});
