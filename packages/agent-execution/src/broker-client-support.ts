import { BrokerTransport, takeCancelledTerminalResponse } from "./broker-transport.js";
import {
  BrokerCancelledError,
  BrokerConnectionError,
  BrokerOutputDecodingError,
  BrokerProtocolError,
  BrokerTimeoutError,
  SandboxUnavailableError,
  attachBrokerLifecycleFailure,
  isBrokerGenerationTerminalError,
  markBrokerGenerationTerminal
} from "./errors.js";
import { SecretRedactor, type SecretRedactionStream } from "./redaction.js";
import type {
  BrokerDoctorReport,
  BrokerRequestOptions,
  ExecutionResult,
  ExecutionPolicy,
  ProcessOutputArtifact,
  ProcessSpawnRequest,
  SigmaExecBrokerClientOptions
} from "./types.js";
import { parseExecutionValue, type ProcessValue } from "./values.js";

export type ClientState = "new" | "connecting" | "ready" | "failed" | "closed";

export interface Cursor {
  stdout: number;
  stderr: number;
}

interface RedactionStream {
  push(input: string, options?: { final?: boolean; discontinuity?: boolean }): string;
}

export interface ProcessRedaction {
  stdout: RedactionStream;
  stderr: SecretRedactionStream;
}

export class SerializedProcessOperations {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => current, () => current);
    this.tails.set(key, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}

export class BrokerPostResponseOperations {
  private active = 0;
  private idlePromise?: Promise<void>;
  private resolveIdle?: () => void;

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.active === 0) {
      this.idlePromise = new Promise<void>((resolve) => { this.resolveIdle = resolve; });
    }
    this.active += 1;
    try {
      return await operation();
    } finally {
      this.active -= 1;
      if (this.active === 0) {
        this.resolveIdle?.();
        this.resolveIdle = undefined;
      }
    }
  }

  async waitForIdle(): Promise<void> {
    if (this.active > 0) await this.idlePromise;
  }
}

export class BrokerClientLifecycle {
  private closePromise?: Promise<void>;
  private stopPromise?: Promise<void>;

  constructor(
    private readonly requestClose: () => void,
    private readonly stopTransport: () => Promise<void>,
    private readonly waitForOperations: () => Promise<void>,
    private readonly cleanup: () => Promise<void>,
    private readonly finish: (closed: boolean) => void
  ) {}

  async close(): Promise<void> {
    this.requestClose();
    const operation = this.closePromise ?? this.closeOnce();
    this.closePromise = operation;
    let failed = true;
    try {
      await operation;
      failed = false;
    } finally {
      if (failed && this.closePromise === operation) this.closePromise = undefined;
    }
  }

  async closeForActiveOperation(): Promise<void> {
    this.requestClose();
    this.closePromise ??= this.closeOnce();
    void this.closePromise.catch(() => undefined);
    await this.stop();
  }

  private async closeOnce(): Promise<void> {
    try {
      await this.stop();
      await this.waitForOperations();
      await this.cleanup();
      this.finish(true);
    } catch (error) {
      this.finish(false);
      throw error;
    }
  }

  private async stop(): Promise<void> {
    const operation = this.stopPromise ?? this.stopTransport();
    this.stopPromise = operation;
    let failed = true;
    try {
      await operation;
      failed = false;
    } finally {
      if (failed && this.stopPromise === operation) this.stopPromise = undefined;
    }
  }
}

export async function runPostResponseOperation<T>(
  operations: BrokerPostResponseOperations,
  operation: () => Promise<T>,
  closeClient: () => Promise<void>
): Promise<T> {
  try {
    return await operations.run(operation);
  } catch (error) {
    if (!(error instanceof Error) || !isBrokerGenerationTerminalError(error)) throw error;
    try {
      // The operation lease has been released, so a full close can now drain
      // every other post-response consumer without waiting on itself.
      await closeClient();
    } catch (closeError) {
      attachBrokerLifecycleFailure(error, closeError, "Post-response broker cleanup failed.");
    }
    throw error;
  }
}

export function assertRequiredSandbox(
  report: BrokerDoctorReport,
  sandboxMode: SigmaExecBrokerClientOptions["sandboxMode"]
): void {
  if ((sandboxMode ?? "required") === "required"
    && (!report.sandbox.available || !report.sandbox.selfTestPassed)) {
    throw new SandboxUnavailableError(
      report.sandbox.reason ?? "Required sandbox self-test failed.", report.sandbox
    );
  }
}

export function assertRequestSandbox(
  policy: ExecutionPolicy,
  report: BrokerDoctorReport | undefined
): void {
  if (policy.sandbox === "required" && (!report?.sandbox.available || !report.sandbox.selfTestPassed)) {
    throw new SandboxUnavailableError(report?.sandbox.reason ?? "Required sandbox is unavailable.");
  }
}

export function reserveProcessId(
  id: string,
  seen: Set<string>
): BrokerProtocolError | undefined {
  if (!seen.has(id)) {
    seen.add(id);
    return undefined;
  }
  return new BrokerProtocolError(`Broker reused process handle '${id}'.`);
}

export async function containReusedProcessId(
  error: BrokerProtocolError,
  closeClient: () => Promise<void>
): Promise<never> {
  return await containPostDispatchFailure(error, closeClient);
}

export const DEFAULT_DOCTOR_TIMEOUT_MS = 15_000;

export function defaultBrokerStartupTimeoutMs(platform: NodeJS.Platform = process.platform): number {
  // Windows may replay multiple bounded ACL recovery journals before its
  // AppContainer and ConPTY self-tests. Other platforms have no such work and
  // must not inherit a ten-minute pre-runtime startup stall.
  return platform === "win32" ? 10 * 60_000 : DEFAULT_DOCTOR_TIMEOUT_MS;
}

export function defaultSandboxSetupTimeoutMs(platform: NodeJS.Platform = process.platform): number {
  return platform === "win32" ? 10 * 60_000 : 60_000;
}

export const DEFAULT_STARTUP_TIMEOUT_MS = defaultBrokerStartupTimeoutMs();
export const DEFAULT_SANDBOX_SETUP_TIMEOUT_MS = defaultSandboxSetupTimeoutMs();

export function cancellationError(signal?: AbortSignal): BrokerCancelledError {
  const cause = signal?.reason instanceof Error ? signal.reason : undefined;
  return new BrokerCancelledError(cause?.message ?? "Execution request cancelled.", { cause });
}

export async function containPostDispatchFailure(
  error: unknown,
  closeClient: () => Promise<void>
): Promise<never> {
  const failure = error instanceof Error ? error : new BrokerProtocolError(String(error));
  markBrokerGenerationTerminal(failure);
  try {
    await closeClient();
  } catch (closeError) {
    attachBrokerLifecycleFailure(
      failure, closeError, "Post-dispatch broker protocol containment failed."
    );
  }
  throw failure;
}

export function containTransportFailure(
  error: Error,
  markProcessesLost: () => void,
  closeClient: () => Promise<void>
): void {
  if (!(error instanceof BrokerConnectionError)) markBrokerGenerationTerminal(error);
  markProcessesLost();
  void closeClient().catch((closeError: unknown) => {
    attachBrokerLifecycleFailure(error, closeError, "Failed transport containment did not close cleanly.");
  });
}

export async function parsePostDispatchValue<T>(
  value: unknown,
  parse: (input: unknown) => T,
  closeClient: () => Promise<void>
): Promise<T> {
  try {
    return parse(value);
  } catch (error) {
    return await containPostDispatchFailure(error, closeClient);
  }
}

export function outputDecodingError(value: ProcessValue): BrokerOutputDecodingError | undefined {
  const failure = (["stdout", "stderr"] as const).flatMap((stream) => {
    const decodingError = value[stream].decodingError;
    return decodingError ? [{ stream, ...decodingError }] : [];
  })[0];
  return failure
    ? new BrokerOutputDecodingError(failure.stream, failure.code, failure.message)
    : undefined;
}

export async function rejectUndecodableExecution(
  transport: BrokerTransport,
  value: ReturnType<typeof parseExecutionValue>,
  error: BrokerOutputDecodingError,
  closeClient: () => Promise<void>
): Promise<never> {
  const artifactIds = value.outputArtifacts.map((artifact) => artifact.artifactId);
  if (artifactIds.length === 0) throw error;
  try {
    await transport.request("artifact.release", { artifactIds }, { timeoutMs: 5_000 });
  } catch (releaseError) {
    attachBrokerLifecycleFailure(
      error, releaseError, "Undecodable foreground output artifact release failed."
    );
    return await containPostDispatchFailure(error, closeClient);
  }
  throw error;
}

export function createProcessRedaction(
  redactor: SecretRedactor,
  mode: ProcessSpawnRequest["outputRedaction"] = "default"
): ProcessRedaction {
  return {
    stdout: mode === "framed_jsonrpc"
      ? redactor.createFramedJsonRpcStream()
      : redactor.createStream(mode),
    stderr: redactor.createStream()
  };
}

export function decodedExecutionResult(
  value: ReturnType<typeof parseExecutionValue>,
  redactor: SecretRedactor,
  outputArtifacts: ProcessOutputArtifact[]
): ExecutionResult {
  const failure = value.failure ? {
    ...value.failure,
    message: redactor.redactText(value.failure.message)
  } : undefined;
  return {
    state: value.state, exitCode: value.exitCode, signal: value.signal, durationMs: value.durationMs,
    timedOut: value.timedOut, idleTimedOut: value.idleTimedOut, cancelled: value.cancelled,
    stdout: value.stdout.droppedBytes > 0
      ? "[REDACTED:truncated-output]" : redactor.redactText(value.stdout.data),
    stderr: failure
      ? `sigma-exec sandbox launch failed [${failure.code}]: ${failure.message}`
      : value.stderr.droppedBytes > 0
      ? "[REDACTED:truncated-output]" : redactor.redactText(value.stderr.data),
    stdoutDroppedBytes: value.stdout.droppedBytes, stderrDroppedBytes: value.stderr.droppedBytes,
    outputTruncated: value.stdout.droppedBytes > 0 || value.stderr.droppedBytes > 0,
    ...(failure ? { failure } : {}),
    ...(outputArtifacts.length > 0 ? { outputArtifacts } : {})
  };
}

export async function requestExecutionValue(
  transport: BrokerTransport,
  params: Record<string, unknown>,
  options: BrokerRequestOptions,
  timeoutMs: number,
  closeClient: () => Promise<void>
): Promise<ReturnType<typeof parseExecutionValue>> {
  let response: unknown;
  try {
    response = await transport.request("exec", params, {
      ...options, timeoutMs: options.timeoutMs ?? timeoutMs + 5_000
    });
  } catch (error) {
    const terminalResponse = takeCancelledTerminalResponse(error);
    if (error instanceof BrokerProtocolError && !terminalResponse && !transport.running) {
      return await containPostDispatchFailure(error, closeClient);
    }
    if (error instanceof Error && (terminalResponse
      || (!transport.running
        && (error instanceof BrokerCancelledError || error instanceof BrokerTimeoutError)))) {
      await containCancelledExecution(transport, closeClient, error, terminalResponse);
    }
    throw error;
  }
  return await parsePostDispatchValue(response, parseExecutionValue, closeClient);
}

async function containCancelledExecution(
  transport: BrokerTransport,
  closeClient: () => Promise<void>,
  error: Error,
  terminalResponse?: { result: unknown }
): Promise<void> {
  let cleanupFailed = false;
  let cleanupFailure: unknown;
  if (terminalResponse) {
    try {
      // A cancelled caller must never receive the terminal output, but the
      // broker still owns any overflow artifacts named by that response.
      const terminal = parseExecutionValue(terminalResponse.result);
      const artifactIds = terminal.outputArtifacts.map((artifact) => artifact.artifactId);
      if (artifactIds.length > 0) {
        await transport.request("artifact.release", { artifactIds }, { timeoutMs: 5_000 });
      }
    } catch (failure) {
      cleanupFailed = true;
      cleanupFailure = failure;
    }
  }
  if (!cleanupFailed && transport.running) return;

  // Either cancellation grace already contained the helper or a malformed /
  // unacknowledged terminal response made targeted cleanup unsafe. Closing the
  // client is the generic containment fallback and invalidates handles.
  markBrokerGenerationTerminal(error);
  try {
    await closeClient();
  } catch (closeFailure) {
    const lifecycleFailure = cleanupFailed
      ? new AggregateError(
        [cleanupFailure, closeFailure],
        "Cancelled execution output cleanup and broker shutdown failed.",
        { cause: closeFailure }
      )
      : closeFailure;
    attachBrokerLifecycleFailure(
      error, lifecycleFailure, "Cancelled execution containment failed."
    );
  }
}
