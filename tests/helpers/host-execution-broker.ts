import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import type {
  BrokerDoctorReport,
  BrokerRequestOptions,
  ExecutionBroker,
  ExecutionRequest,
  ExecutionResult,
  ProcessHandle,
  ProcessPollResult,
  ProcessSpawnRequest
} from "../../packages/agent-execution/src/index.js";
import { createMinimalEnvironment } from "../../packages/agent-execution/src/index.js";

interface OutputBuffer {
  bytes: Buffer;
  startOffset: number;
  totalBytes: number;
  cursor: number;
  maximum: number;
  decoder: StringDecoder;
}

interface HostProcess {
  child: ChildProcessWithoutNullStreams;
  handle: ProcessHandle;
  stdout: OutputBuffer;
  stderr: OutputBuffer;
  startedAt: number;
  state: "running" | "exited" | "terminated";
  exitCode: number | null;
  signal: string | null;
  terminated: boolean;
}

function output(maximum: number): OutputBuffer {
  return {
    bytes: Buffer.alloc(0), startOffset: 0, totalBytes: 0, cursor: 0, maximum,
    decoder: new StringDecoder("utf8")
  };
}

function append(target: OutputBuffer, chunk: Buffer): void {
  target.totalBytes += chunk.byteLength;
  const combined = Buffer.concat([target.bytes, chunk]);
  if (combined.byteLength <= target.maximum) {
    target.bytes = combined;
    return;
  }
  const excess = combined.byteLength - target.maximum;
  target.bytes = combined.subarray(excess);
  target.startOffset += excess;
}

function readOutput(target: OutputBuffer, final: boolean): { data: string; dropped: number } {
  const effective = Math.max(target.cursor, target.startOffset);
  const index = effective - target.startOffset;
  const dropped = Math.max(0, target.startOffset - target.cursor);
  const data = target.decoder.write(target.bytes.subarray(index)) + (final ? target.decoder.end() : "");
  target.cursor = target.totalBytes;
  return { data, dropped };
}

function environment(request: ExecutionRequest["command"]): NodeJS.ProcessEnv {
  return createMinimalEnvironment(request.environment);
}

async function terminateTree(child: ChildProcessWithoutNullStreams, force = false): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  if (process.platform !== "win32") {
    try { process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM"); } catch { child.kill(force ? "SIGKILL" : "SIGTERM"); }
    return;
  }
  await new Promise<void>((resolve) => {
    const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/T", "/F"], {
      windowsHide: true, shell: false, stdio: "ignore"
    });
    killer.once("error", () => { child.kill(); resolve(); });
    killer.once("close", () => resolve());
  });
}

function waitForClose(child: ChildProcessWithoutNullStreams, milliseconds = 1_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
    child.once("close", () => { clearTimeout(timer); resolve(); });
  });
}

export class HostExecutionBroker implements ExecutionBroker {
  readonly lostProcessHandles: readonly ProcessHandle[] = [];
  private readonly instanceId = `test-host-${randomUUID()}`;
  private readonly processes = new Map<string, HostProcess>();

  async connect(): Promise<BrokerDoctorReport> { return this.report(); }
  async doctor(): Promise<BrokerDoctorReport> { return this.report(); }

  async execute(request: ExecutionRequest, options: BrokerRequestOptions = {}): Promise<ExecutionResult> {
    options.signal?.throwIfAborted();
    const record = await this.start(request, request.maxOutputBytes ?? 16 * 1024 * 1024);
    record.child.stdin.end(request.command.stdin ?? "");
    let timedOut = false;
    let idleTimedOut = false;
    let cancelled = false;
    const abort = (): void => { cancelled = true; void terminateTree(record.child); };
    options.signal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(() => { timedOut = true; void terminateTree(record.child); }, request.timeoutMs ?? 120_000);
    timeout.unref();
    let idle = request.idleTimeoutMs
      ? setTimeout(() => { idleTimedOut = true; void terminateTree(record.child); }, request.idleTimeoutMs) : undefined;
    idle?.unref();
    const heartbeat = (): void => {
      if (!request.idleTimeoutMs || !idle) return;
      clearTimeout(idle);
      idle = setTimeout(() => { idleTimedOut = true; void terminateTree(record.child); }, request.idleTimeoutMs);
      idle.unref();
    };
    record.child.stdout.on("data", heartbeat);
    record.child.stderr.on("data", heartbeat);
    await waitForClose(record.child, (request.timeoutMs ?? 120_000) + 2_000);
    clearTimeout(timeout);
    if (idle) clearTimeout(idle);
    options.signal?.removeEventListener("abort", abort);
    const value = this.result(record);
    this.processes.delete(record.handle.id);
    return {
      ...value,
      state: value.state === "running" ? "terminated" : value.state,
      timedOut,
      idleTimedOut,
      cancelled
    };
  }

  async spawn(request: ProcessSpawnRequest, options: BrokerRequestOptions = {}): Promise<ProcessHandle> {
    options.signal?.throwIfAborted();
    const record = await this.start(request, request.maxOutputBytes ?? 16 * 1024 * 1024);
    if (request.command.stdin !== undefined) record.child.stdin.write(request.command.stdin);
    return record.handle;
  }

  async poll(handle: ProcessHandle): Promise<ProcessPollResult> {
    return this.result(this.record(handle));
  }

  async write(handle: ProcessHandle, data: string): Promise<void> {
    const record = this.record(handle);
    await new Promise<void>((resolve, reject) => record.child.stdin.write(data, (error) => error ? reject(error) : resolve()));
  }

  async terminate(handle: ProcessHandle): Promise<ProcessPollResult> {
    const record = this.record(handle);
    record.terminated = true;
    await terminateTree(record.child);
    await waitForClose(record.child);
    return this.result(record);
  }

  async close(): Promise<void> {
    await Promise.all([...this.processes.values()].map(async (record) => {
      record.terminated = true;
      await terminateTree(record.child, true);
      await waitForClose(record.child);
    }));
    this.processes.clear();
  }

  private async start(request: ProcessSpawnRequest, maximum: number): Promise<HostProcess> {
    const child = spawn(request.command.executable, request.command.args ?? [], {
      cwd: path.resolve(request.command.cwd),
      env: environment(request.command),
      windowsHide: true,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"]
    });
    const handle = { id: randomUUID(), brokerInstanceId: this.instanceId, systemProcessId: child.pid };
    const record: HostProcess = {
      child, handle, stdout: output(maximum), stderr: output(maximum), startedAt: Date.now(),
      state: "running", exitCode: null, signal: null, terminated: false
    };
    child.stdout.on("data", (chunk: Buffer) => append(record.stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => append(record.stderr, chunk));
    // A short-lived command may close its pipe before execute() finishes
    // forwarding optional stdin. Writable callbacks still receive failures;
    // this listener prevents the stream's parallel error event from escaping
    // the test broker as an uncaught EPIPE.
    child.stdin.on("error", () => undefined);
    child.on("close", (code, signal) => {
      record.state = record.terminated ? "terminated" : "exited";
      record.exitCode = code;
      record.signal = signal;
    });
    this.processes.set(handle.id, record);
    try {
      await new Promise<void>((resolve, reject) => {
        const spawned = (): void => { child.removeListener("error", failed); resolve(); };
        const failed = (error: Error): void => { child.removeListener("spawn", spawned); reject(error); };
        child.once("spawn", spawned);
        child.once("error", failed);
      });
    } catch (error) {
      this.processes.delete(handle.id);
      throw error;
    }
    child.on("error", () => undefined);
    return record;
  }

  private record(handle: ProcessHandle): HostProcess {
    if (handle.brokerInstanceId !== this.instanceId) throw new Error("Process belongs to another test broker.");
    const record = this.processes.get(handle.id);
    if (!record) throw new Error(`Unknown test process '${handle.id}'.`);
    return record;
  }

  private result(record: HostProcess): ProcessPollResult {
    const final = record.state !== "running";
    const stdout = readOutput(record.stdout, final);
    const stderr = readOutput(record.stderr, final);
    return {
      handle: record.handle,
      state: record.state,
      exitCode: record.exitCode,
      signal: record.signal,
      durationMs: Date.now() - record.startedAt,
      stdout: stdout.data,
      stderr: stderr.data,
      stdoutDroppedBytes: stdout.dropped,
      stderrDroppedBytes: stderr.dropped,
      outputTruncated: stdout.dropped > 0 || stderr.dropped > 0
    };
  }

  private report(): BrokerDoctorReport {
    return {
      protocolVersion: 1,
      brokerVersion: "test-host",
      platform: process.platform,
      architecture: process.arch,
      sandbox: { available: true, backend: "test-only-host", selfTestPassed: true, setupRequired: false },
      capabilities: {
        foreground: true,
        background: true,
        stdin: true,
        pty: false,
        networkModes: ["none", "full"],
        shells: [{
          kind: process.platform === "win32" ? "cmd" : "bash",
          executable: process.platform === "win32" ? "cmd.exe" : "bash",
          verified: true,
          supportsChildProcesses: true
        }],
        runtimeCommands: ["node", process.platform === "win32" ? "npm.cmd" : "npm"]
      }
    };
  }
}

export function createHostExecutionBroker(): HostExecutionBroker {
  return new HostExecutionBroker();
}
