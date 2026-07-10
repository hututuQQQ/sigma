import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { McpConnectionError, McpProtocolError } from "./errors.js";
import { JsonLineDecoder } from "./framing.js";
import { detachedProcessGroup, terminateProcessTree } from "./process-tree.js";
import type { McpStdioServerConfig } from "./types.js";

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
): NodeJS.ProcessEnv {
  const inherited: NodeJS.ProcessEnv = {};
  for (const key of MCP_INHERITED_ENV_ALLOWLIST) {
    if (source[key] !== undefined) inherited[key] = source[key];
  }
  return { ...inherited, ...configured };
}

export class McpStdioTransport {
  private readonly decoder: JsonLineDecoder;
  private child?: ChildProcessWithoutNullStreams;
  private writeChain: Promise<void> = Promise.resolve();
  private closing = false;
  private failed = false;
  private closePromise?: Promise<void>;
  private stderrValue = "";

  constructor(
    private readonly config: McpStdioServerConfig,
    private readonly hooks: StdioTransportHooks,
    private readonly maxMessageBytes: number,
    private readonly maxStderrBytes: number,
    private readonly shutdownGraceMs: number
  ) {
    this.decoder = new JsonLineDecoder(maxMessageBytes);
  }

  get processId(): number | undefined { return this.child?.pid; }
  get stderr(): string { return this.stderrValue; }

  async start(): Promise<void> {
    if (this.child) throw new McpConnectionError("MCP stdio transport has already started.");
    const child = spawn(this.config.command, this.config.args ?? [], {
      cwd: path.resolve(this.config.cwd),
      env: mcpProcessEnvironment(this.config.env),
      windowsHide: true,
      shell: false,
      detached: detachedProcessGroup(),
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.child = child;
    child.stdout.on("data", (chunk: Buffer) => this.receive(chunk));
    child.stdout.on("end", () => this.finishInput());
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      this.stderrValue = appendBounded(this.stderrValue, text, this.maxStderrBytes);
      try { this.hooks.onStderr?.(text); } catch { /* diagnostic hooks cannot break transport */ }
    });
    child.on("close", (code, signal) => {
      if (!this.closing) this.fail(new McpConnectionError(`MCP server exited unexpectedly (${signal ?? code ?? "unknown"}).`));
    });
    await new Promise<void>((resolve, reject) => {
      const onSpawn = (): void => { child.removeListener("error", onError); resolve(); };
      const onError = (error: Error): void => {
        child.removeListener("spawn", onSpawn);
        reject(new McpConnectionError(`Could not start MCP server: ${error.message}`));
      };
      child.once("spawn", onSpawn);
      child.once("error", onError);
    });
    child.on("error", (error) => this.fail(new McpConnectionError(`MCP server process failed: ${error.message}`)));
  }

  send(message: Record<string, unknown>): Promise<void> {
    const write = async (): Promise<void> => {
      const child = this.child;
      if (!child || this.closing || child.stdin.destroyed || !child.stdin.writable) {
        throw new McpConnectionError("MCP stdin is closed.");
      }
      const line = `${JSON.stringify(message)}\n`;
      await new Promise<void>((resolve, reject) => {
        const cleanup = (): void => {
          child.stdin.removeListener("error", onError);
          child.stdin.removeListener("drain", onDrain);
        };
        const onError = (error: Error): void => { cleanup(); reject(error); };
        const onDrain = (): void => { cleanup(); resolve(); };
        child.stdin.once("error", onError);
        if (child.stdin.write(line, "utf8")) { cleanup(); resolve(); }
        else child.stdin.once("drain", onDrain);
      });
    };
    this.writeChain = this.writeChain.catch(() => undefined).then(write);
    return this.writeChain;
  }

  async close(): Promise<void> {
    if (this.closePromise) return await this.closePromise;
    this.closePromise = this.closeInternal();
    return await this.closePromise;
  }

  private async closeInternal(): Promise<void> {
    this.closing = true;
    if (this.child) await terminateProcessTree(this.child, this.shutdownGraceMs);
  }

  private receive(chunk: Buffer): void {
    try {
      for (const message of this.decoder.push(chunk)) this.hooks.onMessage(message);
    } catch (error) {
      this.fail(error instanceof Error ? error : new McpProtocolError(String(error)));
    }
  }

  private finishInput(): void {
    try {
      for (const message of this.decoder.end()) this.hooks.onMessage(message);
    } catch (error) {
      this.fail(error instanceof Error ? error : new McpProtocolError(String(error)));
    }
  }

  private fail(error: Error): void {
    if (this.failed || this.closing) return;
    this.failed = true;
    this.hooks.onFailure(error);
    void this.close().catch(() => undefined);
  }
}
