import path from "node:path";
import type { ProcessHandle, ProcessPollResult } from "agent-execution";
import { assertMcpPersistentEffectsAllowed, assertMcpWriteRootsEmpty } from "agent-protocol";
import { McpConnectionError, McpProtocolError } from "./errors.js";
import { JsonLineDecoder } from "./framing.js";
import type { McpProcessExecution, McpStdioServerConfig } from "./types.js";

interface StdioTransportHooks {
  onMessage(message: unknown): void;
  onFailure(error: Error): void;
  onStderr?(text: string): void;
}

function appendBounded(current: string, chunk: string, maximum: number): string {
  const bytes = Buffer.from(`${current}${chunk}`, "utf8");
  if (bytes.byteLength <= maximum) return bytes.toString("utf8");
  return bytes.subarray(bytes.byteLength - maximum).toString("utf8").replace(/^\uFFFD/, "");
}

export const MCP_INHERITED_ENV_ALLOWLIST = [
  "PATH", "Path", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TZ",
  "SystemRoot", "SYSTEMROOT", "WINDIR", "ComSpec", "COMSPEC", "PATHEXT", "USERPROFILE"
] as const;

export function mcpProcessEnvironment(
  configured: Readonly<Record<string, string>> = {},
  source: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  const inherited: Record<string, string> = {};
  for (const key of MCP_INHERITED_ENV_ALLOWLIST) {
    if (source[key] !== undefined) inherited[key] = source[key];
  }
  return { ...inherited, ...configured };
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => signal.removeEventListener("abort", abort);
    const timer = setTimeout(() => { cleanup(); resolve(); }, milliseconds);
    timer.unref();
    function abort(): void {
      clearTimeout(timer);
      cleanup();
      reject(signal.reason ?? new Error("MCP polling stopped."));
    }
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

export class McpStdioTransport {
  private readonly decoder: JsonLineDecoder;
  private handle?: ProcessHandle;
  private writeChain: Promise<void> = Promise.resolve();
  private closing = false;
  private failed = false;
  private closePromise?: Promise<void>;
  private stderrValue = "";
  private inputFinished = false;
  private pump?: Promise<void>;
  private readonly pumpController = new AbortController();

  constructor(
    private readonly config: McpStdioServerConfig,
    private readonly hooks: StdioTransportHooks,
    private readonly maxMessageBytes: number,
    private readonly maxStderrBytes: number,
    private readonly shutdownGraceMs: number,
    private readonly execution?: McpProcessExecution
  ) {
    this.decoder = new JsonLineDecoder(maxMessageBytes);
  }

  get processId(): number | undefined { return this.handle?.systemProcessId; }
  get stderr(): string { return this.stderrValue; }

  async start(): Promise<void> {
    if (this.handle) throw new McpConnectionError("MCP stdio transport has already started.");
    if (!this.execution) throw new McpConnectionError("MCP server requires an injected sandbox execution port.");
    assertMcpPersistentEffectsAllowed(this.config.name, this.execution.possibleEffects);
    assertMcpWriteRootsEmpty(this.config.name, this.execution.policy.writeRoots);
    try {
      this.handle = await this.execution.broker.spawn({
        command: {
          executable: this.config.command,
          args: this.config.args ?? [],
          cwd: path.resolve(this.config.cwd),
          environment: { overrides: mcpProcessEnvironment(this.config.env) }
        },
        policy: this.execution.policy,
        maxOutputBytes: Math.max(this.maxMessageBytes, this.maxStderrBytes)
      });
      this.pump = this.pollOutput();
    } catch (error) {
      throw new McpConnectionError(`Could not start MCP server: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  send(message: Record<string, unknown>): Promise<void> {
    const write = async (): Promise<void> => {
      if (!this.handle || !this.execution || this.closing) throw new McpConnectionError("MCP stdin is closed.");
      try {
        await this.execution.broker.write(this.handle, `${JSON.stringify(message)}\n`);
      } catch (error) {
        throw new McpConnectionError(`MCP stdin write failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    this.writeChain = this.writeChain.catch(() => undefined).then(write);
    return this.writeChain;
  }

  async close(): Promise<void> {
    this.closePromise ??= this.closeInternal();
    return await this.closePromise;
  }

  private async pollOutput(): Promise<void> {
    const execution = this.execution!;
    const handle = this.handle!;
    try {
      while (!this.pumpController.signal.aborted) {
        const result = await execution.broker.poll(handle, { signal: this.pumpController.signal });
        await this.consume(result);
        if (result.state !== "running") {
          this.finishInput();
          if (!this.closing) this.fail(new McpConnectionError(
            `MCP server exited unexpectedly (${result.signal ?? result.exitCode ?? "unknown"}).`
          ));
          return;
        }
        await wait(execution.pollIntervalMs ?? 10, this.pumpController.signal);
      }
    } catch (error) {
      if (!this.closing) this.fail(error instanceof Error ? error : new McpConnectionError(String(error)));
    }
  }

  private async closeInternal(): Promise<void> {
    this.closing = true;
    this.pumpController.abort(new Error("MCP transport is closing."));
    await this.pump?.catch(() => undefined);
    if (this.handle && this.execution) {
      const result = await this.execution.broker.terminate(this.handle, {
        timeoutMs: this.shutdownGraceMs + 1_000
      }).catch(() => undefined);
      if (result) await this.consume(result);
    }
    this.finishInput();
  }

  private async consume(result: ProcessPollResult): Promise<void> {
    if (result.stdout) this.receive(Buffer.from(result.stdout, "utf8"));
    if (result.stderr) this.appendStderr(result.stderr);
    const artifactIds = result.outputArtifacts?.map((item) => item.brokerArtifactId) ?? [];
    if (artifactIds.length > 0) {
      await this.execution?.broker.releaseOutputArtifacts?.(artifactIds).catch(() => undefined);
    }
  }

  private receive(chunk: Buffer): void {
    try {
      for (const message of this.decoder.push(chunk)) this.hooks.onMessage(message);
    } catch (error) {
      this.fail(error instanceof Error ? error : new McpProtocolError(String(error)));
    }
  }

  private finishInput(): void {
    if (this.inputFinished) return;
    this.inputFinished = true;
    try {
      for (const message of this.decoder.end()) this.hooks.onMessage(message);
    } catch (error) {
      this.fail(error instanceof Error ? error : new McpProtocolError(String(error)));
    }
  }

  private appendStderr(text: string): void {
    if (!text) return;
    this.stderrValue = appendBounded(this.stderrValue, text, this.maxStderrBytes);
    try { this.hooks.onStderr?.(text); } catch { /* diagnostic hooks cannot break transport */ }
  }

  private fail(error: Error): void {
    if (this.failed || this.closing) return;
    this.failed = true;
    this.hooks.onFailure(error);
    void this.close().catch(() => undefined);
  }
}
