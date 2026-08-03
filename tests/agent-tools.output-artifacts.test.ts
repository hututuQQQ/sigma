import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type {
  BrokerDoctorReport,
  ExecutionBroker,
  ExecutionRequest,
  ExecutionResult,
  ProcessOutputArtifact,
  ProcessPollResult
} from "../packages/agent-execution/src/index.js";
import type { ToolExecutionContext, ToolRequest } from "../packages/agent-protocol/src/index.js";
import { ContentAddressedArtifactStore } from "../packages/agent-store/src/index.js";
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

function outputArtifact(stream: "stdout" | "stderr", content: string): ProcessOutputArtifact {
  return {
    brokerArtifactId: `${stream}-broker-artifact`,
    name: `${stream}-full.log`,
    stream,
    brokerSha256: "a".repeat(64),
    sizeBytes: Buffer.byteLength(content),
    complete: true,
    redactionLossy: false,
    mediaType: "text/plain; charset=utf-8",
    content: Buffer.from(content)
  };
}

function broker(
  execution: ExecutionResult,
  poll: ProcessPollResult,
  released: string[][] = [],
  requests: ExecutionRequest[] = []
): ExecutionBroker {
  return {
    lostProcessHandles: [],
    connect: async () => report,
    doctor: async () => report,
    execute: async (input) => {
      requests.push(input);
      return execution;
    },
    spawn: async () => poll.handle,
    poll: async () => poll,
    write: async () => undefined,
    terminate: async () => poll,
    releaseOutputArtifacts: async (artifactIds) => { released.push([...artifactIds]); },
    close: async () => undefined
  };
}

async function fixtureContext(root: string): Promise<{
  context: ToolExecutionContext;
  artifacts: ContentAddressedArtifactStore;
}> {
  const artifacts = new ContentAddressedArtifactStore(root);
  return {
    artifacts,
    context: {
      sessionId: "session",
      runId: "run",
      workspacePath: root,
      runMode: "change",
      signal: new AbortController().signal,
      heartbeat: () => undefined,
      progress: async () => undefined,
      createArtifact: async ({ content }) => await artifacts.put("session", content)
    }
  };
}

function request(callId: string, name: string, argumentsValue: ToolRequest["arguments"]): ToolRequest {
  return { callId, name, arguments: argumentsValue };
}

describe("execution output artifact receipts", () => {
  it("uses the configured command timeout by default while preserving per-call overrides", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-command-timeout-"));
    const requests: ExecutionRequest[] = [];
    const execution: ExecutionResult = {
      state: "exited", exitCode: 0, signal: null, durationMs: 1,
      timedOut: false, idleTimedOut: false, cancelled: false,
      stdout: "", stderr: "", stdoutDroppedBytes: 0, stderrDroppedBytes: 0,
      outputTruncated: false, outputArtifacts: []
    };
    const poll: ProcessPollResult = {
      ...execution, state: "exited", handle: { id: "process", brokerInstanceId: "broker" }
    };
    const tools = executionTools({
      broker: broker(execution, poll, [], requests),
      sandboxMode: "required",
      networkMode: "none",
      commandTimeoutMs: 180_000
    });
    const exec = tools.find((tool) => tool.descriptor.name === "exec")!;
    const { context } = await fixtureContext(workspace);

    await exec.execute(request("configured-timeout", "exec", {
      executable: process.execPath
    }), context);
    await exec.execute(request("explicit-timeout", "exec", {
      executable: process.execPath,
      timeoutMs: 300_000
    }), context);

    expect(requests.map((item) => ({
      timeoutMs: item.timeoutMs,
      idleTimeoutMs: item.idleTimeoutMs
    }))).toEqual([
      { timeoutMs: 180_000, idleTimeoutMs: 120_000 },
      { timeoutMs: 300_000, idleTimeoutMs: 120_000 }
    ]);
    expect(exec.descriptor.inputSchema).toMatchObject({
      properties: {
        timeoutMs: { default: 180_000, maximum: 600_000 }
      }
    });
  });

  it("projects each foreground stream to 16 KiB and preserves the complete output", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-model-output-limit-"));
    const stdout = `${"H".repeat(8_192)}${"M".repeat(5_000)}${"T".repeat(8_192)}`;
    const execution: ExecutionResult = {
      state: "exited", exitCode: 0, signal: null, durationMs: 1,
      timedOut: false, idleTimedOut: false, cancelled: false,
      stdout, stderr: "", stdoutDroppedBytes: 0, stderrDroppedBytes: 0,
      outputTruncated: false, outputArtifacts: []
    };
    const poll: ProcessPollResult = {
      ...execution, state: "exited", handle: { id: "process", brokerInstanceId: "broker" }
    };
    const tools = executionTools({
      broker: broker(execution, poll), sandboxMode: "required", networkMode: "none"
    });
    const { context, artifacts } = await fixtureContext(workspace);
    const receipt = await tools.find((tool) => tool.descriptor.name === "exec")!.execute(
      request("bounded-output", "exec", { executable: process.execPath }), context
    );

    expect(Buffer.byteLength(receipt.output, "utf8")).toBeLessThanOrEqual(16 * 1024);
    expect(receipt.output).toBe(`${"H".repeat(8_192)}${"T".repeat(8_192)}`);
    expect(receipt.output).not.toContain("M");
    expect(receipt.artifacts).toHaveLength(1);
    expect(await artifacts.get("session", receipt.artifacts[0]!)).toEqual(Buffer.from(stdout));
    expect(receipt.diagnostics).toContain("model_output_truncated:stdout:5000");
  });

  it("runs unified shell validation and records the target command exit code", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-shell-validation-"));
    const execution: ExecutionResult = {
      state: "exited", exitCode: 7, signal: null, durationMs: 2,
      timedOut: false, idleTimedOut: false, cancelled: false,
      stdout: "", stderr: "target failed", stdoutDroppedBytes: 0, stderrDroppedBytes: 0,
      outputTruncated: false, outputArtifacts: []
    };
    const poll: ProcessPollResult = {
      ...execution, state: "exited", handle: { id: "process", brokerInstanceId: "broker" }
    };
    const tools = executionTools({
      broker: broker(execution, poll), sandboxMode: "required", networkMode: "none", shells: ["bash"]
    });
    const shell = tools.find((tool) => tool.descriptor.name === "shell")!;
    const { context } = await fixtureContext(workspace);
    const receipt = await shell.execute(request("shell-validation", "shell", {
      shell: "bash", command: "run-the-real-tests --strict", validation: true
    }), context);

    expect(shell.descriptor.inputSchema).toMatchObject({ oneOf: expect.any(Array) });
    expect(receipt).toMatchObject({
      ok: true,
      result: { exitCode: 7, commandStatus: "failed" },
      outcome: { status: "succeeded" }
    });
    expect(receipt.evidence).toEqual([expect.objectContaining({
      kind: "validation",
      status: "failed",
      data: expect.objectContaining({ command: "run-the-real-tests --strict", exitCode: 7 })
    })]);
  });

  it("binds foreground overflow CAS objects to validation evidence", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-output-receipt-"));
    const fullOutput = "complete redacted validation output\n";
    const artifact = outputArtifact("stdout", fullOutput);
    const execution: ExecutionResult = {
      state: "exited",
      exitCode: 0,
      signal: null,
      durationMs: 10,
      timedOut: false,
      idleTimedOut: false,
      cancelled: false,
      stdout: "bounded tail",
      stderr: "",
      stdoutDroppedBytes: 100,
      stderrDroppedBytes: 0,
      outputTruncated: true,
      outputArtifacts: [artifact]
    };
    const poll: ProcessPollResult = {
      ...execution,
      handle: { id: "process", brokerInstanceId: "broker" },
      state: "exited"
    };
    const released: string[][] = [];
    const tools = executionTools({ broker: broker(execution, poll, released), sandboxMode: "required", networkMode: "none" });
    const validate = tools.find((tool) => tool.descriptor.name === "validate")!;
    const { context, artifacts } = await fixtureContext(workspace);
    const receipt = await validate.execute(request("validate-call", "validate", {
      executable: process.execPath
    }), context);

    expect(receipt.output).toBe("bounded tail");
    expect(receipt.artifacts).toHaveLength(1);
    expect(receipt.artifactRefs).toEqual([expect.objectContaining({
      artifactId: receipt.artifacts[0], name: "stdout-full.log", sizeBytes: Buffer.byteLength(fullOutput)
    })]);
    expect(receipt.evidence).toEqual([expect.objectContaining({
      kind: "validation",
      data: expect.objectContaining({ artifactIds: receipt.artifacts })
    })]);
    expect(await artifacts.get("session", receipt.artifacts[0]!)).toEqual(Buffer.from(fullOutput));
    expect(receipt.diagnostics).toContain(`full_output_artifact:stdout:${receipt.artifacts[0]}`);
    expect(released).toEqual([[artifact.brokerArtifactId]]);

    const exec = tools.find((tool) => tool.descriptor.name === "exec")!;
    const commandReceipt = await exec.execute(request("exec-call", "exec", {
      executable: process.execPath
    }), context);
    expect(commandReceipt.evidence).toEqual([expect.objectContaining({
      kind: "command",
      data: expect.objectContaining({
        artifactIds: commandReceipt.artifacts,
        stdoutArtifactId: commandReceipt.artifacts[0]
      })
    })]);
    expect(released).toEqual([[artifact.brokerArtifactId], [artifact.brokerArtifactId]]);
  });

  it("keeps a successful command successful when stdout is non-text", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-binary-output-receipt-"));
    const bytes = Buffer.from([0xff, 0x00, 0x41, 0x80]);
    const artifact: ProcessOutputArtifact = {
      brokerArtifactId: "stdout-binary",
      name: "stdout-binary.log",
      stream: "stdout",
      brokerSha256: "b".repeat(64),
      sizeBytes: bytes.byteLength,
      complete: true,
      redactionLossy: false,
      mediaType: "application/octet-stream",
      content: bytes
    };
    const execution: ExecutionResult = {
      state: "exited", exitCode: 0, signal: null, durationMs: 1,
      timedOut: false, idleTimedOut: false, cancelled: false,
      stdout: "[NON_TEXT_STDOUT preserved]", stderr: "",
      stdoutDroppedBytes: 0, stderrDroppedBytes: 0,
      outputTruncated: true,
      outputArtifacts: [artifact],
      outputDecodingErrors: [{
        stream: "stdout",
        code: "invalid_output_encoding",
        message: "not UTF-8"
      }]
    };
    const poll: ProcessPollResult = {
      ...execution, state: "exited",
      handle: { id: "process", brokerInstanceId: "broker" }
    };
    const released: string[][] = [];
    const tools = executionTools({
      broker: broker(execution, poll, released),
      sandboxMode: "required",
      networkMode: "none"
    });
    const { context, artifacts } = await fixtureContext(workspace);
    const receipt = await tools.find((tool) => tool.descriptor.name === "exec")!.execute(
      request("binary-output", "exec", { executable: process.execPath }),
      context
    );

    expect(receipt.ok).toBe(true);
    expect(receipt.output).toContain("NON_TEXT_STDOUT");
    expect(receipt.diagnostics).toContain("invalid_output_encoding:stdout");
    expect(receipt.artifactRefs).toEqual([expect.objectContaining({
      mediaType: "application/octet-stream"
    })]);
    expect(await artifacts.get("session", receipt.artifacts[0]!)).toEqual(bytes);
    expect(released).toEqual([["stdout-binary"]]);
  });

  it("keeps background poll overflow auditable without embedding full bytes", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-poll-receipt-"));
    const fullOutput = "complete redacted background stderr\n";
    const artifact = outputArtifact("stderr", fullOutput);
    const execution: ExecutionResult = {
      state: "exited", exitCode: 0, signal: null, durationMs: 5,
      timedOut: false, idleTimedOut: false, cancelled: false,
      stdout: "", stderr: "tail", stdoutDroppedBytes: 0, stderrDroppedBytes: 50,
      outputTruncated: true, outputArtifacts: [artifact]
    };
    const poll: ProcessPollResult = {
      handle: { id: "process", brokerInstanceId: "broker" },
      state: "exited", exitCode: 0, signal: null, durationMs: 5,
      stdout: "", stderr: "tail", stdoutDroppedBytes: 0, stderrDroppedBytes: 50,
      outputTruncated: true, outputArtifacts: [artifact]
    };
    const released: string[][] = [];
    const tools = executionTools({ broker: broker(execution, poll, released), sandboxMode: "required", networkMode: "none" });
    const processPoll = tools.find((tool) => tool.descriptor.name === "process_poll")!;
    const { context, artifacts } = await fixtureContext(workspace);
    const receipt = await processPoll.execute(request("poll-call", "process_poll", {
      handleId: "process", brokerInstanceId: "broker"
    }), context);

    expect(receipt.output).not.toContain(fullOutput);
    expect(receipt.output).toContain("stderr-full.log");
    expect(receipt.artifacts).toHaveLength(1);
    expect(receipt.evidence).toEqual([expect.objectContaining({
      kind: "diagnostic",
      data: expect.objectContaining({ source: "sigma-exec" })
    })]);
    expect(await artifacts.get("session", receipt.artifacts[0]!)).toEqual(Buffer.from(fullOutput));
    expect(released).toEqual([[artifact.brokerArtifactId]]);
  });

  it("reports a background process non-zero exit as a delivered poll result", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-poll-exit-"));
    const execution: ExecutionResult = {
      state: "exited", exitCode: 1, signal: null, durationMs: 5,
      timedOut: false, idleTimedOut: false, cancelled: false,
      stdout: "", stderr: "listen EACCES", stdoutDroppedBytes: 0, stderrDroppedBytes: 0,
      outputTruncated: false
    };
    const poll: ProcessPollResult = {
      handle: { id: "process", brokerInstanceId: "broker" },
      state: "exited", exitCode: 1, signal: null, durationMs: 5,
      stdout: "", stderr: "listen EACCES", stdoutDroppedBytes: 0, stderrDroppedBytes: 0,
      outputTruncated: false
    };
    const tools = executionTools({
      broker: broker(execution, poll), sandboxMode: "required", networkMode: "none"
    });
    const { context } = await fixtureContext(workspace);

    const receipt = await tools.find((tool) => tool.descriptor.name === "process_poll")!.execute(
      request("failed-poll", "process_poll", { handleId: "process", brokerInstanceId: "broker" }),
      context
    );

    expect(receipt).toMatchObject({ ok: true });
    expect(receipt.diagnostics).toContain("process_exit_nonzero:1");
    expect(receipt.output).toContain("listen EACCES");
  });

  it("does not acknowledge the broker spool before durable CAS import succeeds", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-output-cas-failure-"));
    const artifact = outputArtifact("stdout", "full output");
    const execution: ExecutionResult = {
      state: "exited", exitCode: 0, signal: null, durationMs: 1,
      timedOut: false, idleTimedOut: false, cancelled: false,
      stdout: "tail", stderr: "", stdoutDroppedBytes: 1, stderrDroppedBytes: 0,
      outputTruncated: true, outputArtifacts: [artifact]
    };
    const poll: ProcessPollResult = {
      ...execution, state: "exited", handle: { id: "process", brokerInstanceId: "broker" }
    };
    const released: string[][] = [];
    const tools = executionTools({
      broker: broker(execution, poll, released), sandboxMode: "required", networkMode: "none"
    });
    const validate = tools.find((tool) => tool.descriptor.name === "validate")!;
    const { context } = await fixtureContext(workspace);
    context.createArtifact = async () => { throw new Error("injected CAS failure"); };
    await expect(validate.execute(request("cas-failure", "validate", {
      executable: process.execPath
    }), context)).rejects.toThrow("injected CAS failure");
    expect(released).toEqual([]);
  });

  it("never marks a timed-out zero-exit validation as passed evidence", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-timeout-evidence-"));
    const execution: ExecutionResult = {
      state: "terminated", exitCode: 0, signal: null, durationMs: 100,
      timedOut: true, idleTimedOut: false, cancelled: false,
      stdout: "", stderr: "", stdoutDroppedBytes: 0, stderrDroppedBytes: 0,
      outputTruncated: false, outputArtifacts: []
    };
    const poll: ProcessPollResult = {
      ...execution,
      state: "terminated",
      handle: { id: "process", brokerInstanceId: "broker" }
    };
    const tools = executionTools({
      broker: broker(execution, poll), sandboxMode: "required", networkMode: "none"
    });
    const { context } = await fixtureContext(workspace);
    const receipt = await tools.find((tool) => tool.descriptor.name === "validate")!.execute(
      request("timed-out-validation", "validate", { executable: process.execPath }),
      context
    );

    expect(receipt).toMatchObject({
      ok: false,
      result: { exitCode: 0, commandStatus: "failed" },
      outcome: { status: "failed" }
    });
    expect(receipt.diagnostics).toContain("process_timed_out");
    expect(receipt.evidence).toEqual([expect.objectContaining({
      kind: "validation",
      status: "failed",
      data: expect.objectContaining({
        exitCode: 0,
        termination: expect.objectContaining({
          processStarted: true,
          state: "terminated",
          timedOut: true
        })
      })
    })]);
  });

  it("records a completed non-zero validation with exact failed termination evidence", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-failed-validation-evidence-"));
    const execution: ExecutionResult = {
      state: "exited", exitCode: 1, signal: null, durationMs: 12,
      timedOut: false, idleTimedOut: false, cancelled: false,
      stdout: "", stderr: "test failed", stdoutDroppedBytes: 0, stderrDroppedBytes: 0,
      outputTruncated: false, outputArtifacts: []
    };
    const poll: ProcessPollResult = {
      ...execution,
      handle: { id: "process", brokerInstanceId: "broker" },
      state: "exited"
    };
    const tools = executionTools({
      broker: broker(execution, poll), sandboxMode: "required", networkMode: "none"
    });
    const { context } = await fixtureContext(workspace);
    const receipt = await tools.find((tool) => tool.descriptor.name === "validate")!.execute(
      request("failed-validation", "validate", { executable: process.execPath }),
      context
    );

    expect(receipt).toMatchObject({
      ok: true,
      result: { exitCode: 1, commandStatus: "failed" }
    });
    expect(receipt.evidence).toEqual([expect.objectContaining({
      kind: "validation",
      status: "failed",
      data: expect.objectContaining({
        command: expect.any(String),
        exitCode: 1,
        termination: {
          processStarted: true,
          state: "exited",
          exitCode: 1,
          signal: null,
          timedOut: false,
          idleTimedOut: false,
          cancelled: false
        },
        frontierRevision: 0,
        stateDigest: "0".repeat(64),
        coveredPaths: []
      })
    })]);
  });

  it("keeps application dependency diagnostics out of infrastructure fail-fast", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-missing-dependency-"));
    const execution: ExecutionResult = {
      state: "exited", exitCode: 1, signal: null, durationMs: 8,
      timedOut: false, idleTimedOut: false, cancelled: false,
      stdout: "", stderr: "ModuleNotFoundError: No module named 'example_dependency'",
      stdoutDroppedBytes: 0, stderrDroppedBytes: 0,
      outputTruncated: false, outputArtifacts: []
    };
    const poll: ProcessPollResult = {
      ...execution,
      handle: { id: "process", brokerInstanceId: "broker" },
      state: "exited"
    };
    const tools = executionTools({
      broker: broker(execution, poll), sandboxMode: "required", networkMode: "none"
    });
    const { context } = await fixtureContext(workspace);
    const receipt = await tools.find((tool) => tool.descriptor.name === "exec")!.execute(
      request("missing-dependency", "exec", { executable: process.execPath }),
      context
    );

    expect(receipt).toMatchObject({
      ok: true,
      result: { exitCode: 1, commandStatus: "failed" }
    });
    expect(receipt.diagnostics).toContain("command_dependency_missing");
    expect(receipt.diagnostics).not.toContain("dependency_missing");
  });

  it("turns a read-only filesystem failure into generic scoped-write guidance", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-readonly-command-"));
    const execution: ExecutionResult = {
      state: "exited", exitCode: 1, signal: null, durationMs: 8,
      timedOut: false, idleTimedOut: false, cancelled: false,
      stdout: "", stderr: "/usr/bin/ld: cannot open output file app: Read-only file system",
      stdoutDroppedBytes: 0, stderrDroppedBytes: 0,
      outputTruncated: false, outputArtifacts: []
    };
    const poll: ProcessPollResult = {
      ...execution,
      handle: { id: "process", brokerInstanceId: "broker" },
      state: "exited"
    };
    const tools = executionTools({
      broker: broker(execution, poll), sandboxMode: "required", networkMode: "none",
      shells: ["bash"]
    });
    const { context } = await fixtureContext(workspace);
    const shell = tools.find((tool) => tool.descriptor.name === "shell")!;
    const receipt = await shell.execute(
      request("readonly-command", "shell", { command: "compile project" }),
      context
    );

    expect(receipt).toMatchObject({
      ok: true,
      result: { exitCode: 1, commandStatus: "failed" }
    });
    expect(receipt.diagnostics).toContain("command_readonly_filesystem");
    expect(receipt.output).toContain("re-run with expectedChanges");
    expect(receipt.output).toContain("process temp directory");
  });

  it("does not mislabel a read-only external filesystem as missing workspace scope", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-scoped-command-"));
    const execution: ExecutionResult = {
      state: "exited", exitCode: 1, signal: null, durationMs: 8,
      timedOut: false, idleTimedOut: false, cancelled: false,
      stdout: "", stderr: "cannot update system mount: Read-only file system",
      stdoutDroppedBytes: 0, stderrDroppedBytes: 0,
      outputTruncated: false, outputArtifacts: []
    };
    const poll: ProcessPollResult = {
      ...execution,
      handle: { id: "process", brokerInstanceId: "broker" },
      state: "exited"
    };
    const tools = executionTools({
      broker: broker(execution, poll), sandboxMode: "required", networkMode: "none",
      shells: ["bash"]
    });
    const { context } = await fixtureContext(workspace);
    const shell = tools.find((tool) => tool.descriptor.name === "shell")!;
    const call = request("scoped-command", "shell", {
      command: "compile project",
      expectedChanges: ["app"]
    });
    const callPlan = await shell.descriptor.prepare!(call.arguments, context);
    const receipt = await shell.execute(call, { ...context, callPlan });

    expect(receipt).toMatchObject({
      ok: true,
      result: { exitCode: 1, commandStatus: "failed" }
    });
    expect(receipt.diagnostics).not.toContain("command_readonly_filesystem");
    expect(receipt.output).not.toContain("re-run with expectedChanges");
  });

  it("preserves authenticated sandbox launch failures as stable diagnostics", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-launch-failure-receipt-"));
    const failure = {
      phase: "sandbox_launch" as const,
      code: "sandbox_reparse_target_unresolvable",
      message: "cannot resolve a declared read root"
    };
    const execution: ExecutionResult = {
      state: "exited", exitCode: 125, signal: null, durationMs: 5,
      timedOut: false, idleTimedOut: false, cancelled: false,
      stdout: "", stderr: failure.message,
      stdoutDroppedBytes: 0, stderrDroppedBytes: 0, outputTruncated: false,
      failure
    };
    const poll: ProcessPollResult = {
      ...execution,
      state: "exited",
      handle: { id: "process", brokerInstanceId: "broker" }
    };
    const tools = executionTools({ broker: broker(execution, poll), sandboxMode: "required", networkMode: "none" });
    const { context } = await fixtureContext(workspace);

    const foreground = await tools.find((tool) => tool.descriptor.name === "exec")!.execute(
      request("failed-exec", "exec", { executable: process.execPath }),
      context
    );
    expect(foreground).toMatchObject({ ok: false });
    expect(foreground.diagnostics).toContain(failure.code);

    const validation = await tools.find((tool) => tool.descriptor.name === "validate")!.execute(
      request("failed-validation-launch", "validate", { executable: process.execPath }),
      context
    );
    expect(validation.evidence).toEqual([expect.objectContaining({
      kind: "validation",
      status: "failed",
      data: expect.objectContaining({
        termination: expect.objectContaining({
          processStarted: false,
          failureCode: failure.code
        })
      })
    })]);

    const background = await tools.find((tool) => tool.descriptor.name === "process_poll")!.execute(
      request("failed-poll", "process_poll", { handleId: "process", brokerInstanceId: "broker" }),
      context
    );
    expect(background).toMatchObject({ ok: false });
    expect(background.diagnostics).toContain(failure.code);
  });
});
