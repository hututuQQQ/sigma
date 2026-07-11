import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type {
  BrokerDoctorReport,
  ExecutionBroker,
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
    content: Buffer.from(content)
  };
}

function broker(
  execution: ExecutionResult,
  poll: ProcessPollResult,
  released: string[][] = []
): ExecutionBroker {
  return {
    lostProcessHandles: [],
    connect: async () => report,
    doctor: async () => report,
    execute: async () => execution,
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
});
