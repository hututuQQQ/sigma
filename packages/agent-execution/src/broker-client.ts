import { BrokerTransport } from "./broker-transport.js";
import {
  BrokerCancelledError,
  BrokerConnectionError,
  BrokerOutputDecodingError,
  BrokerPolicyError,
  BrokerProcessLostError,
  BrokerTimeoutError,
  SandboxUnavailableError
} from "./errors.js";
import { BrokerOutputArtifactImporter } from "./output-artifact-import.js";
import {
  positiveInteger,
  redactionSecrets,
  requestParams
} from "./broker-request-policy.js";
import { SecretRedactor, type SecretRedactionStream } from "./redaction.js";
import {
  assertTrustedToolchainsAvailable,
  normalizeTrustedToolchains,
  type NormalizedTrustedToolchain
} from "./trusted-toolchains.js";
import type {
  BrokerDoctorReport,
  BrokerRequestOptions,
  ExecutionBroker,
  ExecutionPolicy,
  ExecutionRequest,
  ExecutionResult,
  ProcessHandle,
  ProcessPollResult,
  ProcessSpawnRequest,
  SigmaExecBrokerClientOptions
} from "./types.js";
import { parseDoctor, parseExecutionValue, parseHello, parseProcessValue, parseSpawnedProcess } from "./values.js";

type ClientState = "new" | "connecting" | "ready" | "failed" | "closed";
interface Cursor { stdout: number; stderr: number }
interface RedactionStream {
  push(input: string, options?: { final?: boolean; discontinuity?: boolean }): string;
}
interface ProcessRedaction { stdout: RedactionStream; stderr: SecretRedactionStream }

function cancellationError(signal?: AbortSignal): BrokerCancelledError {
  const cause = signal?.reason instanceof Error ? signal.reason : undefined;
  return new BrokerCancelledError(cause?.message ?? "Execution request cancelled.", { cause });
}

export class SigmaExecBrokerClient implements ExecutionBroker {
  private readonly transport: BrokerTransport;
  private readonly redactor: SecretRedactor;
  private readonly cursors = new Map<string, Cursor>();
  private readonly processRedaction = new Map<string, ProcessRedaction>();
  private readonly lost = new Map<string, ProcessHandle>();
  private readonly outputArtifacts: BrokerOutputArtifactImporter;
  private readonly trustedToolchains: NormalizedTrustedToolchain[];
  private state: ClientState = "new";
  private instanceId?: string;
  private artifactCleanup?: Promise<void>;
  private doctorValue?: BrokerDoctorReport;

  constructor(private readonly options: SigmaExecBrokerClientOptions) {
    if (!options.helperPath) throw new BrokerPolicyError("sigma-exec helperPath is required.");
    positiveInteger(options.cancellationGraceMs, 10_000, "cancellationGraceMs");
    this.trustedToolchains = normalizeTrustedToolchains(options.trustedToolchains);
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
      assertTrustedToolchainsAvailable(this.trustedToolchains, this.options.sandboxMode);
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
      ...requestParams(request, this.options, this.trustedToolchains, this.verifiedShellExecutables()), timeoutMs,
      ...(request.idleTimeoutMs === undefined ? {} : {
        idleTimeoutMs: positiveInteger(request.idleTimeoutMs, 30_000, "idleTimeoutMs")
      })
    };
    const value = parseExecutionValue(await this.transport.request("exec", params, {
      ...options, timeoutMs: options.timeoutMs ?? timeoutMs + 5_000
    }));
    await this.assertDecoded(value);
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
      // Receive a racing process handle first, then terminate it durably.
      let spawned: ReturnType<typeof parseSpawnedProcess>;
      try {
        spawned = parseSpawnedProcess(await this.transport.request(
          "process.spawn",
          requestParams(request, this.options, this.trustedToolchains, this.verifiedShellExecutables()),
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
    await this.assertDecoded(value);
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

  private async assertDecoded(value: ReturnType<typeof parseProcessValue>): Promise<void> {
    const failure = (["stdout", "stderr"] as const).flatMap((stream) => {
      const decodingError = value[stream].decodingError;
      return decodingError ? [{ stream, ...decodingError }] : [];
    })[0];
    if (!failure) return;
    await this.close().catch(() => undefined);
    throw new BrokerOutputDecodingError(failure.stream, failure.code, failure.message);
  }

  private verifiedShellExecutables(): string[] {
    return this.doctorValue?.capabilities.shells
      ?.filter((shell) => shell.verified)
      .map((shell) => shell.executable) ?? [];
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
