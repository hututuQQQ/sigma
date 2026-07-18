import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  BrokerCancelledError,
  BrokerConnectionError,
  BrokerError,
  BrokerExecutableUnavailableError,
  BrokerPolicyError,
  BrokerProtocolError,
  BrokerTimeoutError,
  SandboxUnavailableError,
  attachBrokerLifecycleFailure
} from "./errors.js";
import { createMinimalEnvironment } from "./environment.js";
import { BrokerFrameDecoder, encodeBrokerFrame } from "./framing.js";
import { brokerRequest, parseBrokerResponse } from "./protocol.js";
import { SecretRedactor } from "./redaction.js";
import { BoundedByteRingBuffer } from "./ring-buffer.js";
import type { BrokerRequestOptions, SigmaExecBrokerClientOptions } from "./types.js";

type TransportState = "new" | "running" | "closing" | "closed" | "failed";
const rawOutputMethods = new Set(["exec", "process.poll", "process.terminate"]);

interface PendingRequest {
  id: number;
  method: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  signal?: AbortSignal;
  onAbort?: () => void;
  timer?: ReturnType<typeof setTimeout>;
  deferredError?: Error;
  dispatched?: boolean;
}

interface CancelledTerminalResponse {
  result: unknown;
}

const cancelledTerminalResponses = new WeakMap<Error, CancelledTerminalResponse>();

/** Consume the otherwise private terminal response paired with a cancelled exec. */
export function takeCancelledTerminalResponse(error: unknown): CancelledTerminalResponse | undefined {
  if (!(error instanceof Error)) return undefined;
  const response = cancelledTerminalResponses.get(error);
  if (response) cancelledTerminalResponses.delete(error);
  return response;
}

function transportWideFailure(error: Error): Error {
  if (!(error instanceof BrokerConnectionError) || !error.retrySafe) return error;
  return new BrokerConnectionError(
    "Broker transport became unavailable while other requests may already have been dispatched.",
    { cause: error, diagnostic: { dispatchFailure: error.data } }
  );
}

function rpcError(code: string, message: string, data?: unknown): BrokerError {
  if (code === "sandbox_unavailable") return new SandboxUnavailableError(message, data);
  if (code === "executable_unavailable") return new BrokerExecutableUnavailableError(message, data);
  if (code === "policy_denied") return new BrokerPolicyError(message, data);
  if (code === "cancelled") return new BrokerCancelledError(message);
  return new BrokerError(message, code, data);
}

export class BrokerTransport {
  private readonly decoder: BrokerFrameDecoder;
  private readonly stderrBuffer: BoundedByteRingBuffer;
  private readonly redactor: SecretRedactor;
  private readonly pending = new Map<number, PendingRequest>();
  private child?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private state: TransportState = "new";
  private writeChain = Promise.resolve();
  private closePromise?: Promise<void>;
  private closingRequested = false;
  private childClosed = false;
  private terminalFailure?: Error;

  constructor(
    private readonly options: SigmaExecBrokerClientOptions,
    private readonly onUnexpectedFailure: (error: Error) => void
  ) {
    this.decoder = new BrokerFrameDecoder(options.maximumFrameBytes);
    this.stderrBuffer = new BoundedByteRingBuffer(options.maximumStderrBytes ?? 256 * 1024);
    this.redactor = new SecretRedactor(options.secrets);
  }

  get stderr(): string { return this.redactor.redactText(this.stderrBuffer.text()); }
  get running(): boolean { return this.state === "running"; }

  start(): void {
    if (this.state !== "new") throw new BrokerConnectionError(`Cannot start broker transport in '${this.state}' state.`);
    const args = [...(this.options.helperArgs ?? [])];
    const child = spawn(this.options.helperPath, args, {
      cwd: process.cwd(), env: createMinimalEnvironment(), windowsHide: true, shell: false,
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.child = child;
    this.childClosed = false;
    this.state = "running";
    child.stdout.on("data", (chunk: Buffer) => this.onStdout(chunk));
    child.stderr.on("data", (chunk: Buffer) => this.stderrBuffer.append(chunk));
    child.on("error", (error) => this.fail(new BrokerConnectionError("Failed to start sigma-exec.", { cause: error })));
    child.on("close", (code, signal) => this.onClose(code, signal));
  }

  async request(method: string, params: Record<string, unknown>, options: BrokerRequestOptions = {}): Promise<unknown> {
    this.assertRunning();
    if (options.signal?.aborted) throw this.cancellation(options.signal, true);
    const id = this.nextId++;
    const timeoutMs = options.timeoutMs ?? this.options.requestTimeoutMs ?? 120_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new RangeError("Broker request timeout must be positive.");
    // Encoding is local validation. Keep it outside pending/write state so a
    // malformed or oversized request cannot fail unrelated in-flight work.
    const frame = encodeBrokerFrame(brokerRequest(id, method, params), this.options.maximumFrameBytes);
    return await new Promise((resolve, reject) => {
      const pending: PendingRequest = { id, method, resolve, reject, signal: options.signal };
      pending.onAbort = () => this.cancel(pending, this.cancellation(options.signal));
      options.signal?.addEventListener("abort", pending.onAbort, { once: true });
      pending.timer = setTimeout(() => this.cancel(pending, new BrokerTimeoutError(
        `Broker '${method}' exceeded its ${timeoutMs}ms deadline.`
      )), timeoutMs);
      pending.timer.unref();
      this.pending.set(id, pending);
      void this.writeFrame(frame, pending).catch((error: unknown) => {
        const failure = error instanceof Error ? error : new BrokerConnectionError(String(error));
        // Retry safety belongs only to this frame. A pre-dispatch failure for
        // this request says nothing about older requests already in flight.
        this.settle(pending, undefined, failure);
        this.fail(transportWideFailure(failure));
      });
    });
  }

  async close(): Promise<void> {
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

  private async closeOnce(): Promise<void> {
    if (this.state === "closed") return;
    try {
      this.closingRequested = true;
      const child = this.child;
      const grace = this.options.shutdownGraceMs ?? 750;
      if (this.state === "running") {
        try { await this.request("shutdown", {}, { timeoutMs: grace }); } catch { /* terminate below */ }
      }
      this.state = "closing";
      if (!child || this.childClosed) {
        this.rejectPending(new BrokerConnectionError("Broker transport closed."));
        this.state = "closed";
        return;
      }
      if (!await this.waitForChildClose(child, grace)) child.kill();
      if (!await this.waitForChildClose(child, 5_000)) {
        throw new BrokerConnectionError("sigma-exec did not release its process handle during shutdown.");
      }
      this.rejectPending(new BrokerConnectionError("Broker transport closed."));
      this.state = "closed";
    } catch (error) {
      const failure = error instanceof Error ? error : new BrokerConnectionError(String(error));
      const pendingFailure = this.terminalFailure
        ? attachBrokerLifecycleFailure(
          this.terminalFailure, failure, "Transport failure shutdown could not be confirmed."
        )
        : failure;
      this.rejectPending(pendingFailure, true);
      this.state = "failed";
      throw failure;
    }
  }

  private async waitForChildClose(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
    if (this.childClosed) return true;
    return await new Promise<boolean>((resolve) => {
      const done = (): void => { clearTimeout(timer); resolve(true); };
      const timer = setTimeout(() => { child.removeListener("close", done); resolve(false); }, timeoutMs);
      child.once("close", done);
    });
  }

  private async writeFrame(frame: Buffer, pending?: PendingRequest): Promise<void> {
    this.writeChain = this.writeChain.then(async () => await new Promise<void>((resolve, reject) => {
      if (pending && !this.pending.has(pending.id)) return resolve();
      const stdin = this.child?.stdin;
      if (!stdin?.writable) {
        return reject(new BrokerConnectionError("Broker stdin is not writable.", { retrySafe: true }));
      }
      if (pending) pending.dispatched = true;
      stdin.write(frame, (error) => error
        ? reject(new BrokerConnectionError("Failed to write a broker request frame.", { cause: error }))
        : resolve());
    }));
    await this.writeChain;
  }

  private sendCancellation(targetRequestId: number): void {
    if (!this.running) return;
    const id = this.nextId++;
    let frame: Buffer;
    try {
      frame = encodeBrokerFrame(
        brokerRequest(id, "cancel", { targetRequestId }),
        this.options.maximumFrameBytes
      );
    } catch (error) {
      const failure = error instanceof Error ? error : new BrokerConnectionError(String(error));
      // The target exec was already dispatched. If its cancellation cannot be
      // encoded, containing the transport is the only outcome-safe response.
      this.fail(transportWideFailure(failure));
      return;
    }
    void this.writeFrame(frame).catch((error: unknown) => {
      const failure = error instanceof Error ? error : new BrokerConnectionError(String(error));
      this.fail(transportWideFailure(failure));
    });
  }

  private cancel(pending: PendingRequest, error: Error): void {
    if (!this.pending.has(pending.id)) return;
    if (!pending.dispatched) {
      const failure = error instanceof BrokerTimeoutError
        ? new BrokerTimeoutError(error.message, { cause: error.cause, preDispatch: true })
        : error instanceof BrokerCancelledError
          ? new BrokerCancelledError(error.message, { cause: error.cause, preDispatch: true })
          : error;
      this.settle(pending, undefined, failure);
      return;
    }
    if (pending.method === "exec") {
      if (pending.deferredError) return;
      pending.deferredError = error;
      clearTimeout(pending.timer);
      if (pending.signal && pending.onAbort) {
        pending.signal.removeEventListener("abort", pending.onAbort);
      }
      this.sendCancellation(pending.id);
      const grace = this.options.cancellationGraceMs ?? 10_000;
      pending.timer = setTimeout(() => {
        // close() waits for the broker process to exit. On Windows that closes
        // the kill-on-close Job handle before rejectPending releases callers.
        void this.close().catch((error: unknown) => {
          if (!this.pending.has(pending.id)) return;
          const failure = error instanceof Error ? error : new BrokerConnectionError(String(error));
          this.settle(pending, undefined, attachBrokerLifecycleFailure(
            pending.deferredError!, failure, "Execution cancellation cleanup failed."
          ));
        });
      }, grace);
      pending.timer.unref();
      return;
    }
    this.sendCancellation(pending.id);
    this.settle(pending, undefined, error);
  }

  private onStdout(chunk: Buffer): void {
    try {
      for (const message of this.decoder.push(chunk)) this.handleResponse(message);
    } catch (error) {
      this.fail(error instanceof Error ? error : new BrokerProtocolError(String(error)));
    }
  }

  private handleResponse(input: unknown): void {
    const response = parseBrokerResponse(input);
    const pending = this.pending.get(response.requestId);
    if (!pending) return;
    if (pending.deferredError) {
      if (response.ok) {
        cancelledTerminalResponses.set(pending.deferredError, { result: response.result });
      }
      this.settle(pending, undefined, pending.deferredError);
      return;
    }
    if (response.ok) {
      const result = rawOutputMethods.has(pending.method)
        ? response.result
        : this.redactor.redactUnknown(response.result);
      this.settle(pending, result);
    } else {
      const error = this.redactor.redactUnknown(response.error) as {
        code: string;
        message: string;
        data?: unknown;
      };
      this.settle(pending, undefined, rpcError(error.code, error.message, error.data));
    }
  }

  private settle(pending: PendingRequest, value?: unknown, error?: Error): void {
    if (!this.pending.delete(pending.id)) return;
    clearTimeout(pending.timer);
    if (pending.signal && pending.onAbort) pending.signal.removeEventListener("abort", pending.onAbort);
    if (error) pending.reject(error);
    else pending.resolve(value);
  }

  private rejectPending(error: Error, lifecycleFailed = false): void {
    for (const pending of [...this.pending.values()]) {
      const failure = pending.deferredError
        ? lifecycleFailed ? attachBrokerLifecycleFailure(
          pending.deferredError, error, "Execution cancellation cleanup failed."
        ) : pending.deferredError
        : error;
      this.settle(pending, undefined, failure);
    }
  }

  private fail(error: Error): void {
    if (this.state === "closing" || this.state === "closed" || this.state === "failed") return;
    this.state = "failed";
    this.terminalFailure = error;
    const child = this.child;
    const mustConfirmExit = Boolean(child && !this.childClosed && child.pid !== undefined
      && child.exitCode === null);
    if (mustConfirmExit && child) child.kill();
    else this.rejectPending(error);
    this.onUnexpectedFailure(error);
  }

  private onClose(code: number | null, signal: NodeJS.Signals | null): void {
    this.childClosed = true;
    if (this.terminalFailure) {
      this.rejectPending(this.terminalFailure);
      if (this.closingRequested || this.state === "closing") this.state = "closed";
      return;
    }
    if (this.closingRequested || this.state === "closing" || this.state === "closed") {
      this.rejectPending(new BrokerConnectionError("Broker transport closed."));
      this.state = "closed";
      return;
    }
    try {
      this.decoder.end();
      const stderr = this.stderr.trim();
      this.fail(new BrokerConnectionError(
        `sigma-exec exited unexpectedly (code=${String(code)}, signal=${String(signal)}).${stderr ? ` stderr: ${stderr.slice(-8_192)}` : ""}`,
        { diagnostic: { exitCode: code, signal, stderrTail: stderr.slice(-8_192) } }
      ));
    } catch (error) {
      this.fail(error instanceof Error ? error : new BrokerProtocolError(String(error)));
    }
  }

  private assertRunning(): void {
    if (this.state !== "running") {
      throw new BrokerConnectionError(`Broker transport is not running (state: ${this.state}).`, {
        retrySafe: true,
        diagnostic: { transportState: this.state, stderrTail: this.stderr.trim().slice(-8_192) }
      });
    }
  }

  private cancellation(signal?: AbortSignal, preDispatch = false): BrokerCancelledError {
    const cause = signal?.reason instanceof Error ? signal.reason : undefined;
    return new BrokerCancelledError(
      cause?.message ?? "Execution request cancelled.", { cause, preDispatch }
    );
  }
}
