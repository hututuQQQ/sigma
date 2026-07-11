import path from "node:path";
import type { ExecutionBroker, ExecutionPolicy, ProcessHandle } from "agent-execution";
import type { LanguageServerPreset, LspTransport } from "./types.js";

export interface BrokerLspTransportOptions {
  broker: ExecutionBroker;
  preset: LanguageServerPreset;
  workspacePath: string;
  pollIntervalMs?: number;
  additionalReadRoots?: string[];
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("LSP transport cancelled."));
  return new Promise((resolve, reject) => {
    const cleanup = (): void => signal?.removeEventListener("abort", abort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, milliseconds);
    timer.unref();
    const abort = (): void => {
      clearTimeout(timer);
      cleanup();
      reject(signal?.reason ?? new Error("LSP transport cancelled."));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function serverReadRoots(preset: LanguageServerPreset, workspacePath: string, extra: string[]): string[] {
  const roots = [workspacePath, ...extra];
  if (path.isAbsolute(preset.executable)) roots.push(path.dirname(preset.executable));
  for (const argument of preset.args) {
    if (path.isAbsolute(argument)) roots.push(path.dirname(argument));
  }
  return [...new Set(roots.map((root) => path.resolve(root)))];
}

/** A read-only, offline LSP stdio transport owned exclusively by sigma-exec. */
export class BrokerLspTransport implements LspTransport {
  private readonly broker: ExecutionBroker;
  private readonly preset: LanguageServerPreset;
  private readonly workspacePath: string;
  private readonly pollIntervalMs: number;
  private readonly readRoots: string[];
  private handle?: ProcessHandle;
  private starting?: Promise<ProcessHandle>;
  private closed = false;
  private stderrTail = "";
  private readonly lifecycle = new AbortController();

  constructor(options: BrokerLspTransportOptions) {
    if (!options.preset.available) {
      throw new Error(options.preset.unavailableReason ?? `Language server '${options.preset.id}' is unavailable.`);
    }
    this.broker = options.broker;
    this.preset = options.preset;
    this.workspacePath = path.resolve(options.workspacePath);
    this.pollIntervalMs = Math.max(5, options.pollIntervalMs ?? 20);
    this.readRoots = serverReadRoots(options.preset, this.workspacePath, options.additionalReadRoots ?? []);
  }

  async write(data: Uint8Array, signal?: AbortSignal): Promise<void> {
    const handle = await this.start(signal);
    await this.broker.write(handle, Buffer.from(data).toString("utf8"), { signal });
  }

  async *chunks(signal?: AbortSignal): AsyncIterable<Uint8Array> {
    const handle = await this.start(signal);
    while (!this.closed) {
      signal?.throwIfAborted();
      const result = await this.broker.poll(handle, { signal });
      const artifactIds = result.outputArtifacts?.map((item) => item.brokerArtifactId) ?? [];
      if (artifactIds.length > 0) {
        await this.broker.releaseOutputArtifacts?.(artifactIds).catch(() => undefined);
      }
      if (result.stdoutDroppedBytes > 0) {
        throw Object.assign(new Error(
          `Language server '${this.preset.id}' exceeded its bounded stdout buffer.`
        ), { code: "lsp_output_truncated" });
      }
      // stderr is kept separately by the broker; mixing it into stdout would corrupt JSON-RPC framing.
      if (result.stderr) this.stderrTail = `${this.stderrTail}${result.stderr}`.slice(-8_192);
      if (result.stdout) yield Buffer.from(result.stdout, "utf8");
      if (result.state !== "running") {
        if (result.exitCode !== 0) {
          const detail = this.stderrTail.trim();
          throw Object.assign(new Error(
            `Language server '${this.preset.id}' exited with ${String(result.exitCode)}.${detail ? ` ${detail}` : ""}`
          ), {
            code: "lsp_server_exited"
          });
        }
        return;
      }
      await delay(this.pollIntervalMs, signal);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.lifecycle.abort(new Error("LSP transport closed."));
    const handle = this.handle ?? await this.starting?.catch(() => undefined);
    if (handle) {
      const result = await this.broker.terminate(handle).catch(() => undefined);
      const artifactIds = result?.outputArtifacts?.map((item) => item.brokerArtifactId) ?? [];
      if (artifactIds.length > 0) {
        await this.broker.releaseOutputArtifacts?.(artifactIds).catch(() => undefined);
      }
    }
  }

  private async start(signal?: AbortSignal): Promise<ProcessHandle> {
    if (this.closed) throw new Error("LSP transport is closed.");
    this.starting ??= this.spawn(signal);
    return await this.starting;
  }

  private async spawn(signal?: AbortSignal): Promise<ProcessHandle> {
    const policy: ExecutionPolicy = {
      sandbox: "required",
      network: "none",
      readRoots: this.readRoots,
      writeRoots: [],
      protectedPaths: [path.join(this.workspacePath, ".git"), path.join(this.workspacePath, ".agent")]
    };
    const handle = await this.broker.spawn({
      command: {
        executable: this.preset.executable,
        args: this.preset.args,
        cwd: this.workspacePath,
        environment: { overrides: { SIGMA_LSP_READ_ROOTS: JSON.stringify(this.readRoots) } }
      },
      policy,
      maxOutputBytes: 64 * 1024 * 1024,
      outputRedaction: "framed_jsonrpc"
    }, { signal: signal ? AbortSignal.any([signal, this.lifecycle.signal]) : this.lifecycle.signal });
    if (this.closed) {
      await this.broker.terminate(handle).catch(() => undefined);
      throw new Error("LSP transport closed while the language server was starting.");
    }
    this.handle = handle;
    return handle;
  }
}
