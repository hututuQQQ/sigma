import type {
  ExecutionBroker,
  ProcessHandle,
  ProcessPollResult
} from "agent-execution";
import { describe, expect, it, vi } from "vitest";
import {
  pollProcessUntilYield,
  processYieldMs
} from "../packages/agent-tools/src/process-wait.js";

const handle: ProcessHandle = {
  id: "process-1",
  brokerInstanceId: "broker-1"
};

function result(
  state: ProcessPollResult["state"],
  stdout = ""
): ProcessPollResult {
  return {
    handle,
    state,
    exitCode: state === "exited" ? 0 : null,
    signal: null,
    durationMs: 1,
    stdout,
    stderr: "",
    stdoutDroppedBytes: 0,
    stderrDroppedBytes: 0,
    outputTruncated: false
  };
}

function brokerWithPoll(poll: ExecutionBroker["poll"]): ExecutionBroker {
  const unavailable = async (): Promise<never> =>
    await Promise.reject(new Error("unused"));
  return {
    lostProcessHandles: [],
    connect: unavailable,
    doctor: unavailable,
    execute: unavailable,
    spawn: unavailable,
    poll,
    write: unavailable,
    terminate: unavailable,
    close: async () => undefined
  };
}

describe("bounded process waiting", () => {
  it("absorbs a short process into one execution turn and merges incremental output", async () => {
    const poll = vi.fn()
      .mockResolvedValueOnce(result("running", "starting\n"))
      .mockResolvedValueOnce(result("exited", "done\n"));

    const observed = await pollProcessUntilYield(
      brokerWithPoll(poll),
      handle,
      1_000,
      new AbortController().signal,
      false
    );

    expect(observed).toMatchObject({
      state: "exited",
      exitCode: 0,
      stdout: "starting\ndone\n"
    });
    expect(poll).toHaveBeenCalledTimes(2);
  });

  it("returns as soon as an explicit poll observes output", async () => {
    const poll = vi.fn(async () => result("running", "ready\n"));

    const observed = await pollProcessUntilYield(
      brokerWithPoll(poll),
      handle,
      1_000,
      new AbortController().signal,
      true
    );

    expect(observed.state).toBe("running");
    expect(observed.stdout).toBe("ready\n");
    expect(poll).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid wait budgets before broker execution", () => {
    expect(() => processYieldMs({ yieldMs: -1 }, 5_000))
      .toThrow("yieldMs must be an integer");
    expect(() => processYieldMs({ yieldMs: 30_001 }, 5_000))
      .toThrow("yieldMs must be an integer");
  });
});
