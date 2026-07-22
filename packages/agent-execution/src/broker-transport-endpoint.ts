import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createConnection, type Socket } from "node:net";
import type { Duplex, Writable } from "node:stream";
import { BrokerConnectionError } from "./errors.js";
import { createMinimalEnvironment } from "./environment.js";
import type { SigmaExecBrokerClientOptions } from "./types.js";

interface EndpointCallbacks {
  data(chunk: Buffer): void;
  stderr(chunk: Buffer): void;
  error(error: Error): void;
  close(message: string, diagnostic: Record<string, unknown>): void;
}

export class BrokerTransportEndpoint {
  private child?: ChildProcessWithoutNullStreams;
  private socket?: Socket;
  private stream?: Duplex;
  private ended = false;

  constructor(private readonly callbacks: EndpointCallbacks) {}

  get closed(): boolean { return this.ended; }
  get childProcess(): ChildProcessWithoutNullStreams | undefined { return this.child; }
  get writable(): Writable | undefined { return this.stream ?? this.socket ?? this.child?.stdin; }

  start(options: SigmaExecBrokerClientOptions): void {
    this.ended = false;
    if (options.trustedStream) this.startStream(options.trustedStream);
    else if (options.socketPath) this.startSocket(options.socketPath);
    else this.startChild(options.helperPath!, options.helperArgs ?? []);
  }

  terminate(): boolean {
    if (this.ended) return false;
    if (this.stream && !this.stream.destroyed) {
      this.stream.destroy();
      return true;
    }
    if (this.socket && !this.socket.destroyed) {
      this.socket.destroy();
      return true;
    }
    if (this.child?.pid !== undefined && this.child.exitCode === null) {
      this.child.kill();
      return true;
    }
    return false;
  }

  async close(
    graceMs: number,
    waitForChild: (child: ChildProcessWithoutNullStreams, timeoutMs: number) => Promise<boolean>
      = async (child, timeoutMs) => await this.waitForClose(child, timeoutMs)
  ): Promise<void> {
    const stream = this.stream ?? this.socket;
    if (stream) {
      await this.closeStream(stream, graceMs);
      return;
    }
    const child = this.child;
    if (!child || this.ended) return;
    if (!await waitForChild(child, graceMs)) child.kill();
    if (!await waitForChild(child, 5_000)) {
      throw new BrokerConnectionError("sigma-exec did not release its process handle during shutdown.");
    }
  }

  async waitForChildClose(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
    return await this.waitForClose(child, timeoutMs);
  }

  private startChild(helperPath: string, args: string[]): void {
    const child = spawn(helperPath, [...args], {
      cwd: process.cwd(), env: createMinimalEnvironment(), windowsHide: true, shell: false,
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.child = child;
    child.stdout.on("data", this.callbacks.data);
    child.stderr.on("data", this.callbacks.stderr);
    child.on("error", (error) => this.callbacks.error(
      new BrokerConnectionError("Failed to start sigma-exec.", { cause: error })
    ));
    child.on("close", (code, signal) => this.closedEndpoint(
      `sigma-exec exited unexpectedly (code=${String(code)}, signal=${String(signal)})`,
      { exitCode: code, signal }
    ));
  }

  private startSocket(socketPath: string): void {
    const socket = createConnection({ path: socketPath });
    this.socket = socket;
    socket.on("data", this.callbacks.data);
    socket.on("error", (error) => this.callbacks.error(new BrokerConnectionError(
      "Trusted OCI broker socket failed.", { cause: error, diagnostic: { socketPath } }
    )));
    socket.on("close", () => this.closedEndpoint(
      "Trusted OCI broker socket disconnected unexpectedly", { socketPath }
    ));
  }

  private startStream(stream: Duplex): void {
    this.stream = stream;
    stream.on("data", this.callbacks.data);
    stream.on("error", (error) => this.callbacks.error(new BrokerConnectionError(
      "Trusted OCI broker stream failed.", { cause: error }
    )));
    stream.on("close", () => this.closedEndpoint(
      "Trusted OCI broker stream disconnected unexpectedly", {}
    ));
  }

  private closedEndpoint(message: string, diagnostic: Record<string, unknown>): void {
    this.ended = true;
    this.callbacks.close(message, diagnostic);
  }

  private async closeStream(stream: Duplex, graceMs: number): Promise<void> {
    if (!this.ended) stream.end();
    if (!await this.waitForClose(stream, graceMs)) stream.destroy();
    if (!await this.waitForClose(stream, 5_000)) {
      throw new BrokerConnectionError("OCI broker stream did not close during shutdown.");
    }
  }

  private async waitForClose(endpoint: Duplex | ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
    if (this.ended) return true;
    return await new Promise<boolean>((resolve) => {
      const done = (): void => { clearTimeout(timer); resolve(true); };
      const timer = setTimeout(() => { endpoint.removeListener("close", done); resolve(false); }, timeoutMs);
      endpoint.once("close", done);
    });
  }
}
