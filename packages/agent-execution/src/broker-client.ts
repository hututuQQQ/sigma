import { BrokerTransport } from "./broker-transport.js";
import {
  requestSandboxLeaseRevoke, requestSandboxLeaseStatus, requestSandboxReport,
  requestVerifiedSandboxReport
} from "./broker-sandbox-operations.js";
import {
  assertRequestSandbox, assertRequiredSandbox, cancellationError,
  BrokerClientLifecycle, BrokerPostResponseOperations, containPostDispatchFailure, containTransportFailure,
  containReusedProcessId, createProcessRedaction, decodedExecutionResult,
  DEFAULT_DOCTOR_TIMEOUT_MS, DEFAULT_SANDBOX_SETUP_TIMEOUT_MS, DEFAULT_STARTUP_TIMEOUT_MS,
  outputDecodingError, parsePostDispatchValue, rejectUndecodableExecution,
  requestExecutionValue, reserveProcessId, runPostResponseOperation, SerializedProcessOperations,
  type ClientState, type Cursor, type ProcessRedaction
} from "./broker-client-support.js";
import { settleCancelledSpawn } from "./broker-client-cancellation.js";
import {
  BrokerCancelledError, BrokerConnectionError, BrokerPolicyError,
  BrokerProcessLostError, BrokerTimeoutError,
  attachBrokerLifecycleFailure
} from "./errors.js";
import { BrokerOutputArtifactImporter } from "./output-artifact-import.js";
import { positiveInteger, redactionSecrets, requestParams } from "./broker-request-policy.js";
import { SecretRedactor } from "./redaction.js";
import {
  assertTrustedToolchainsAvailable, normalizeTrustedToolchains, type NormalizedTrustedToolchain
} from "./trusted-toolchains.js";
import type {
  BrokerDoctorReport, BrokerRequestOptions, BrokerSandboxLeaseStatus, BrokerSandboxRevokeResult,
  ExecutionBroker, ExecutionRequest, ExecutionResult, ProcessHandle, ProcessHandoffResult,
  ProcessPollResult, ProcessSpawnRequest, SigmaExecBrokerClientOptions
} from "./types.js";
import { parseDoctor, parseHello, parseProcessHandoff, parseProcessValue, parseSpawnedProcess } from "./values.js";
export class SigmaExecBrokerClient implements ExecutionBroker {
  private readonly transport: BrokerTransport;
  private readonly redactor: SecretRedactor;
  private readonly cursors = new Map<string, Cursor>();
  private readonly activeProcesses = new Map<string, ProcessHandle>();
  private readonly seenProcessIds = new Set<string>();
  private readonly processOperations = new SerializedProcessOperations();
  private readonly postResponseOperations = new BrokerPostResponseOperations();
  private readonly processRedaction = new Map<string, ProcessRedaction>();
  private readonly lost = new Map<string, ProcessHandle>();
  private readonly outputArtifacts: BrokerOutputArtifactImporter;
  private readonly lifecycle: BrokerClientLifecycle;
  private readonly trustedToolchains: NormalizedTrustedToolchain[];
  private state: ClientState = "new";
  private instanceId?: string;
  private connectOperation?: Promise<BrokerDoctorReport>;
  private closeRequested = false;
  private doctorValue?: BrokerDoctorReport;
  constructor(private readonly options: SigmaExecBrokerClientOptions) {
    if (!options.helperPath) throw new BrokerPolicyError("sigma-exec helperPath is required.");
    positiveInteger(options.cancellationGraceMs, 10_000, "cancellationGraceMs");
    this.trustedToolchains = normalizeTrustedToolchains(options.trustedToolchains);
    this.redactor = new SecretRedactor(options.secrets);
    this.transport = new BrokerTransport(options, (error) =>
      containTransportFailure(error, () => this.markProcessesLost(), async () => await this.lifecycle.close()));
    this.outputArtifacts = new BrokerOutputArtifactImporter(this.redactor, async (artifactIds) =>
      await this.transport.request("artifact.release", { artifactIds }, { timeoutMs: 5_000 })
    );
    this.lifecycle = new BrokerClientLifecycle(
      () => { this.closeRequested = true; },
      async () => {
        this.markProcessesLost();
        try { await this.transport.close(); }
        finally { await this.connectOperation?.catch(() => undefined); }
      },
      async () => await this.postResponseOperations.waitForIdle(),
      async () => await this.outputArtifacts.cleanup(),
      (closed) => {
        this.cursors.clear();
        this.activeProcesses.clear();
        this.processRedaction.clear();
        this.state = closed ? "closed" : "failed";
      }
    );
  }
  get lostProcessHandles(): readonly ProcessHandle[] { return [...this.lost.values()]; }
  get stderr(): string { return this.transport.stderr; }
  async connect(signal?: AbortSignal): Promise<BrokerDoctorReport> {
    if (this.state !== "new") throw new BrokerConnectionError(`Cannot connect broker client in '${this.state}' state.`);
    const operation = this.connectOnce(signal);
    this.connectOperation = operation;
    return await operation;
  }
  private async connectOnce(signal?: AbortSignal): Promise<BrokerDoctorReport> {
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
      const report = parseDoctor(await this.transport.request("doctor", {}, {
        signal,
        timeoutMs: this.options.startupTimeoutMs
          ?? this.options.requestTimeoutMs
          ?? DEFAULT_STARTUP_TIMEOUT_MS
      }));
      assertRequiredSandbox(report, this.options.sandboxMode);
      if (this.closeRequested) {
        throw new BrokerConnectionError("Broker client was closed during startup.", { retrySafe: true });
      }
      this.doctorValue = report;
      this.state = "ready";
      return report;
    } catch (error) {
      // An explicit close owns shutdown and waits for this startup operation to
      // settle before deleting its artifact root. Avoid racing that cleanup.
      if (this.closeRequested) throw error;
      this.state = "failed";
      const failure = error instanceof Error ? error : new BrokerConnectionError(String(error));
      try {
        await this.transport.close();
      } catch (shutdownError) {
        throw attachBrokerLifecycleFailure(
          failure, shutdownError,
          "Broker startup failed and the helper process could not be confirmed closed."
        );
      }
      try {
        await this.outputArtifacts.cleanup();
      } catch (cleanupError) {
        throw attachBrokerLifecycleFailure(
          failure, cleanupError,
          "Broker startup failed and output artifact cleanup also failed."
        );
      }
      throw failure;
    }
  }
  async doctor(signal?: AbortSignal): Promise<BrokerDoctorReport> {
    this.assertReady();
    const report = await requestVerifiedSandboxReport({
      transport: this.transport, method: "doctor",
      timeoutMs: this.options.requestTimeoutMs ?? DEFAULT_DOCTOR_TIMEOUT_MS, signal,
      closeRequested: () => this.closeRequested,
      close: async () => await this.close(), closedMessage: "Broker client closed during doctor response."
    });
    this.doctorValue = report;
    return report;
  }
  async setupSandbox(signal?: AbortSignal): Promise<BrokerDoctorReport> {
    this.assertReady();
    const report = await requestVerifiedSandboxReport({
      transport: this.transport, method: "sandbox.setup",
      timeoutMs: this.options.startupTimeoutMs ?? this.options.requestTimeoutMs ?? DEFAULT_SANDBOX_SETUP_TIMEOUT_MS,
      signal, closeRequested: () => this.closeRequested,
      close: async () => await this.close(), closedMessage: "Broker client closed during setup response."
    });
    this.doctorValue = report;
    return report;
  }
  async repairSandbox(signal?: AbortSignal): Promise<BrokerDoctorReport> {
    this.assertReady();
    return await requestSandboxReport(
      this.transport, "sandbox.repair",
      this.options.startupTimeoutMs ?? this.options.requestTimeoutMs ?? DEFAULT_SANDBOX_SETUP_TIMEOUT_MS,
      signal
    );
  }
  async sandboxLeaseStatus(workspacePath: string, signal?: AbortSignal): Promise<BrokerSandboxLeaseStatus> {
    this.assertReady();
    return await requestSandboxLeaseStatus(this.transport, workspacePath, this.options.requestTimeoutMs, signal);
  }
  async revokeSandboxLease(workspacePath: string, signal?: AbortSignal): Promise<BrokerSandboxRevokeResult> {
    this.assertReady();
    return await requestSandboxLeaseRevoke(this.transport, workspacePath, this.options.requestTimeoutMs, signal);
  }
  async execute(request: ExecutionRequest, options: BrokerRequestOptions = {}): Promise<ExecutionResult> {
    this.assertReady();
    assertRequestSandbox(request.policy, this.doctorValue);
    const timeoutMs = positiveInteger(request.timeoutMs, 120_000, "timeoutMs");
    const params = {
      ...requestParams(request, this.options, this.trustedToolchains, this.verifiedShellExecutables()), timeoutMs,
      ...(request.idleTimeoutMs === undefined ? {} : {
        idleTimeoutMs: positiveInteger(request.idleTimeoutMs, 30_000, "idleTimeoutMs")
      })
    };
    return await runPostResponseOperation(this.postResponseOperations, async () => {
      const value = await requestExecutionValue(
        this.transport, params, options, timeoutMs, async () => await this.closeForActiveOperation()
      );
      const decodingError = outputDecodingError(value);
      if (decodingError) {
        await rejectUndecodableExecution(
          this.transport, value, decodingError, async () => await this.closeForActiveOperation()
        );
      }
      const outputArtifacts = await this.outputArtifacts.consume(value.outputArtifacts).catch(
        async (error: unknown) => await containPostDispatchFailure(
          error, async () => await this.closeForActiveOperation()
        )
      );
      return decodedExecutionResult(value, this.redactor, outputArtifacts);
    }, async () => await this.close());
  }
  async spawn(request: ProcessSpawnRequest, options: BrokerRequestOptions = {}): Promise<ProcessHandle> {
    this.assertReady();
    assertRequestSandbox(request.policy, this.doctorValue);
    if (options.signal?.aborted) throw cancellationError(options.signal);
    let cancelled = false;
    const onAbort = (): void => { cancelled = true; };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      // Receive a racing process handle first, then terminate it durably.
      let spawned: ReturnType<typeof parseSpawnedProcess>;
      try {
        spawned = await parsePostDispatchValue(
          await this.transport.request(
            "process.spawn",
            requestParams(request, this.options, this.trustedToolchains, this.verifiedShellExecutables()),
            { ...options, signal: undefined }
          ), parseSpawnedProcess, async () => await this.close()
        );
      } catch (error) {
        if (error instanceof BrokerTimeoutError && !error.preDispatch) {
          return await containPostDispatchFailure(error, async () => await this.close());
        }
        throw error;
      }
      // The spawn was already dispatched, so a close race must never carry
      // the pre-dispatch retrySafe marker used by assertReady(). Once ready is
      // confirmed, unique-id reservation and registration stay synchronous.
      if (this.state !== "ready" || this.closeRequested) {
        throw new BrokerConnectionError(
          "Background process spawn completed after broker shutdown began."
        );
      }
      const reuse = reserveProcessId(spawned.id, this.seenProcessIds);
      if (reuse) return await containReusedProcessId(reuse, async () => await this.close());
      const handle = {
        id: spawned.id,
        brokerInstanceId: this.instanceId!,
        systemProcessId: spawned.systemProcessId,
        lifecycle: request.lifecycle ?? "session"
      };
      this.cursors.set(handle.id, { stdout: 0, stderr: 0 });
      this.activeProcesses.set(handle.id, handle);
      this.processRedaction.set(handle.id, createProcessRedaction(this.redactor, request.outputRedaction));
      if (!cancelled) return handle;
      return await settleCancelledSpawn(
        options.signal, async () => await this.terminate(handle), async () => await this.close()
      );
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
    }
  }
  async poll(handle: ProcessHandle, options: BrokerRequestOptions = {}): Promise<ProcessPollResult> {
    return await runPostResponseOperation(this.postResponseOperations, async () =>
      await this.processOperations.run(handle.id, async () => {
        this.assertHandle(handle);
        const cursor = this.cursors.get(handle.id)!;
        const value = await parsePostDispatchValue(
          await this.transport.request("process.poll", {
            handleId: handle.id, stdoutOffset: cursor.stdout, stderrOffset: cursor.stderr
          }, options), parseProcessValue, async () => await this.closeForActiveOperation()
        );
        cursor.stdout = value.stdout.nextOffset;
        cursor.stderr = value.stderr.nextOffset;
        return await this.processResult(handle, value);
      }), async () => await this.close());
  }
  async write(handle: ProcessHandle, data: string, options: BrokerRequestOptions = {}): Promise<void> {
    return await this.processOperations.run(handle.id, async () => {
      this.assertHandle(handle);
      if (typeof data !== "string" || data.includes("\0")) throw new BrokerPolicyError("Process input must be a NUL-free string.");
      await this.transport.request("process.write", { handleId: handle.id, data }, options).catch(async (error: unknown) => {
        if ((error instanceof BrokerTimeoutError || error instanceof BrokerCancelledError)
          && !error.preDispatch) return await containPostDispatchFailure(error, async () => await this.close());
        throw error;
      });
    });
  }
  async terminate(handle: ProcessHandle, options: BrokerRequestOptions = {}): Promise<ProcessPollResult> {
    return await runPostResponseOperation(this.postResponseOperations, async () =>
      await this.processOperations.run(handle.id, async () => {
        this.assertHandle(handle);
        const cursor = this.cursors.get(handle.id)!;
        const value = await parsePostDispatchValue(
          await this.transport.request("process.terminate", {
            handleId: handle.id, stdoutOffset: cursor.stdout, stderrOffset: cursor.stderr
          }, options), parseProcessValue, async () => await this.closeForActiveOperation()
        );
        cursor.stdout = value.stdout.nextOffset;
        cursor.stderr = value.stderr.nextOffset;
        return await this.processResult(handle, value);
      }), async () => await this.close());
  }
  async handoff(handle: ProcessHandle, options: BrokerRequestOptions = {}): Promise<ProcessHandoffResult> {
    return await runPostResponseOperation(this.postResponseOperations, async () =>
      await this.processOperations.run(handle.id, async () => {
        this.assertHandle(handle);
        if (handle.lifecycle !== "deliverable") {
          throw new BrokerPolicyError("Only a deliverable process may be handed off.");
        }
        const value = await parsePostDispatchValue(
          await this.transport.request("process.handoff", { handleId: handle.id }, options),
          parseProcessHandoff,
          async () => await this.closeForActiveOperation()
        );
        this.cursors.delete(handle.id);
        this.activeProcesses.delete(handle.id);
        this.processRedaction.delete(handle.id);
        return {
          handle,
          handoffId: value.handoffId,
          ...(value.systemProcessId === undefined ? {} : { systemProcessId: value.systemProcessId })
        };
      }), async () => await this.close());
  }
  async releaseOutputArtifacts(artifactIds: string[]): Promise<void> {
    this.assertReady();
    await runPostResponseOperation(this.postResponseOperations, async () => {
      await this.outputArtifacts.acknowledge(artifactIds).catch(
        async (error: unknown) => await containPostDispatchFailure(
          error, async () => await this.closeForActiveOperation()
        )
      );
    }, async () => await this.close());
  }
  async close(): Promise<void> {
    await this.lifecycle.close();
  }
  private async closeForActiveOperation(): Promise<void> {
    await this.lifecycle.closeForActiveOperation();
  }
  private async processResult(handle: ProcessHandle, value: ReturnType<typeof parseProcessValue>): Promise<ProcessPollResult> {
    const decodingError = outputDecodingError(value);
    if (decodingError) {
      await containPostDispatchFailure(decodingError, async () => await this.closeForActiveOperation());
    }
    const streams = this.processRedaction.get(handle.id) ?? createProcessRedaction(this.redactor);
    this.processRedaction.set(handle.id, streams);
    const final = value.state !== "running";
    const stdout = streams.stdout.push(value.stdout.data, {
      final, discontinuity: value.stdout.droppedBytes > 0
    });
    let stderr = streams.stderr.push(value.stderr.data, {
      final, discontinuity: value.stderr.droppedBytes > 0
    });
    const failure = value.failure ? {
      ...value.failure,
      message: this.redactor.redactText(value.failure.message)
    } : undefined;
    if (failure) {
      stderr = `sigma-exec sandbox launch failed [${failure.code}]: ${failure.message}`;
    }
    if (final) this.processRedaction.delete(handle.id);
    const outputArtifacts = await this.outputArtifacts.consume(value.outputArtifacts).catch(
      async (error: unknown) => await containPostDispatchFailure(
        error, async () => await this.closeForActiveOperation()
      )
    );
    const result: ProcessPollResult = {
      handle, state: value.state, exitCode: value.exitCode, signal: value.signal, durationMs: value.durationMs,
      stdout, stderr,
      stdoutDroppedBytes: value.stdout.droppedBytes, stderrDroppedBytes: value.stderr.droppedBytes,
      outputTruncated: value.stdout.droppedBytes > 0 || value.stderr.droppedBytes > 0,
      ...(failure ? { failure } : {}),
      ...(outputArtifacts.length > 0 ? { outputArtifacts } : {})
    };
    if (final) {
      await this.transport.request("process.release", { handleId: handle.id }, { timeoutMs: 5_000 }).catch(
        async (error: unknown) => await containPostDispatchFailure(
          error, async () => await this.closeForActiveOperation()
        )
      );
      this.cursors.delete(handle.id);
      this.activeProcesses.delete(handle.id);
    }
    return result;
  }
  private verifiedShellExecutables(): string[] {
    return this.doctorValue?.capabilities.shells
      ?.filter((shell) => shell.verified)
      .map((shell) => shell.executable) ?? [];
  }
  private assertHandle(handle: ProcessHandle): void {
    if (handle.brokerInstanceId !== this.instanceId) throw new BrokerProcessLostError(handle.id);
    if (this.lost.has(handle.id) || !this.cursors.has(handle.id)) throw new BrokerProcessLostError(handle.id);
    this.assertReady();
  }
  private assertReady(): void {
    if (this.state !== "ready") {
      throw new BrokerConnectionError(`Broker client is not ready (state: ${this.state}).`, { retrySafe: true });
    }
  }
  private markProcessesLost(): void {
    if (this.state === "closed") return;
    for (const [id, handle] of this.activeProcesses) this.lost.set(id, handle);
    this.cursors.clear();
    this.activeProcesses.clear();
    this.processRedaction.clear();
    this.state = "failed";
  }
}
