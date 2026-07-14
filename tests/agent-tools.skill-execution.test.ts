import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type {
  BrokerDoctorReport,
  ExecutionBroker,
  ExecutionRequest,
  ExecutionResult,
  ProcessSpawnRequest
} from "../packages/agent-execution/src/index.js";
import type {
  RuntimeControlPort,
  ToolExecutionContext,
  ToolPreparationContext,
  ToolRequest
} from "../packages/agent-protocol/src/index.js";
import { executionTools } from "../packages/agent-tools/src/index.js";

const report: BrokerDoctorReport = {
  protocolVersion: 1,
  brokerVersion: "test",
  platform: process.platform,
  architecture: process.arch,
  sandbox: { available: true, backend: "test", selfTestPassed: true, setupRequired: false },
  capabilities: {
    foreground: true, background: true, stdin: true, pty: true, networkModes: ["none", "full"]
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

function request(name: string, argumentsValue: ToolRequest["arguments"]): ToolRequest {
  return { callId: `${name}-call`, name, arguments: argumentsValue };
}

function runtimeControl(
  resolver: RuntimeControlPort["resolveLoadedSkillResource"]
): RuntimeControlPort {
  return { resolveLoadedSkillResource: resolver } as RuntimeControlPort;
}

function preparation(workspacePath: string, control: RuntimeControlPort): ToolPreparationContext {
  return {
    sessionId: "session",
    runId: "run",
    workspacePath,
    runMode: "change",
    runtimeControl: control
  };
}

function execution(workspacePath: string, control: RuntimeControlPort): ToolExecutionContext {
  return {
    sessionId: "session",
    runId: "run",
    workspacePath,
    runMode: "change",
    signal: new AbortController().signal,
    heartbeat: () => undefined,
    progress: async () => undefined,
    createArtifact: async () => "artifact",
    runtimeControl: control
  };
}

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

describe("sandboxed skill resource execution", () => {
  it("pins the external resource for foreground execution and denies unsafe background leasing", async () => {
    const workspace = path.resolve(".");
    const skillRoot = await mkdtemp(path.join(os.tmpdir(), "sigma-test-skill-assets-"));
    const script = path.join(skillRoot, "scripts", "run.mjs");
    await mkdir(path.dirname(script), { recursive: true });
    await writeFile(script, "console.log('trusted');\n");
    const resolve = vi.fn<RuntimeControlPort["resolveLoadedSkillResource"]>(async () => ({
      qualifiedName: "home:runner",
      relativePath: "scripts/run.mjs",
      absolutePath: script,
      readRoot: skillRoot,
      digest: "a".repeat(64)
    }));
    const control = runtimeControl(resolve);
    const fixture = brokerFixture();
    const tools = executionTools({ broker: fixture.broker, sandboxMode: "unsafe", networkMode: "none" });
    const exec = tools.find((tool) => tool.descriptor.name === "exec")!;
    const spawn = tools.find((tool) => tool.descriptor.name === "process_spawn")!;
    const input = {
      executable: process.execPath,
      args: ["--flag"],
      skill: "home:runner",
      skillScript: "scripts/run.mjs"
    };

    try {
      await expect(exec.descriptor.prepare!(input, preparation(workspace, control))).resolves.toMatchObject({
        exactEffects: ["process.spawn.readonly", "filesystem.read"],
        readPaths: [".", skillRoot, script],
        writePaths: [],
        checkpointScope: []
      });
      await exec.execute(request("exec", input), execution(workspace, control));
      expect(fixture.executions).toEqual([expect.objectContaining({
        command: expect.objectContaining({ executable: process.execPath, args: [script, "--flag"], environment: undefined }),
        policy: expect.objectContaining({
          sandbox: "required",
          network: "none",
          readRoots: [workspace, skillRoot],
          writeRoots: [],
          protectedPaths: [path.join(workspace, ".git"), path.join(workspace, ".agent"), skillRoot],
          unsafeHostExecApproved: false
        })
      })]);

      await expect(spawn.descriptor.prepare!(input, preparation(workspace, control)))
        .rejects.toMatchObject({ code: "skill_execution_unavailable" });
      expect(fixture.spawns).toHaveLength(0);
      expect(resolve).toHaveBeenCalledWith(expect.objectContaining({
        qualifiedName: "home:runner",
        relativePath: "scripts/run.mjs"
      }));
    } finally {
      await rm(skillRoot, { recursive: true, force: true });
    }
  });

  it("does not reach the broker when the skill is unqualified, not loaded, escaping, or changed", async () => {
    const workspace = path.resolve(".");
    const fixture = brokerFixture();
    const tools = executionTools({ broker: fixture.broker, sandboxMode: "required", networkMode: "none" });
    const validate = tools.find((tool) => tool.descriptor.name === "validate")!;
    const invalid = runtimeControl(async () => { throw Object.assign(new Error("not loaded"), { code: "skill_not_loaded" }); });

    await expect(validate.descriptor.prepare!({
      executable: process.execPath,
      skill: "runner",
      skillScript: "scripts/run.mjs"
    }, preparation(workspace, invalid))).rejects.toMatchObject({ code: "skill_resource_invalid" });
    await expect(validate.descriptor.prepare!({
      executable: process.execPath,
      skill: "workspace:runner",
      skillScript: "scripts/run.mjs"
    }, preparation(workspace, invalid))).rejects.toMatchObject({ code: "skill_not_loaded" });

    for (const code of ["skill_resource_escape", "skill_changed"] as const) {
      const denied = runtimeControl(async () => { throw Object.assign(new Error(code), { code }); });
      await expect(validate.execute(request("validate", {
        executable: process.execPath,
        skill: "workspace:runner",
        skillScript: code === "skill_resource_escape" ? "../outside.mjs" : "scripts/run.mjs"
      }), execution(workspace, denied))).rejects.toMatchObject({ code });
    }
    expect(fixture.executions).toHaveLength(0);
  });

  it("revalidates the frozen resource identity after acquiring its path lease", async () => {
    const workspace = path.resolve(".");
    const skillRoot = await mkdtemp(path.join(os.tmpdir(), "sigma-skill-revalidation-"));
    const script = path.join(skillRoot, "scripts", "run.mjs");
    await mkdir(path.dirname(script), { recursive: true });
    await writeFile(script, "console.log('trusted');\n");
    let calls = 0;
    const control = runtimeControl(async () => ({
      qualifiedName: "home:runner",
      relativePath: "scripts/run.mjs",
      absolutePath: script,
      readRoot: skillRoot,
      digest: (calls++ === 0 ? "a" : "b").repeat(64)
    }));
    const fixture = brokerFixture();
    const exec = executionTools({
      broker: fixture.broker,
      sandboxMode: "required",
      networkMode: "none"
    }).find((tool) => tool.descriptor.name === "exec")!;
    try {
      await expect(exec.execute(request("exec", {
        executable: process.execPath,
        skill: "home:runner",
        skillScript: "scripts/run.mjs"
      }), execution(workspace, control))).rejects.toMatchObject({ code: "skill_resource_stale" });
      expect(fixture.executions).toHaveLength(0);
    } finally {
      await rm(skillRoot, { recursive: true, force: true });
    }
  });
});
