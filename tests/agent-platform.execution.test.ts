import { describe, expect, it } from "vitest";
import type { ExecutionRequest, ExecutionResult } from "../packages/agent-execution/src/index.js";
import {
  ProcessExecutionUnavailableError,
  runProcess,
  shellInvocation,
  type ProcessExecutionPort,
  type ProcessRequest
} from "../packages/agent-platform/src/index.js";

function executionResult(overrides: Partial<ExecutionResult> = {}): ExecutionResult {
  return {
    state: "exited",
    exitCode: 0,
    signal: null,
    durationMs: 5,
    stdout: "one\ntwo\nthree\n",
    stderr: "",
    stdoutDroppedBytes: 0,
    stderrDroppedBytes: 0,
    outputTruncated: false,
    timedOut: false,
    idleTimedOut: false,
    cancelled: false,
    ...overrides
  };
}

describe("agent-platform execution boundary", () => {
  it("fails closed without an injected execution port", async () => {
    const request = {
      executable: "tool",
      args: [],
      cwd: process.cwd(),
      timeoutMs: 100,
      signal: new AbortController().signal
    } as ProcessRequest;
    await expect(runProcess(request)).rejects.toBeInstanceOf(ProcessExecutionUnavailableError);
  });

  it("maps legacy process requests to a required broker policy", async () => {
    let captured: ExecutionRequest | undefined;
    const execution: ProcessExecutionPort = {
      execute: async (request) => {
        captured = request;
        return executionResult({ idleTimedOut: true });
      }
    };
    const result = await runProcess({
      execution,
      executable: "tool",
      args: ["arg"],
      cwd: process.cwd(),
      env: { SAFE_VALUE: "yes" },
      timeoutMs: 1_000,
      maxStdoutLines: 2,
      signal: new AbortController().signal,
      readRoots: [process.cwd()],
      writeRoots: []
    });
    expect(captured).toMatchObject({
      command: { executable: "tool", args: ["arg"], environment: { overrides: { SAFE_VALUE: "yes" } } },
      policy: { sandbox: "required", network: "none", readRoots: [process.cwd()], writeRoots: [] }
    });
    expect(result).toMatchObject({
      stdout: "one\ntwo\n",
      stdoutLimitReached: true,
      outputTruncated: true,
      timedOut: true
    });
  });

  it("constructs shell invocations without enabling a shell on the broker", () => {
    expect(shellInvocation("cmd", "echo ok")).toEqual({
      executable: "cmd.exe", args: ["/d", "/s", "/c", "echo ok"]
    });
    expect(shellInvocation("bash", "echo ok")).toEqual({ executable: "bash", args: ["-lc", "echo ok"] });
  });
});
