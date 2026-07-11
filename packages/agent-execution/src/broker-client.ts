import path from "node:path";
import { BrokerTransport } from "./broker-transport.js";
import {
  BrokerCancelledError,
  BrokerConnectionError,
  BrokerPolicyError,
  BrokerProcessLostError,
  BrokerTimeoutError,
  SandboxUnavailableError
} from "./errors.js";
import { createMinimalEnvironment } from "./environment.js";
import { BrokerOutputArtifactImporter } from "./output-artifact-import.js";
import { SecretRedactor, type SecretRedactionStream } from "./redaction.js";
import type {
  BrokerDoctorReport,
  BrokerRequestOptions,
  CommandSpec,
  ExecutionBroker,
  ExecutionPolicy,
  ExecutionRequest,
  ExecutionResult,
  ProcessHandle,
  ProcessPollResult,
  ProcessSpawnRequest,
  SigmaExecBrokerClientOptions
} from "./types.js";
import { DEFAULT_MAX_OUTPUT_BYTES } from "./types.js";
import { parseDoctor, parseExecutionValue, parseHello, parseProcessValue, parseSpawnedProcess } from "./values.js";

type ClientState = "new" | "connecting" | "ready" | "failed" | "closed";
interface Cursor { stdout: number; stderr: number }
interface RedactionStream {
  push(input: string, options?: { final?: boolean; discontinuity?: boolean }): string;
}
interface ProcessRedaction { stdout: RedactionStream; stderr: SecretRedactionStream }

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0) throw new BrokerPolicyError(`${label} must be a positive integer.`);
  return result;
}

function cancellationError(signal?: AbortSignal): BrokerCancelledError {
  const cause = signal?.reason instanceof Error ? signal.reason : undefined;
  return new BrokerCancelledError(cause?.message ?? "Execution request cancelled.", { cause });
}

function ptyDimension(value: number | undefined, fallback: number, label: string): number {
  const result = positiveInteger(value, fallback, label);
  if (result > 65_535) throw new BrokerPolicyError(`${label} must not exceed 65535.`);
  return result;
}

function assertAbsoluteRoots(roots: string[], label: string): void {
  if (!Array.isArray(roots) || roots.some((root) => typeof root !== "string" || !path.isAbsolute(root))) {
    throw new BrokerPolicyError(`${label} must contain only absolute paths.`);
  }
}

function pathWithin(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function defaultProtectedPaths(policy: ExecutionPolicy): string[] {
  const explicit = policy.protectedPaths ?? [];
  const resolved = [...new Set(policy.readRoots.map((root) => path.resolve(root)))];
  const roots = resolved.filter((root) => !resolved.some((candidate) =>
    candidate !== root && pathWithin(root, candidate)
  ));
  return [...new Set([
    ...explicit,
    ...roots.flatMap((root) => [path.join(root, ".git"), path.join(root, ".agent")])
  ])];
}

function wireCommand(command: CommandSpec): Record<string, unknown> {
  if (!command.executable || typeof command.executable !== "string") throw new BrokerPolicyError("Command executable is required.");
  if (!path.isAbsolute(command.cwd)) throw new BrokerPolicyError("Command cwd must be absolute.");
  if (command.args?.some((argument) => typeof argument !== "string" || argument.includes("\0"))) {
    throw new BrokerPolicyError("Command arguments must be NUL-free strings.");
  }
  if (command.executable.includes("\0") || command.cwd.includes("\0") || command.stdin?.includes("\0")) {
    throw new BrokerPolicyError("Command values cannot contain NUL bytes.");
  }
  return {
    executable: command.executable,
    args: command.args ?? [],
    cwd: path.resolve(command.cwd),
    env: createMinimalEnvironment(command.environment),
    ...(command.stdin === undefined ? {} : { stdin: command.stdin })
  };
}

function wirePolicy(policy: ExecutionPolicy, options: SigmaExecBrokerClientOptions): Record<string, unknown> {
  assertAbsoluteRoots(policy.readRoots, "readRoots");
  assertAbsoluteRoots(policy.writeRoots, "writeRoots");
  assertAbsoluteRoots(policy.protectedPaths ?? [], "protectedPaths");
  if (policy.network === "full" && policy.networkApproved !== true) {
    throw new BrokerPolicyError("Full network access requires an explicit per-call approval.");
  }
  if (policy.sandbox === "unsafe" && (!options.allowUnsafeHostExec || policy.unsafeHostExecApproved !== true)) {
    throw new BrokerPolicyError("Unsafe host execution requires broker opt-in and explicit per-call approval.");
  }
  return {
    sandbox: policy.sandbox,
    network: policy.network,
    networkApproved: policy.networkApproved === true,
    readRoots: policy.readRoots.map((root) => path.resolve(root)),
    writeRoots: policy.writeRoots.map((root) => path.resolve(root)),
    protectedPaths: defaultProtectedPaths(policy).map((item) => path.resolve(item)),
    unsafeHostExecApproved: policy.unsafeHostExecApproved === true
  };
}

function requestParams(
  request: ExecutionRequest | ProcessSpawnRequest,
  options: SigmaExecBrokerClientOptions
): Record<string, unknown> {
  if (request.policy.sandbox === "required") {
    const roots = [...request.policy.readRoots, ...request.policy.writeRoots];
    if (!roots.some((root) => pathWithin(request.command.cwd, root))) {
      throw new BrokerPolicyError("A sandboxed command cwd must be inside a declared read or write root.");
    }
  }
  return {
    command: wireCommand(request.command),
    policy: wirePolicy(request.policy, options),
    maxOutputBytes: positiveInteger(request.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, "maxOutputBytes"),
    ...("pty" in request && request.pty === true ? {
      pty: true,
      ptyColumns: ptyDimension(request.ptyColumns, 120, "ptyColumns"),
      ptyRows: ptyDimension(request.ptyRows, 30, "ptyRows")
    } : {})
  };
}

function redactionSecrets(secrets: SigmaExecBrokerClientOptions["secrets"]): Array<{ name: string; value: string }> {
  const result = Object.entries(secrets ?? {}).flatMap(([name, value]) => {
    if (!value || value.length < 4) return [];
    if (name.length > 128 || name.includes("\0") || value.length > 64 * 1024 || value.includes("\0")) {
      throw new BrokerPolicyError("Artifact redaction secrets exceed native broker limits.");
    }
    return [{ name, value }];
  });
  if (result.length > 128) throw new BrokerPolicyError("At most 128 artifact redaction secrets are allowed.");
  return result;
}

export class SigmaExecBrokerClient implements ExecutionBroker {
  private readonly transport: BrokerTransport;
  private readonly redactor: SecretRedactor;
  private readonly cursors = new Map<string, Cursor>();
  private readonly processRedaction = new Map<string, ProcessRedaction>();
  private readonly lost = new Map<string, ProcessHandle>();
  private readonly outputArtifacts: BrokerOutputArtifactImporter;
  private state: ClientState = "new";
  private instanceId?: string;
  private artifactCleanup?: Promise<void>;
  private doctorValue?: BrokerDoctorReport;

  constructor(private readonly options: SigmaExecBrokerClientOptions) {
    if (!options.helperPath) throw new BrokerPolicyError("sigma-exec helperPath is required.");
    this.redactor = new SecretRedactor(options.secrets);
    this.transport = new BrokerTransport(options, () => this.markProcessesLost());
    this.outputArtifacts = new BrokerOutputArtifactImporter(this.redactor, async (artifactIds) =>
      await this.transport.request("artifact.release", { artifactIds }, { timeoutMs: 5_000 })
    );
  }

  get lostProcessHandles(): readonly ProcessHandle[] { return [...this.lost.values()]; }
  get stderr(): string { return this.transport.stderr; }

  async connect(signal?: AbortSignal): Promise<BrokerDoctorReport> {
    if (this.state !== "new") throw new BrokerConnectionError(`Cannot connect broker client in '${this.state}' state.`);
    this.state = "connecting";
    try {
      this.transport.start();
      const hello = parseHello(await this.transport.request("hello", {
        clientVersion: "3.0.0",
        redactionSecrets: redactionSecrets(this.options.secrets)
      }, { signal, timeoutMs: 5_000 }));
      this.instanceId = hello.instanceId;
      await this.outputArtifacts.configureRoot(hello.artifactRoot);
      const report = parseDoctor(await this.transport.request("doctor", {}, { signal, timeoutMs: 15_000 }));
      this.assertRequiredSandbox(report);
      this.doctorValue = report;
      this.state = "ready";
      return report;
    } catch (error) {
      this.state = "failed";
      try {
        await this.transport.close();
      } finally {
        await this.outputArtifacts.cleanup();
      }
      throw error;
    }
  }

  async doctor(signal?: AbortSignal): Promise<BrokerDoctorReport> {
    this.assertReady();
    const report = parseDoctor(await this.transport.request("doctor", {}, { signal, timeoutMs: 15_000 }));
    this.assertRequiredSandbox(report);
    this.doctorValue = report;
    return report;
  }

  async setupSandbox(signal?: AbortSignal): Promise<BrokerDoctorReport> {
    this.assertReady();
    const report = parseDoctor(await this.transport.request("sandbox.setup", {}, { signal, timeoutMs: 60_000 }));
    this.doctorValue = report;
    return report;
  }

  async execute(request: ExecutionRequest, options: BrokerRequestOptions = {}): Promise<ExecutionResult> {
    this.assertReady();
    this.assertRequestSandbox(request.policy);
    const timeoutMs = positiveInteger(request.timeoutMs, 120_000, "timeoutMs");
    const params = {
      ...requestParams(request, this.options), timeoutMs,
      ...(request.idleTimeoutMs === undefined ? {} : {
        idleTimeoutMs: positiveInteger(request.idleTimeoutMs, 30_000, "idleTimeoutMs")
      })
    };
    const value = parseExecutionValue(await this.transport.request("exec", params, {
      ...options, timeoutMs: options.timeoutMs ?? timeoutMs + 5_000
    }));
    const outputArtifacts = await this.outputArtifacts.consume(value.outputArtifacts);
    return {
      state: value.state, exitCode: value.exitCode, signal: value.signal, durationMs: value.durationMs,
      timedOut: value.timedOut, idleTimedOut: value.idleTimedOut, cancelled: value.cancelled,
      stdout: value.stdout.droppedBytes > 0
        ? "[REDACTED:truncated-output]"
        : this.redactor.redactText(value.stdout.data),
      stderr: value.stderr.droppedBytes > 0
        ? "[REDACTED:truncated-output]"
        : this.redactor.redactText(value.stderr.data),
      stdoutDroppedBytes: value.stdout.droppedBytes, stderrDroppedBytes: value.stderr.droppedBytes,
      outputTruncated: value.stdout.droppedBytes > 0 || value.stderr.droppedBytes > 0,
      ...(outputArtifacts.length > 0 ? { outputArtifacts } : {})
    };
  }

  async spawn(request: ProcessSpawnRequest, options: BrokerRequestOptions = {}): Promise<ProcessHandle> {
    this.assertReady();
    this.assertRequestSandbox(request.policy);
    if (options.signal?.aborted) throw cancellationError(options.signal);
    let cancelled = false;
    const onAbort = (): void => { cancelled = true; };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      // A process handle must never be orphaned because the request response lost
      // a race with cancellation. Receive it first, then terminate it durably.
      let spawned: ReturnType<typeof parseSpawnedProcess>;
      try {
        spawned = parseSpawnedProcess(await this.transport.request(
          "process.spawn",
          requestParams(request, this.options),
          { ...options, signal: undefined }
        ));
      } catch (error) {
        if (error instanceof BrokerTimeoutError) await this.close().catch(() => undefined);
        throw error;
      }
      const handle = { id: spawned.id, brokerInstanceId: this.instanceId!, systemProcessId: spawned.systemProcessId };
      this.cursors.set(handle.id, { stdout: 0, stderr: 0 });
      this.processRedaction.set(handle.id, this.createProcessRedaction(request.outputRedaction));
      if (!cancelled) return handle;
      try { await this.terminate(handle); }
      catch (error) {
        await this.close();
        throw new BrokerConnectionError("Cancelled process cleanup failed; the broker was closed.", { cause: error });
      }
      throw cancellationError(options.signal);
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
    }
  }

  async poll(handle: ProcessHandle, options: BrokerRequestOptions = {}): Promise<ProcessPollResult> {
    this.assertHandle(handle);
    const cursor = this.cursors.get(handle.id)!;
    const value = parseProcessValue(await this.transport.request("process.poll", {
      handleId: handle.id, stdoutOffset: cursor.stdout, stderrOffset: cursor.stderr
    }, options));
    cursor.stdout = value.stdout.nextOffset;
    cursor.stderr = value.stderr.nextOffset;
    return await this.processResult(handle, value);
  }

  async write(handle: ProcessHandle, data: string, options: BrokerRequestOptions = {}): Promise<void> {
    this.assertHandle(handle);
    if (typeof data !== "string" || data.includes("\0")) throw new BrokerPolicyError("Process input must be a NUL-free string.");
    await this.transport.request("process.write", { handleId: handle.id, data }, options);
  }

  async terminate(handle: ProcessHandle, options: BrokerRequestOptions = {}): Promise<ProcessPollResult> {
    this.assertHandle(handle);
    const cursor = this.cursors.get(handle.id)!;
    const value = parseProcessValue(await this.transport.request("process.terminate", {
      handleId: handle.id, stdoutOffset: cursor.stdout, stderrOffset: cursor.stderr
    }, options));
    cursor.stdout = value.stdout.nextOffset;
    cursor.stderr = value.stderr.nextOffset;
    return await this.processResult(handle, value);
  }

  async releaseOutputArtifacts(artifactIds: string[]): Promise<void> {
    this.assertReady();
    await this.outputArtifacts.acknowledge(artifactIds);
  }

  async close(): Promise<void> {
    if (this.state === "closed") return;
    try {
      await this.transport.close();
    } finally {
      await this.artifactCleanup;
      await this.outputArtifacts.cleanup();
      this.cursors.clear();
      this.processRedaction.clear();
      this.state = "closed";
    }
  }

  private async processResult(handle: ProcessHandle, value: ReturnType<typeof parseProcessValue>): Promise<ProcessPollResult> {
    const streams = this.processRedaction.get(handle.id) ?? this.createProcessRedaction();
    this.processRedaction.set(handle.id, streams);
    const final = value.state !== "running";
    const stdout = streams.stdout.push(value.stdout.data, {
      final, discontinuity: value.stdout.droppedBytes > 0
    });
    const stderr = streams.stderr.push(value.stderr.data, {
      final, discontinuity: value.stderr.droppedBytes > 0
    });
    if (final) this.processRedaction.delete(handle.id);
    const outputArtifacts = await this.outputArtifacts.consume(value.outputArtifacts);
    const result: ProcessPollResult = {
      handle, state: value.state, exitCode: value.exitCode, signal: value.signal, durationMs: value.durationMs,
      stdout, stderr,
      stdoutDroppedBytes: value.stdout.droppedBytes, stderrDroppedBytes: value.stderr.droppedBytes,
      outputTruncated: value.stdout.droppedBytes > 0 || value.stderr.droppedBytes > 0,
      ...(outputArtifacts.length > 0 ? { outputArtifacts } : {})
    };
    if (final) {
      await this.transport.request("process.release", { handleId: handle.id }, { timeoutMs: 5_000 });
      this.cursors.delete(handle.id);
    }
    return result;
  }

  private assertRequiredSandbox(report: BrokerDoctorReport): void {
    if ((this.options.sandboxMode ?? "required") === "required" && (!report.sandbox.available || !report.sandbox.selfTestPassed)) {
      throw new SandboxUnavailableError(report.sandbox.reason ?? "Required sandbox self-test failed.", report.sandbox);
    }
  }

  private assertRequestSandbox(policy: ExecutionPolicy): void {
    if (policy.sandbox === "required" && (!this.doctorValue?.sandbox.available || !this.doctorValue.sandbox.selfTestPassed)) {
      throw new SandboxUnavailableError(this.doctorValue?.sandbox.reason ?? "Required sandbox is unavailable.");
    }
  }

  private assertHandle(handle: ProcessHandle): void {
    if (handle.brokerInstanceId !== this.instanceId) throw new BrokerProcessLostError(handle.id);
    if (this.lost.has(handle.id) || !this.cursors.has(handle.id)) throw new BrokerProcessLostError(handle.id);
    this.assertReady();
  }

  private assertReady(): void {
    if (this.state !== "ready") throw new BrokerConnectionError(`Broker client is not ready (state: ${this.state}).`);
  }

  private markProcessesLost(): void {
    if (this.state === "closed") return;
    for (const id of this.cursors.keys()) this.lost.set(id, { id, brokerInstanceId: this.instanceId ?? "lost" });
    this.cursors.clear();
    this.processRedaction.clear();
    this.artifactCleanup = this.outputArtifacts.cleanup();
    void this.artifactCleanup;
    this.state = "failed";
  }

  private createProcessRedaction(mode: ProcessSpawnRequest["outputRedaction"] = "default"): ProcessRedaction {
    return {
      stdout: mode === "framed_jsonrpc"
        ? this.redactor.createFramedJsonRpcStream()
        : this.redactor.createStream(mode),
      stderr: this.redactor.createStream()
    };
  }
}
