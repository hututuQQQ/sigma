import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  BrokerCancelledError,
  BrokerConnectionError,
  BrokerError,
  BrokerPolicyError,
  BrokerProtocolError,
  BrokerTimeoutError,
  SandboxUnavailableError
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
}

function rpcError(code: string, message: string, data?: unknown): BrokerError {
  if (code === "sandbox_unavailable") return new SandboxUnavailableError(message, data);
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
    if (this.options.allowUnsafeHostExec) args.push("--allow-unsafe-host-exec");
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
    if (options.signal?.aborted) throw this.cancellation(options.signal);
    const id = this.nextId++;
    const timeoutMs = options.timeoutMs ?? this.options.requestTimeoutMs ?? 120_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new RangeError("Broker request timeout must be positive.");
    return await new Promise((resolve, reject) => {
      const pending: PendingRequest = { id, method, resolve, reject, signal: options.signal };
      pending.onAbort = () => this.cancel(pending, this.cancellation(options.signal));
      options.signal?.addEventListener("abort", pending.onAbort, { once: true });
      pending.timer = setTimeout(() => this.cancel(pending, new BrokerTimeoutError(
        `Broker '${method}' exceeded its ${timeoutMs}ms deadline.`
      )), timeoutMs);
      pending.timer.unref();
      this.pending.set(id, pending);
      void this.send(id, method, params).catch((error: unknown) => this.fail(
        error instanceof Error ? error : new BrokerConnectionError(String(error))
      ));
    });
  }

  async close(): Promise<void> {
    this.closePromise ??= this.closeOnce();
    await this.closePromise;
  }

  private async closeOnce(): Promise<void> {
    if (this.state === "closed") return;
    this.closingRequested = true;
    const child = this.child;
    const grace = this.options.shutdownGraceMs ?? 750;
    if (this.state === "running") {
      try { await this.request("shutdown", {}, { timeoutMs: grace }); } catch { /* terminate below */ }
    }
    this.state = "closing";
    this.rejectPending(new BrokerConnectionError("Broker transport closed."));
    if (!child || this.childClosed) {
      this.state = "closed";
      return;
    }
    if (!await this.waitForChildClose(child, grace)) child.kill();
    if (!await this.waitForChildClose(child, 5_000)) {
      throw new BrokerConnectionError("sigma-exec did not release its process handle during shutdown.");
    }
    this.state = "closed";
  }

  private async waitForChildClose(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
    if (this.childClosed) return true;
    return await new Promise<boolean>((resolve) => {
      const done = (): void => { clearTimeout(timer); resolve(true); };
      const timer = setTimeout(() => { child.removeListener("close", done); resolve(false); }, timeoutMs);
      child.once("close", done);
    });
  }

  private async send(id: number, method: string, params: Record<string, unknown>): Promise<void> {
    const frame = encodeBrokerFrame(brokerRequest(id, method, params), this.options.maximumFrameBytes);
    this.writeChain = this.writeChain.then(async () => await new Promise<void>((resolve, reject) => {
      const stdin = this.child?.stdin;
      if (!stdin?.writable) return reject(new BrokerConnectionError("Broker stdin is not writable."));
      stdin.write(frame, (error) => error ? reject(error) : resolve());
    }));
    await this.writeChain;
  }

  private sendCancellation(targetRequestId: number): void {
    if (!this.running) return;
    const id = this.nextId++;
    void this.send(id, "cancel", { targetRequestId }).catch((error: unknown) => this.fail(
      error instanceof Error ? error : new BrokerConnectionError(String(error))
    ));
  }

  private cancel(pending: PendingRequest, error: Error): void {
    if (!this.pending.has(pending.id)) return;
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

  private rejectPending(error: Error): void {
    for (const pending of [...this.pending.values()]) this.settle(pending, undefined, error);
  }

  private fail(error: Error): void {
    if (this.state === "closing" || this.state === "closed" || this.state === "failed") return;
    this.state = "failed";
    this.rejectPending(error);
    if (this.child?.exitCode === null) this.child.kill();
    this.onUnexpectedFailure(error);
  }

  private onClose(code: number | null, signal: NodeJS.Signals | null): void {
    this.childClosed = true;
    if (this.closingRequested || this.state === "closing" || this.state === "closed") {
      this.rejectPending(new BrokerConnectionError("Broker transport closed."));
      this.state = "closed";
      return;
    }
    try {
      this.decoder.end();
      this.fail(new BrokerConnectionError(`sigma-exec exited unexpectedly (code=${String(code)}, signal=${String(signal)}).`));
    } catch (error) {
      this.fail(error instanceof Error ? error : new BrokerProtocolError(String(error)));
    }
  }

  private assertRunning(): void {
    if (this.state !== "running") throw new BrokerConnectionError(`Broker transport is not running (state: ${this.state}).`);
  }

  private cancellation(signal?: AbortSignal): BrokerCancelledError {
    const cause = signal?.reason instanceof Error ? signal.reason : undefined;
    return new BrokerCancelledError(cause?.message ?? "Execution request cancelled.", { cause });
  }
}
