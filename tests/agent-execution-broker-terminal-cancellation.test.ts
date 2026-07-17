import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BrokerCancelledError,
  BrokerConnectionError,
  BrokerExecutableUnavailableError,
  BrokerProcessLostError,
  BrokerProtocolError,
  BrokerTimeoutError,
  LazyExecutionBroker,
  SigmaExecBrokerClient,
  type BrokerDoctorReport,
  type BrokerRequestOptions,
  type ExecutionBroker,
  type ExecutionRequest,
  type ExecutionResult,
  type ProcessHandle,
  type ProcessPollResult,
  type ProcessSpawnRequest,
  type SigmaExecBrokerClientOptions
} from "../packages/agent-execution/src/index.js";

const BROKER_LIFECYCLE_FIXTURE = String.raw`
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const mode = process.argv[1] || "normal";
const artifactRoot = path.resolve(process.argv[2]);
fs.mkdirSync(artifactRoot, { recursive: true });
let input = Buffer.alloc(0);
let pendingExec;
let writeCount = 0;
const send = value => {
  const body = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  process.stdout.write(Buffer.concat([header, body]));
};
const ok = (request, result) => send({
  protocolVersion: 1, requestId: request.requestId, ok: true, result
});
const fail = (request, code, message, data) => send({
  protocolVersion: 1, requestId: request.requestId, ok: false,
  error: { code, message, ...(data === undefined ? {} : { data }) }
});
const output = (data, nextOffset = Buffer.byteLength(data), droppedBytes = 0) => ({
  data, nextOffset, droppedBytes
});
const terminal = (state = "exited") => ({
  state, exitCode: 0, signal: state === "terminated" ? "SIGTERM" : null, durationMs: 5,
  stdout: output(""), stderr: output("")
});
const handle = request => {
  if (request.method === "hello") {
    ok(request, {
      protocolVersion: 1, instanceId: "broker-lifecycle-fixture", artifactRoot
    });
  } else if (request.method === "doctor") {
    ok(request, {
      protocolVersion: 1, brokerVersion: "fixture", platform: process.platform,
      architecture: process.arch,
      sandbox: {
        available: true, backend: "fixture", selfTestPassed: true, setupRequired: false
      },
      capabilities: {
        foreground: true, background: true, stdin: true, pty: false,
        networkModes: ["none"]
      }
    });
  } else if (request.method === "process.spawn") {
    fs.writeFileSync(path.join(artifactRoot, "spawn-received"), "yes");
    const respond = () => ok(request, { handleId: "fixture-process", processId: 4242 });
    if (mode === "terminate-fail") setTimeout(respond, 250); else respond();
  } else if (request.method === "process.poll") {
    ok(request, {
      state: "running", exitCode: null, signal: null, durationMs: 2,
      stdout: output(""), stderr: output("")
    });
  } else if (request.method === "process.terminate") {
    if (mode === "terminate-fail") fail(request, "terminate_failed", "termination rejected");
    else ok(request, terminal("terminated"));
  } else if (request.method === "process.release") {
    ok(request, {});
  } else if (request.method === "process.write") {
    writeCount += 1;
    fs.writeFileSync(path.join(artifactRoot, "write-received-" + writeCount), request.params.data);
    if (mode !== "hang-write") ok(request, {});
  } else if (request.method === "exec" && mode === "executable-unavailable") {
    fail(request, "executable_unavailable", "configured executable is unavailable", {
      executable: "missing-runtime"
    });
  } else if (request.method === "exec" && (mode === "hang" || mode === "cancel-artifact")) {
    pendingExec = request;
    fs.writeFileSync(path.join(artifactRoot, "exec-started"), "yes");
  } else if (request.method === "exec") {
    ok(request, {
      ...terminal(), timedOut: false, idleTimedOut: false, cancelled: false
    });
  } else if (request.method === "cancel") {
    ok(request, { cancelled: true });
    if (mode === "cancel-artifact" && pendingExec) {
      const target = pendingExec;
      pendingExec = undefined;
      const content = Buffer.from("complete cancelled stdout ending in tail", "utf8");
      const artifactPath = path.join(artifactRoot, "cancelled-stdout.log");
      fs.writeFileSync(artifactPath, content, { mode: 0o600 });
      setTimeout(() => ok(target, {
        ...terminal(),
        stdout: output("tail", content.length, content.length - Buffer.byteLength("tail")),
        outputArtifacts: [{
          artifactId: "cancelled-stdout", name: "cancelled-stdout.log", stream: "stdout",
          path: artifactPath,
          sha256: crypto.createHash("sha256").update(content).digest("hex"),
          sizeBytes: content.length, complete: true, redacted: true, redactionLossy: false
        }],
        timedOut: false, idleTimedOut: false, cancelled: true
      }), 10);
    }
  } else if (request.method === "artifact.release") {
    for (const artifactId of request.params.artifactIds || []) {
      if (artifactId === "cancelled-stdout") {
        fs.rmSync(path.join(artifactRoot, "cancelled-stdout.log"), { force: true });
        fs.writeFileSync(path.join(artifactRoot, "cancelled-artifact-released"), "yes");
      }
    }
    ok(request, { released: true });
  } else if (request.method === "shutdown") {
    ok(request, { shutdown: true });
    setTimeout(() => process.exit(0), 10);
  }
};
process.stdin.on("data", chunk => {
  input = Buffer.concat([input, chunk]);
  while (input.length >= 4) {
    const length = input.readUInt32BE(0);
    if (input.length < 4 + length) break;
    const request = JSON.parse(input.subarray(4, 4 + length).toString("utf8"));
    input = input.subarray(4 + length);
    handle(request);
  }
});
`;

function clientOptions(
  mode: "normal" | "hang" | "hang-write" | "cancel-artifact" | "executable-unavailable" | "terminate-fail",
  artifactRoot: string,
  extra: Partial<SigmaExecBrokerClientOptions> = {}
): SigmaExecBrokerClientOptions {
  return {
    helperPath: process.execPath,
    helperArgs: ["-e", BROKER_LIFECYCLE_FIXTURE, mode, artifactRoot],
    requestTimeoutMs: 1_000,
    shutdownGraceMs: 200,
    cancellationGraceMs: 100,
    trustedToolchains: [],
    ...extra
  };
}

function spawnRequest(): ProcessSpawnRequest {
  return {
    command: { executable: process.execPath, args: ["--version"], cwd: process.cwd() },
    policy: {
      sandbox: "required",
      network: "none",
      readRoots: [process.cwd()],
      writeRoots: [],
      executionRoots: [process.execPath]
    }
  };
}

function executionRequest(): ExecutionRequest {
  return { ...spawnRequest(), timeoutMs: 5_000 };
}

async function pathExists(filePath: string): Promise<boolean> {
  return await access(filePath).then(() => true, () => false);
}

function errorGraph(value: unknown, seen = new Set<unknown>()): unknown[] {
  if (value === undefined || value === null || seen.has(value)) return [];
  seen.add(value);
  if (!(value instanceof Error)) return [value];
  const nested = value instanceof AggregateError ? value.errors : [];
  return [value, ...nested.flatMap((entry) => errorGraph(entry, seen)), ...errorGraph(value.cause, seen)];
}

const healthyDoctor: BrokerDoctorReport = {
  protocolVersion: 1,
  brokerVersion: "fixture",
  platform: process.platform,
  architecture: process.arch,
  sandbox: { available: true, backend: "fixture", selfTestPassed: true, setupRequired: false },
  capabilities: {
    foreground: true, background: true, stdin: true, pty: false, networkModes: ["none"]
  }
};

const healthyExecution: ExecutionResult = {
  state: "exited", exitCode: 0, signal: null, durationMs: 1,
  timedOut: false, idleTimedOut: false, cancelled: false,
  stdout: "", stderr: "", stdoutDroppedBytes: 0, stderrDroppedBytes: 0,
  outputTruncated: false
};

interface BrokerHooks {
  connect(): Promise<BrokerDoctorReport>;
  execute(): Promise<ExecutionResult>;
  spawn(): Promise<ProcessHandle>;
  write(): Promise<void>;
  close(): Promise<void>;
}

function syntheticBroker(hooks: Partial<BrokerHooks> = {}): ExecutionBroker {
  return {
    lostProcessHandles: [],
    connect: async () => hooks.connect ? await hooks.connect() : healthyDoctor,
    doctor: async () => healthyDoctor,
    setupSandbox: async () => healthyDoctor,
    execute: async () => hooks.execute ? await hooks.execute() : healthyExecution,
    spawn: async () => hooks.spawn ? await hooks.spawn() : {
      id: "native-process", brokerInstanceId: "synthetic"
    },
    poll: async (handle): Promise<ProcessPollResult> => ({
      handle, state: "running", exitCode: null, signal: null, durationMs: 1,
      stdout: "", stderr: "", stdoutDroppedBytes: 0, stderrDroppedBytes: 0,
      outputTruncated: false
    }),
    write: async () => { await hooks.write?.(); },
    terminate: async (handle): Promise<ProcessPollResult> => ({
      handle, state: "terminated", exitCode: 0, signal: "SIGTERM", durationMs: 1,
      stdout: "", stderr: "", stdoutDroppedBytes: 0, stderrDroppedBytes: 0,
      outputTruncated: false
    }),
    releaseOutputArtifacts: async () => undefined,
    close: async () => { await hooks.close?.(); }
  };
}

describe("execution broker cancellation containment", () => {
  it("maps native executable availability failures to a stable error class", async () => {
    const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "sigma-exec-artifacts-executable-"));
    const client = new SigmaExecBrokerClient(clientOptions("executable-unavailable", artifactRoot));
    try {
      await client.connect();
      const failure = await client.execute(executionRequest()).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(BrokerExecutableUnavailableError);
      expect(failure).toMatchObject({
        code: "executable_unavailable",
        data: { executable: "missing-runtime" }
      });
    } finally {
      await client.close().catch(() => undefined);
      await rm(artifactRoot, { recursive: true, force: true });
    }
  });

  it("rejects an oversized local request without disrupting an active handle", async () => {
    const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "sigma-exec-artifacts-local-frame-"));
    const client = new SigmaExecBrokerClient(clientOptions("normal", artifactRoot, {
      maximumFrameBytes: 16 * 1024
    }));
    try {
      await client.connect();
      const handle = await client.spawn(spawnRequest());
      const request = executionRequest();

      await expect(client.execute({
        ...request,
        command: { ...request.command, args: ["x".repeat(32 * 1024)] }
      })).rejects.toBeInstanceOf(BrokerProtocolError);

      expect(client.lostProcessHandles).toEqual([]);
      await expect(client.doctor()).resolves.toMatchObject({ sandbox: { available: true } });
      await expect(client.poll(handle)).resolves.toMatchObject({ state: "running" });
      await expect(client.terminate(handle)).resolves.toMatchObject({ state: "terminated" });
    } finally {
      await client.close().catch(() => undefined);
      await rm(artifactRoot, { recursive: true, force: true });
    }
  });

  it("does not retire a healthy broker when a queued spawn times out before dispatch", async () => {
    const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "sigma-exec-artifacts-queued-spawn-"));
    const client = new SigmaExecBrokerClient(clientOptions("normal", artifactRoot));
    try {
      await client.connect();
      const handle = await client.spawn(spawnRequest());
      let releaseWrite!: () => void;
      const transport = (client as unknown as { transport: { writeChain: Promise<void> } }).transport;
      transport.writeChain = new Promise<void>((resolve) => { releaseWrite = resolve; });

      const failure = await client.spawn(spawnRequest(), { timeoutMs: 10 })
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(BrokerTimeoutError);
      expect(failure).toMatchObject({ code: "broker_timeout", preDispatch: true });
      expect(client.lostProcessHandles).toEqual([]);

      releaseWrite();
      await expect(client.doctor()).resolves.toMatchObject({ sandbox: { available: true } });
      await expect(client.poll(handle)).resolves.toMatchObject({ state: "running" });
      await expect(client.terminate(handle)).resolves.toMatchObject({ state: "terminated" });
    } finally {
      await client.close().catch(() => undefined);
      await rm(artifactRoot, { recursive: true, force: true });
    }
  });

  it("keeps a background handle usable when writes are cancelled before dispatch", async () => {
    const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "sigma-exec-artifacts-write-queued-"));
    const client = new SigmaExecBrokerClient(clientOptions("normal", artifactRoot));
    try {
      await client.connect();
      const handle = await client.spawn(spawnRequest());
      const transport = (client as unknown as {
        transport: { writeChain: Promise<void>; pending: Map<number, unknown> };
      }).transport;

      const initialReason = Object.assign(new Error("deadline before write"), { code: "process_deadline" });
      const initiallyCancelled = new AbortController();
      initiallyCancelled.abort(initialReason);
      const initialFailure = await client.write(handle, "never sent", {
        signal: initiallyCancelled.signal
      }).catch((error: unknown) => error);
      expect(initialFailure).toBeInstanceOf(BrokerCancelledError);
      expect(initialFailure).toMatchObject({
        code: "process_deadline", cause: initialReason, preDispatch: true
      });

      let releaseTimeout!: () => void;
      transport.writeChain = new Promise<void>((resolve) => { releaseTimeout = resolve; });
      const timedOut = client.write(handle, "also never sent", { timeoutMs: 50 });
      await expect.poll(() => transport.pending.size, { interval: 1, timeout: 40 }).toBe(1);
      const timeoutFailure = await timedOut.catch((error: unknown) => error);
      expect(timeoutFailure).toBeInstanceOf(BrokerTimeoutError);
      expect(timeoutFailure).toMatchObject({ code: "broker_timeout", preDispatch: true });
      releaseTimeout();
      await transport.writeChain;

      let releaseAbort!: () => void;
      transport.writeChain = new Promise<void>((resolve) => { releaseAbort = resolve; });
      const queuedController = new AbortController();
      const queued = client.write(handle, "still never sent", { signal: queuedController.signal });
      await expect.poll(() => transport.pending.size, { interval: 1, timeout: 40 }).toBe(1);
      const queuedReason = new Error("leave the queue");
      queuedController.abort(queuedReason);
      const queuedFailure = await queued.catch((error: unknown) => error);
      expect(queuedFailure).toBeInstanceOf(BrokerCancelledError);
      expect(queuedFailure).toMatchObject({
        code: "broker_cancelled", cause: queuedReason, preDispatch: true
      });
      releaseAbort();
      await transport.writeChain;

      expect(client.lostProcessHandles).toEqual([]);
      await expect(access(path.join(artifactRoot, "write-received-1"))).rejects.toThrow();
      await expect(client.doctor()).resolves.toMatchObject({ sandbox: { available: true } });
      await expect(client.poll(handle)).resolves.toMatchObject({ state: "running" });
      await expect(client.terminate(handle)).resolves.toMatchObject({ state: "terminated" });
    } finally {
      await client.close().catch(() => undefined);
      await rm(artifactRoot, { recursive: true, force: true });
    }
  });

  it.each(["abort", "timeout"] as const)(
    "retires and never replays a write after post-dispatch %s",
    async (kind) => {
      const staleRoot = await mkdtemp(path.join(os.tmpdir(), "sigma-exec-artifacts-write-stale-"));
      const freshRoot = await mkdtemp(path.join(os.tmpdir(), "sigma-exec-artifacts-write-fresh-"));
      const stale = new SigmaExecBrokerClient(clientOptions("hang-write", staleRoot));
      const fresh = new SigmaExecBrokerClient(clientOptions("normal", freshRoot));
      const clients = [stale, fresh];
      let factoryCalls = 0;
      const broker = new LazyExecutionBroker({
        sandboxMode: "required", allowUnsafeHostExec: false,
        clientFactory: () => clients[factoryCalls++]!
      });
      const transport = (stale as unknown as {
        transport: {
          request(method: string, params: Record<string, unknown>, options?: BrokerRequestOptions): Promise<unknown>;
        };
      }).transport;
      const request = transport.request.bind(transport);
      let transportFailure: unknown;
      transport.request = async (method, params, options) => {
        try { return await request(method, params, options); }
        catch (error) {
          if (method === "process.write") transportFailure = error;
          throw error;
        }
      };
      try {
        const handle = await broker.spawn(spawnRequest());
        const controller = new AbortController();
        const reason = Object.assign(new Error("write deadline"), { code: "process_deadline" });
        const write = broker.write(handle, "one dispatch only", {
          signal: controller.signal, timeoutMs: kind === "timeout" ? 50 : 5_000
        });
        await expect.poll(async () => await pathExists(path.join(staleRoot, "write-received-1"))).toBe(true);
        if (kind === "abort") controller.abort(reason);
        const failure = await write.catch((error: unknown) => error);

        expect(failure).toBe(transportFailure);
        if (kind === "abort") {
          expect(failure).toBeInstanceOf(BrokerCancelledError);
          expect(failure).toMatchObject({ code: "process_deadline", cause: reason, preDispatch: false });
        } else {
          expect(failure).toBeInstanceOf(BrokerTimeoutError);
          expect(failure).toMatchObject({ code: "broker_timeout", preDispatch: false });
        }
        expect(factoryCalls).toBe(2);
        expect(stale.lostProcessHandles).toEqual([
          expect.objectContaining({ id: "fixture-process" })
        ]);
        expect(broker.lostProcessHandles).toContainEqual(handle);
        await expect(broker.poll(handle)).rejects.toBeInstanceOf(BrokerProcessLostError);
        await expect(access(path.join(freshRoot, "write-received-1"))).rejects.toThrow();
        await expect(broker.doctor()).resolves.toMatchObject({ sandbox: { available: true } });
        await expect(access(path.join(freshRoot, "write-received-1"))).rejects.toThrow();
      } finally {
        await broker.close().catch(() => undefined);
        await rm(staleRoot, { recursive: true, force: true });
        await rm(freshRoot, { recursive: true, force: true });
      }
    }
  );

  it("preserves cancelled spawn identity when termination fails and retires the generation", async () => {
    const staleRoot = await mkdtemp(path.join(os.tmpdir(), "sigma-exec-artifacts-spawn-cancel-stale-"));
    const freshRoot = await mkdtemp(path.join(os.tmpdir(), "sigma-exec-artifacts-spawn-cancel-fresh-"));
    const stale = new SigmaExecBrokerClient(clientOptions("terminate-fail", staleRoot));
    const fresh = new SigmaExecBrokerClient(clientOptions("normal", freshRoot));
    const clients = [stale, fresh];
    let factoryCalls = 0;
    let clientFailure: unknown;
    const originalSpawn = stale.spawn.bind(stale);
    stale.spawn = async (request, options) => {
      try { return await originalSpawn(request, options); }
      catch (error) { clientFailure = error; throw error; }
    };
    const broker = new LazyExecutionBroker({
      sandboxMode: "required", allowUnsafeHostExec: false,
      clientFactory: () => clients[factoryCalls++]!
    });
    try {
      await broker.connect();
      const controller = new AbortController();
      const reason = Object.assign(new Error("replace this run"), { code: "steering_restart" });
      const spawning = broker.spawn(spawnRequest(), { signal: controller.signal });
      await expect.poll(async () => await pathExists(path.join(staleRoot, "spawn-received"))).toBe(true);
      controller.abort(reason);
      const failure = await spawning.catch((error: unknown) => error);

      expect(failure).toBe(clientFailure);
      expect(failure).toBeInstanceOf(BrokerCancelledError);
      expect(failure).toMatchObject({ code: "steering_restart" });
      const graph = errorGraph(failure);
      expect(graph).toContain(reason);
      expect(graph).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "terminate_failed" })
      ]));
      expect(factoryCalls).toBe(2);
      expect(stale.lostProcessHandles).toEqual([
        expect.objectContaining({ id: "fixture-process" })
      ]);
      await expect(access(path.join(freshRoot, "spawn-received"))).rejects.toThrow();
      await expect(broker.doctor()).resolves.toMatchObject({ sandbox: { available: true } });
      await expect(access(path.join(freshRoot, "spawn-received"))).rejects.toThrow();
    } finally {
      await broker.close().catch(() => undefined);
      await rm(staleRoot, { recursive: true, force: true });
      await rm(freshRoot, { recursive: true, force: true });
    }
  });

  it("preserves cancelled spawn identity when termination and containment both fail", async () => {
    const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "sigma-exec-artifacts-spawn-close-fail-"));
    const client = new SigmaExecBrokerClient(clientOptions("terminate-fail", artifactRoot));
    const transport = (client as unknown as {
      transport: { waitForChildClose(...args: unknown[]): Promise<boolean> };
    }).transport;
    const waitForChildClose = transport.waitForChildClose.bind(transport);
    const closeFailure = new Error("shutdown observation failed");
    try {
      await client.connect();
      transport.waitForChildClose = async () => { throw closeFailure; };
      const controller = new AbortController();
      const reason = Object.assign(new Error("run expired"), { code: "run_deadline" });
      const spawning = client.spawn(spawnRequest(), { signal: controller.signal });
      await expect.poll(async () => await pathExists(path.join(artifactRoot, "spawn-received"))).toBe(true);
      controller.abort(reason);
      const failure = await spawning.catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(BrokerCancelledError);
      expect(failure).toMatchObject({ code: "run_deadline" });
      const graph = errorGraph(failure);
      expect(graph).toContain(reason);
      expect(graph).toContain(closeFailure);
      expect(graph).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "terminate_failed" })
      ]));
      expect(client.lostProcessHandles).toEqual([
        expect.objectContaining({ id: "fixture-process" })
      ]);
    } finally {
      transport.waitForChildClose = waitForChildClose;
      await client.close().catch(() => undefined);
      await rm(artifactRoot, { recursive: true, force: true });
    }
  });

  it("releases truncated terminal artifacts before returning cancellation", async () => {
    const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "sigma-exec-artifacts-cancel-output-"));
    const client = new SigmaExecBrokerClient(clientOptions("cancel-artifact", artifactRoot, {
      cancellationGraceMs: 2_000
    }));
    try {
      await client.connect();
      const controller = new AbortController();
      const execution = client.execute(executionRequest(), { signal: controller.signal });
      await expect.poll(async () => await pathExists(path.join(artifactRoot, "exec-started"))).toBe(true);
      controller.abort(new Error("caller cancelled"));

      await expect(execution).rejects.toBeInstanceOf(BrokerCancelledError);
      await expect(access(path.join(artifactRoot, "cancelled-stdout.log"))).rejects.toThrow();
      await expect(access(path.join(artifactRoot, "cancelled-artifact-released")))
        .resolves.toBeUndefined();
      await expect(client.doctor()).resolves.toMatchObject({ sandbox: { available: true } });
    } finally {
      await client.close().catch(() => undefined);
      await rm(artifactRoot, { recursive: true, force: true });
    }
  });

  it("retires a generation and loses active handles when cancellation grace expires", async () => {
    const staleRoot = await mkdtemp(path.join(os.tmpdir(), "sigma-exec-artifacts-cancel-grace-"));
    const freshRoot = await mkdtemp(path.join(os.tmpdir(), "sigma-exec-artifacts-fresh-generation-"));
    const stale = new SigmaExecBrokerClient(clientOptions("hang", staleRoot, {
      cancellationGraceMs: 25
    }));
    const fresh = new SigmaExecBrokerClient(clientOptions("normal", freshRoot));
    const clients = [stale, fresh];
    let factoryCalls = 0;
    const broker = new LazyExecutionBroker({
      sandboxMode: "required",
      allowUnsafeHostExec: false,
      clientFactory: () => clients[factoryCalls++]!
    });
    try {
      const handle = await broker.spawn(spawnRequest());
      const controller = new AbortController();
      const execution = broker.execute(executionRequest(), { signal: controller.signal });
      await expect.poll(async () => await pathExists(path.join(staleRoot, "exec-started"))).toBe(true);
      controller.abort(new Error("cancellation grace test"));

      await expect(execution).rejects.toBeInstanceOf(BrokerCancelledError);
      expect(factoryCalls).toBe(2);
      expect(stale.lostProcessHandles).toEqual([
        expect.objectContaining({ id: "fixture-process" })
      ]);
      expect(broker.lostProcessHandles).toContainEqual(handle);
      await expect(access(staleRoot)).rejects.toThrow();
      await expect(broker.doctor()).resolves.toMatchObject({ sandbox: { available: true } });
    } finally {
      await broker.close().catch(() => undefined);
      await rm(staleRoot, { recursive: true, force: true });
      await rm(freshRoot, { recursive: true, force: true });
    }
  });
});

describe("lazy broker lifecycle error preservation", () => {
  it("keeps a non-retry-safe connection error when retirement fails", async () => {
    const original = new BrokerConnectionError("dispatch result unknown");
    const retirement = new Error("retirement failed");
    const client = syntheticBroker({
      execute: async () => { throw original; },
      close: async () => { throw retirement; }
    });
    const broker = new LazyExecutionBroker({
      sandboxMode: "required", allowUnsafeHostExec: false, clientFactory: () => client
    });

    const failure = await broker.execute(executionRequest()).catch((error: unknown) => error);
    expect(failure).toBe(original);
    expect(failure).toMatchObject({ code: "broker_connection_error", retrySafe: false });
    expect(errorGraph(failure)).toContain(retirement);
    await expect(broker.close()).rejects.toBe(retirement);
  });

  it("keeps a startup timeout error when retirement fails", async () => {
    const original = new BrokerTimeoutError("startup timed out");
    const retirement = new Error("startup retirement failed");
    const client = syntheticBroker({
      connect: async () => { throw original; },
      close: async () => { throw retirement; }
    });
    const broker = new LazyExecutionBroker({
      sandboxMode: "required", allowUnsafeHostExec: false, clientFactory: () => client
    });

    const failure = await broker.execute(executionRequest()).catch((error: unknown) => error);
    expect(failure).toBe(original);
    expect(failure).toMatchObject({ code: "broker_timeout" });
    expect(errorGraph(failure)).toContain(retirement);
    await expect(broker.close()).rejects.toBe(retirement);
  });

  it("wraps only a retry-safe connection error when retirement fails", async () => {
    const original = new BrokerConnectionError("rejected before dispatch", { retrySafe: true });
    const retirement = new Error("retirement failed");
    const client = syntheticBroker({
      execute: async () => { throw original; },
      close: async () => { throw retirement; }
    });
    const broker = new LazyExecutionBroker({
      sandboxMode: "required", allowUnsafeHostExec: false, clientFactory: () => client
    });

    const failure = await broker.execute(executionRequest()).catch((error: unknown) => error);
    expect(failure).not.toBe(original);
    expect(failure).toMatchObject({ code: "broker_connection_error", retrySafe: false });
    expect(errorGraph(failure)).toEqual(expect.arrayContaining([original, retirement]));
    await expect(broker.close()).rejects.toBe(retirement);
  });

  it("keeps both the handle operation and retirement failures in process-lost cause", async () => {
    const original = new BrokerConnectionError("write result unknown");
    const retirement = new Error("handle generation retirement failed");
    const client = syntheticBroker({
      write: async () => { throw original; },
      close: async () => { throw retirement; }
    });
    const broker = new LazyExecutionBroker({
      sandboxMode: "required", allowUnsafeHostExec: false, clientFactory: () => client
    });
    const handle = await broker.spawn(spawnRequest());

    const failure = await broker.write(handle, "input").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(BrokerProcessLostError);
    expect((failure as Error).cause).toBe(original);
    expect(errorGraph(failure)).toContain(retirement);
    expect(broker.lostProcessHandles).toContainEqual(handle);
    await expect(broker.close()).rejects.toBe(retirement);
  });
});
