import { describe, expect, it } from "vitest";
import {
  BrokerConnectionError,
  BrokerProcessLostError,
  BrokerProtocolError,
  LazyExecutionBroker,
  markBrokerGenerationTerminal,
  type BrokerDoctorReport,
  type ExecutionBroker,
  type ExecutionRequest,
  type ExecutionResult,
  type ProcessHandle,
  type ProcessPollResult,
  type ProcessSpawnRequest
} from "../packages/agent-execution/src/index.js";

const doctorReport: BrokerDoctorReport = {
  protocolVersion: 1,
  brokerVersion: "collision-fixture",
  platform: process.platform,
  architecture: process.arch,
  sandbox: {
    available: true,
    backend: "collision-fixture",
    selfTestPassed: true,
    setupRequired: false
  },
  capabilities: {
    foreground: true,
    background: true,
    stdin: true,
    pty: false,
    networkModes: ["none"]
  }
};

const executionResult: ExecutionResult = {
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
  outputTruncated: false
};

const nativeCollision: ProcessHandle = {
  id: "native-process",
  brokerInstanceId: "reused-native-instance",
  systemProcessId: 4242
};

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => { resolve = innerResolve; });
  return { promise, resolve };
}

function pollResult(state: "running" | "exited"): ProcessPollResult {
  return {
    handle: nativeCollision,
    state,
    exitCode: state === "running" ? null : 0,
    signal: null,
    durationMs: 1,
    stdout: "",
    stderr: "",
    stdoutDroppedBytes: 0,
    stderrDroppedBytes: 0,
    outputTruncated: false
  };
}

class CollidingHandleBroker implements ExecutionBroker {
  readonly lostProcessHandles: readonly ProcessHandle[] = [];
  readonly polled: ProcessHandle[] = [];
  readonly written: ProcessHandle[] = [];
  readonly terminated: ProcessHandle[] = [];
  pollGate?: Promise<ProcessPollResult>;
  pollFailure?: Error;
  releaseFailure?: Error;

  constructor(private readonly failExecution: boolean) {}

  async connect(): Promise<BrokerDoctorReport> { return doctorReport; }
  async doctor(): Promise<BrokerDoctorReport> { return doctorReport; }
  async execute(_request: ExecutionRequest): Promise<ExecutionResult> {
    if (this.failExecution) throw new BrokerConnectionError("generation disconnected");
    return executionResult;
  }
  async spawn(_request: ProcessSpawnRequest): Promise<ProcessHandle> {
    return { ...nativeCollision };
  }
  async poll(handle: ProcessHandle): Promise<ProcessPollResult> {
    this.polled.push(handle);
    if (this.pollFailure) throw this.pollFailure;
    return this.pollGate ? await this.pollGate : pollResult("running");
  }
  async write(handle: ProcessHandle, _data: string): Promise<void> {
    this.written.push(handle);
  }
  async terminate(handle: ProcessHandle): Promise<ProcessPollResult> {
    this.terminated.push(handle);
    return pollResult("exited");
  }
  async releaseOutputArtifacts(): Promise<void> {
    if (this.releaseFailure) throw this.releaseFailure;
  }
  async close(): Promise<void> {}
}

const spawnRequest = (): ProcessSpawnRequest => ({
  command: {
    executable: process.execPath,
    args: ["--version"],
    cwd: process.cwd()
  },
  policy: {
    sandbox: "required",
    network: "none",
    readRoots: [process.cwd()],
    writeRoots: [process.cwd()]
  }
});

describe("LazyExecutionBroker process-handle generations", () => {
  it("never aliases identical native tuples across broker generations", async () => {
    const stale = new CollidingHandleBroker(true);
    const current = new CollidingHandleBroker(false);
    const clients = [stale, current];
    let factoryCalls = 0;
    const broker = new LazyExecutionBroker({
      sandboxMode: "required",
      clientFactory: () => clients[factoryCalls++]!
    });

    const staleHandle = await broker.spawn(spawnRequest());
    expect(staleHandle).not.toMatchObject(nativeCollision);
    await expect(broker.execute({ ...spawnRequest(), timeoutMs: 100 }))
      .rejects.toBeInstanceOf(BrokerConnectionError);

    const currentHandle = await broker.spawn(spawnRequest());
    expect(currentHandle).not.toEqual(staleHandle);
    expect(currentHandle).not.toMatchObject(nativeCollision);
    expect(broker.lostProcessHandles).toContainEqual(staleHandle);

    await expect(broker.poll(staleHandle)).rejects.toBeInstanceOf(BrokerProcessLostError);
    await expect(broker.write(staleHandle, "input")).rejects.toBeInstanceOf(BrokerProcessLostError);
    await expect(broker.terminate(staleHandle)).rejects.toBeInstanceOf(BrokerProcessLostError);
    expect(current.polled).toEqual([]);
    expect(current.written).toEqual([]);
    expect(current.terminated).toEqual([]);

    await expect(broker.poll(currentHandle)).resolves.toMatchObject({
      handle: currentHandle,
      state: "running"
    });
    await expect(broker.write(currentHandle, "input")).resolves.toBeUndefined();
    await expect(broker.terminate(currentHandle)).resolves.toMatchObject({
      handle: currentHandle,
      state: "exited"
    });
    expect(current.polled).toEqual([nativeCollision]);
    expect(current.written).toEqual([nativeCollision]);
    expect(current.terminated).toEqual([nativeCollision]);

    await broker.close();
  });

  it("rejects an in-flight handle result when its generation retires first", async () => {
    const stale = new CollidingHandleBroker(true);
    const current = new CollidingHandleBroker(false);
    const gate = deferred<ProcessPollResult>();
    stale.pollGate = gate.promise;
    const clients = [stale, current];
    let factoryCalls = 0;
    const broker = new LazyExecutionBroker({
      sandboxMode: "required",
      clientFactory: () => clients[factoryCalls++]!
    });

    const handle = await broker.spawn(spawnRequest());
    const polling = broker.poll(handle);
    await expect.poll(() => stale.polled.length).toBe(1);
    await expect(broker.execute({ ...spawnRequest(), timeoutMs: 100 }))
      .rejects.toBeInstanceOf(BrokerConnectionError);
    gate.resolve(pollResult("exited"));

    await expect(polling).rejects.toBeInstanceOf(BrokerProcessLostError);
    expect(broker.lostProcessHandles).toContainEqual(handle);
    await broker.close();
  });

  it("retires a handle generation on a terminal non-connection failure", async () => {
    const stale = new CollidingHandleBroker(false);
    const current = new CollidingHandleBroker(false);
    const failure = markBrokerGenerationTerminal(new BrokerProtocolError("malformed poll result"));
    stale.pollFailure = failure;
    const clients = [stale, current];
    let factoryCalls = 0;
    const broker = new LazyExecutionBroker({
      sandboxMode: "required",
      clientFactory: () => clients[factoryCalls++]!
    });

    const handle = await broker.spawn(spawnRequest());
    const observed = await broker.poll(handle).catch((error: unknown) => error);
    expect(observed).toBe(failure);
    expect(broker.lostProcessHandles).toContainEqual(handle);
    await expect(broker.execute({ ...spawnRequest(), timeoutMs: 100 })).resolves.toBe(executionResult);
    expect(factoryCalls).toBe(2);
    await broker.close();
  });

  it("retires without replaying a terminal artifact acknowledgement failure", async () => {
    const stale = new CollidingHandleBroker(false);
    const current = new CollidingHandleBroker(false);
    const failure = markBrokerGenerationTerminal(new BrokerProtocolError("artifact receipt is untrusted"));
    stale.releaseFailure = failure;
    const clients = [stale, current];
    let factoryCalls = 0;
    const broker = new LazyExecutionBroker({
      sandboxMode: "required",
      clientFactory: () => clients[factoryCalls++]!
    });

    const observed = await broker.releaseOutputArtifacts(["artifact-1"])
      .catch((error: unknown) => error);
    expect(observed).toBe(failure);
    await expect(broker.execute({ ...spawnRequest(), timeoutMs: 100 })).resolves.toBe(executionResult);
    expect(factoryCalls).toBe(2);
    await broker.close();
  });
});
