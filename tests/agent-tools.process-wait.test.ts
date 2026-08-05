import type {
  ExecutionBroker,
  ProcessHandle,
  ProcessPollResult
} from "agent-execution";
import { describe, expect, it, vi } from "vitest";
import {
  MAXIMUM_PROCESS_POLL_YIELD_MS,
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
      new AbortController().signal
    );

    expect(observed).toMatchObject({
      state: "exited",
      exitCode: 0,
      stdout: "starting\ndone\n"
    });
    expect(poll).toHaveBeenCalledTimes(2);
  });

  it("keeps an explicit poll open through incremental output until completion", async () => {
    const poll = vi.fn()
      .mockResolvedValueOnce(result("running", "ready\n"))
      .mockResolvedValueOnce(result("exited", "done\n"));

    const observed = await pollProcessUntilYield(
      brokerWithPoll(poll),
      handle,
      1_000,
      new AbortController().signal
    );

    expect(observed.state).toBe("exited");
    expect(observed.stdout).toBe("ready\ndone\n");
    expect(poll).toHaveBeenCalledTimes(2);
  });

  it("rejects invalid wait budgets before broker execution", () => {
    expect(() => processYieldMs({ yieldMs: -1 }, 5_000))
      .toThrow("yieldMs must be an integer");
    expect(() => processYieldMs({ yieldMs: 30_001 }, 5_000))
      .toThrow("yieldMs must be an integer");
    expect(processYieldMs(
      { yieldMs: MAXIMUM_PROCESS_POLL_YIELD_MS },
      5_000,
      MAXIMUM_PROCESS_POLL_YIELD_MS
    )).toBe(MAXIMUM_PROCESS_POLL_YIELD_MS);
    expect(() => processYieldMs(
      { yieldMs: MAXIMUM_PROCESS_POLL_YIELD_MS + 1 },
      5_000,
      MAXIMUM_PROCESS_POLL_YIELD_MS
    )).toThrow("yieldMs must be an integer");
  });
});
