import { BrokerTransport } from "./broker-transport.js";
import { verifiedShellExecutables, verifiedTargetExecutableEnvironment } from "./broker-doctor-projection.js";
import { BrokerScratchLeaseClient } from "./broker-client-scratch-lease.js";
import { startBrokerClient } from "./broker-client-startup.js";
import { requestSandboxLeaseRevoke, requestSandboxLeaseStatus, requestSandboxReport, requestVerifiedSandboxReport } from "./broker-sandbox-operations.js";
import {
  assertRequestSandbox, cancellationError,
  BrokerClientLifecycle, BrokerPostResponseOperations, containPostDispatchFailure, containTransportFailure,
  containReusedProcessId, createProcessRedaction,
  DEFAULT_DOCTOR_TIMEOUT_MS, DEFAULT_SANDBOX_SETUP_TIMEOUT_MS,
  outputDecodingError, parsePostDispatchValue,
  reserveProcessId, runPostResponseOperation, SerializedProcessOperations,
  type ClientState, type Cursor, type ProcessRedaction
} from "./broker-client-support.js";
import { settleCancelledSpawn } from "./broker-client-cancellation.js";
import { decodedProcessPollResult } from "./broker-process-result.js";
import { attachBrokerLifecycleFailure, BrokerCancelledError, BrokerConnectionError,
  BrokerPolicyError, BrokerProcessLostError, BrokerTimeoutError } from "./errors.js";
import { BrokerOutputArtifactImporter } from "./output-artifact-import.js";
import { executeBrokerForeground } from "./broker-client-foreground.js";
import { positiveInteger, requestParams } from "./broker-request-policy.js";
import { SecretRedactor } from "./redaction.js";
import { normalizeTrustedToolchains, type NormalizedTrustedToolchain } from "./trusted-toolchains.js";
import { requestManagedEnvironmentPreparation } from "./broker-client-managed-environment.js";
import {
  BrokerRepositoryEnvironmentClient,
  invokeBrokerClientRepositoryOperation
} from "./broker-client-repository-environment.js";
import {
  RepositoryExecutionBrokerBase,
  type RepositoryOperationMethod
} from "./repository-execution-broker-base.js";
import type { BrokerDoctorReport, BrokerRequestOptions, BrokerSandboxLeaseStatus, BrokerSandboxRevokeResult,
  ExecutionBroker, ExecutionRequest, ExecutionResult, ProcessHandle, ProcessHandoffResult,
  ManagedEnvironmentPrepareRequestV1, ManagedEnvironmentPrepareResultV1,
  ProcessPollResult, ProcessSpawnRequest, ScratchLeaseRequestV1, ScratchLeaseV1,
  SigmaExecBrokerClientOptions } from "./types.js";
import { parseProcessHandoff, parseProcessValue, parseSpawnedProcess } from "./values.js";
export class SigmaExecBrokerClient extends RepositoryExecutionBrokerBase implements ExecutionBroker {
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
  private readonly scratchLeases: BrokerScratchLeaseClient;
  private readonly repositoryEnvironment: BrokerRepositoryEnvironmentClient;
  constructor(private readonly options: SigmaExecBrokerClientOptions) {
    super();
    const transports = [options.helperPath, options.socketPath, options.trustedStream].filter(Boolean);
    if (transports.length !== 1) {
      throw new BrokerPolicyError(
        "Exactly one sigma-exec helperPath, trusted socketPath, or trusted stream is required."
      );
    }
    positiveInteger(options.cancellationGraceMs, 10_000, "cancellationGraceMs");
    this.trustedToolchains = normalizeTrustedToolchains(options.trustedToolchains);
    this.redactor = new SecretRedactor(options.secrets);
    this.transport = new BrokerTransport(options, (error) =>
      containTransportFailure(error, () => this.markProcessesLost(), async () => await this.lifecycle.close()));
    this.scratchLeases = new BrokerScratchLeaseClient(this.transport);
    this.repositoryEnvironment = new BrokerRepositoryEnvironmentClient(this.transport);
    this.outputArtifacts = new BrokerOutputArtifactImporter(this.redactor, async (artifactIds) =>
      await this.transport.request("artifact.release", { artifactIds }, { timeoutMs: 5_000 }),
      undefined,
      options.artifactRootParent
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
        this.scratchLeases.clear();
        this.repositoryEnvironment.clear();
        this.state = closed ? "closed" : "failed";
      }
    );
  }
  get lostProcessHandles(): readonly ProcessHandle[] { return [...this.lost.values()]; }
  get stderr(): string { return this.transport.stderr; }
  async connect(signal?: AbortSignal): Promise<BrokerDoctorReport> {
    if (this.state !== "new") throw new BrokerConnectionError(`Cannot connect broker client in '${this.state}' state.`);
    const operation = this.connectOnce("doctor", signal);
    this.connectOperation = operation;
    return await operation;
  }
  private async connectOnce(initialReport: "doctor" | "sandbox.setup", signal?: AbortSignal):
  Promise<BrokerDoctorReport> {
    this.state = "connecting";
    try {
      const startup = await startBrokerClient(
        this.transport, this.options, this.trustedToolchains, initialReport,
        async (artifactRoot) => await this.outputArtifacts.configureRoot(artifactRoot), signal
      );
      this.instanceId = startup.instanceId;
      if (this.closeRequested) {
        throw new BrokerConnectionError("Broker client was closed during startup.", { retrySafe: true });
      }
      this.doctorValue = startup.report;
      this.state = "ready";
      return startup.report;
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
    if (this.state === "new") {
      const operation = this.connectOnce("sandbox.setup", signal);
      this.connectOperation = operation;
      return await operation;
    }
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
  async acquireScratchLease(request: ScratchLeaseRequestV1, options: BrokerRequestOptions = {}): Promise<ScratchLeaseV1> {
    this.assertReady(); return await this.scratchLeases.acquire(request, options);
  }
  async releaseScratchLease(sessionId: string, options: BrokerRequestOptions = {}): Promise<void> {
    this.assertReady(); await this.scratchLeases.release(sessionId, { ...options, timeoutMs: options.timeoutMs ?? 5_000 });
  }
  protected async repositoryOperation(
    method: RepositoryOperationMethod,
    request: unknown,
    options: BrokerRequestOptions = {}
  ): Promise<unknown> {
    this.assertReady();
    return await invokeBrokerClientRepositoryOperation(
      this.transport, this.repositoryEnvironment, method, request, options
    );
  }
  async prepareManagedEnvironment(request: ManagedEnvironmentPrepareRequestV1, options: BrokerRequestOptions = {}):
  Promise<ManagedEnvironmentPrepareResultV1> {
    this.assertReady(); return await requestManagedEnvironmentPreparation(this.transport, this.doctorValue, request, options);
  }
  async execute(request: ExecutionRequest, options: BrokerRequestOptions = {}): Promise<ExecutionResult> {
    this.assertReady();
    return await executeBrokerForeground({
      transport: this.transport, options: this.options,
      trustedToolchains: this.trustedToolchains, doctorValue: this.doctorValue,
      postResponseOperations: this.postResponseOperations,
      outputArtifacts: this.outputArtifacts, redactor: this.redactor,
      closeForActiveOperation: async () => await this.closeForActiveOperation(),
      close: async () => await this.close()
    }, request, options);
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
            requestParams(
              request,
              this.options,
              this.trustedToolchains,
              verifiedShellExecutables(this.doctorValue),
              verifiedTargetExecutableEnvironment(this.options.executionBackend, this.doctorValue)
            ),
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
    if (final) this.processRedaction.delete(handle.id);
    const outputArtifacts = await this.outputArtifacts.consume(value.outputArtifacts).catch(
      async (error: unknown) => await containPostDispatchFailure(
        error, async () => await this.closeForActiveOperation()
      )
    );
    const result = decodedProcessPollResult(handle, value, streams, this.redactor, outputArtifacts);
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
