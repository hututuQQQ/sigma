import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { RegisteredTool, ToolExecutionContext, ToolRegistry, ToolResult, McpServerRunSummary } from "./types.js";
import { requestToolPermission, resolveWorkspacePath } from "./policy.js";
import { createToolRegistryFromTools } from "./tools/registry.js";
import { redactSecretText } from "./redaction.js";

type McpApprovalMode = "prompt" | "auto" | "approve";

interface McpServerConfig {
  transport?: unknown;
  command?: unknown;
  args?: unknown;
  env?: unknown;
  url?: unknown;
  headers?: unknown;
  bearerTokenEnv?: unknown;
  enabled?: unknown;
  startupTimeoutSec?: unknown;
  toolTimeoutSec?: unknown;
  enabledTools?: unknown;
  disabledTools?: unknown;
  approvalMode?: unknown;
}

interface McpConfig {
  servers?: Record<string, McpServerConfig>;
}

interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean };
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

interface McpJsonRpcClient {
  request(method: string, params: unknown, timeoutMs: number, abortSignal?: AbortSignal): Promise<unknown>;
  notify(method: string, params: unknown): void;
  close(): Promise<void>;
  errorTail?(): string;
}

class McpRequestError extends Error {
  constructor(
    message: string,
    readonly metadata: { cancelled?: boolean; timedOut?: boolean } = {}
  ) {
    super(message);
  }
}

export interface CreateMcpToolRegistryOptions {
  workspacePath: string;
  configPath?: string;
}

export interface CreateMcpToolRegistryResult {
  registry: ToolRegistry;
  servers: McpServerRunSummary[];
}

function numberOrDefault(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function stringList(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function approvalMode(value: unknown): McpApprovalMode {
  return value === "approve" || value === "auto" || value === "prompt" ? value : "prompt";
}

function transportValue(value: unknown): "stdio" | "http" {
  return value === "http" ? "http" : "stdio";
}

function sanitizeName(value: string): string {
  return value.replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase() || "tool";
}

function resolveConfigPath(workspacePath: string, requestedPath?: string): string {
  return requestedPath
    ? resolveWorkspacePath(workspacePath, requestedPath)
    : path.join(path.resolve(workspacePath), ".agent", "mcp.json");
}

async function loadMcpConfig(workspacePath: string, requestedPath?: string): Promise<McpConfig | null> {
  const configPath = resolveConfigPath(workspacePath, requestedPath);
  if (!existsSync(configPath)) return null;
  return JSON.parse(await readFile(configPath, "utf8")) as McpConfig;
}

class StdioMcpClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private stdoutBuffer = "";
  private stderrBuffer = "";

  constructor(
    private readonly name: string,
    private readonly config: Required<Pick<McpServerConfig, "command">> & McpServerConfig,
    private readonly workspacePath: string
  ) {}

  async start(): Promise<void> {
    const command = String(this.config.command);
    const args = Array.isArray(this.config.args)
      ? this.config.args.filter((arg): arg is string => typeof arg === "string")
      : [];
    const env = this.config.env && typeof this.config.env === "object"
      ? Object.fromEntries(
          Object.entries(this.config.env as Record<string, unknown>).filter((entry): entry is [string, string] =>
            typeof entry[1] === "string"
          )
        )
      : {};
    this.child = spawn(command, args, {
      cwd: this.workspacePath,
      env: { ...process.env, ...env },
      windowsHide: true
    });
    this.child.stdout.on("data", (chunk: Buffer) => this.onStdout(chunk.toString("utf8")));
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderrBuffer = `${this.stderrBuffer}${chunk.toString("utf8")}`.slice(-4000);
    });
    this.child.on("error", (error) => this.rejectAll(error));
    this.child.on("close", (code) => this.rejectAll(new Error(`MCP server ${this.name} exited with code ${code}`)));
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    while (true) {
      const newline = this.stdoutBuffer.indexOf("\n");
      if (newline === -1) return;
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      let message: { id?: unknown; result?: unknown; error?: { message?: unknown } };
      try {
        message = JSON.parse(line) as { id?: unknown; result?: unknown; error?: { message?: unknown } };
      } catch {
        continue;
      }
      if (typeof message.id !== "number") continue;
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new Error(String(message.error.message ?? "MCP request failed")));
      } else {
        pending.resolve(message.result);
      }
    }
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  request(method: string, params: unknown, timeoutMs: number, _abortSignal?: AbortSignal): Promise<unknown> {
    if (!this.child || !this.child.stdin.writable) {
      return Promise.reject(new Error(`MCP server ${this.name} is not running`));
    }
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timed out: ${method}`));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      this.child?.stdin.write(`${payload}\n`, "utf8");
    });
  }

  notify(method: string, params: unknown): void {
    if (!this.child || !this.child.stdin.writable) return;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`, "utf8");
  }

  stderrTail(): string {
    return this.stderrBuffer.trim();
  }

  errorTail(): string {
    return this.stderrTail();
  }

  async close(): Promise<void> {
    if (!this.child) return;
    try {
      await this.request("shutdown", {}, 1000);
    } catch {
      // Best-effort shutdown.
    }
    this.notify("notifications/cancelled", {});
    this.child.kill();
    this.child = null;
  }
}

class HttpMcpClient implements McpJsonRpcClient {
  private nextId = 1;
  private closed = false;
  private lastError = "";

  constructor(
    private readonly name: string,
    private readonly config: Required<Pick<McpServerConfig, "url">> & McpServerConfig
  ) {}

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.config.headers && typeof this.config.headers === "object") {
      for (const [key, value] of Object.entries(this.config.headers as Record<string, unknown>)) {
        if (typeof value === "string") headers[key] = value;
      }
    }
    if (typeof this.config.bearerTokenEnv === "string" && this.config.bearerTokenEnv.length > 0) {
      const token = process.env[this.config.bearerTokenEnv];
      if (token) headers.Authorization = `Bearer ${token}`;
    }
    return headers;
  }

  async request(method: string, params: unknown, timeoutMs: number, abortSignal?: AbortSignal): Promise<unknown> {
    if (this.closed) throw new Error(`MCP server ${this.name} is closed`);
    const controller = new AbortController();
    let timedOut = false;
    let cancelled = abortSignal?.aborted === true;
    const abortFromContext = (): void => {
      cancelled = true;
      controller.abort();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, Math.max(1, timeoutMs));
    timer.unref();
    if (cancelled) {
      controller.abort();
    } else {
      abortSignal?.addEventListener("abort", abortFromContext, { once: true });
    }
    const id = this.nextId++;
    try {
      const response = await fetch(String(this.config.url), {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        signal: controller.signal
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`HTTP MCP request failed with ${response.status}: ${text.slice(0, 500)}`);
      }
      const message = text ? JSON.parse(text) as { id?: unknown; result?: unknown; error?: { message?: unknown } } : {};
      if (message.error) throw new Error(String(message.error.message ?? "MCP request failed"));
      return message.result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.lastError = redactSecretText(message);
      if (error instanceof Error && error.name === "AbortError") {
        if (cancelled && !timedOut) {
          const cancelledMessage = `MCP request cancelled: ${method}`;
          this.lastError = cancelledMessage;
          throw new McpRequestError(cancelledMessage, { cancelled: true });
        }
        const timeoutMessage = `MCP request timed out: ${method}`;
        this.lastError = timeoutMessage;
        throw new McpRequestError(timeoutMessage, { timedOut: true });
      }
      throw new Error(this.lastError);
    } finally {
      clearTimeout(timer);
      abortSignal?.removeEventListener("abort", abortFromContext);
    }
  }

  notify(method: string, params: unknown): void {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1000);
    timer.unref();
    void fetch(String(this.config.url), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ jsonrpc: "2.0", method, params }),
      signal: controller.signal
    }).catch(() => undefined).finally(() => clearTimeout(timer));
  }

  errorTail(): string {
    return this.lastError;
  }

  async close(): Promise<void> {
    try {
      await this.request("shutdown", {}, 1000);
    } catch {
      try {
        await this.request("close", {}, 1000);
      } catch {
        // Best-effort close.
      }
    }
    this.closed = true;
  }
}

async function initializeClient(client: McpJsonRpcClient, timeoutMs: number): Promise<McpTool[]> {
  await client.request(
    "initialize",
    {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "sigma", version: "0.1.0" }
    },
    timeoutMs
  );
  client.notify("notifications/initialized", {});
  const listResult = await client.request("tools/list", {}, timeoutMs);
  const tools = (listResult as { tools?: unknown }).tools;
  return Array.isArray(tools)
    ? tools.filter((tool): tool is McpTool => Boolean(tool) && typeof (tool as { name?: unknown }).name === "string")
    : [];
}

function toolAllowed(tool: McpTool, serverConfig: McpServerConfig): boolean {
  const enabled = stringList(serverConfig.enabledTools);
  const disabled = new Set(stringList(serverConfig.disabledTools) ?? []);
  if (enabled && enabled.length > 0 && !enabled.includes(tool.name)) return false;
  return !disabled.has(tool.name);
}

function mcpToolContent(result: unknown): ToolResult {
  const isError = (result as { isError?: unknown })?.isError === true;
  const content = (result as { content?: unknown })?.content;
  if (Array.isArray(content)) {
    const text = content
      .map((part) => {
        if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
          return (part as { text: string }).text;
        }
        return JSON.stringify(part);
      })
      .join("\n");
    return { ok: !isError, content: text, metadata: { mcp: true, isError } };
  }
  return { ok: !isError, content: JSON.stringify(result), metadata: { mcp: true, isError } };
}

function registeredMcpTool(options: {
  serverName: string;
  tool: McpTool;
  sigmaName: string;
  client: McpJsonRpcClient;
  serverConfig: McpServerConfig;
}): RegisteredTool {
  const mode = approvalMode(options.serverConfig.approvalMode);
  const readOnly = options.tool.annotations?.readOnlyHint === true;
  return {
    definition: {
      type: "function",
      function: {
        name: options.sigmaName,
        description: `MCP tool ${options.serverName}/${options.tool.name}. ${options.tool.description ?? ""}`.trim(),
        parameters: options.tool.inputSchema ?? { type: "object", additionalProperties: true }
      }
    },
    risk: mode === "auto" && readOnly ? "read" : "unknown",
    async execute(args: unknown, context: ToolExecutionContext): Promise<ToolResult> {
      if (!(mode === "approve" || (mode === "auto" && readOnly))) {
        const denied = await requestToolPermission(context, {
          toolName: options.sigmaName,
          arguments: args,
          risk: "unknown",
          reason: `Call MCP tool ${options.serverName}/${options.tool.name}`
        });
        if (denied) return denied;
      }
      const timeoutSec = numberOrDefault(options.serverConfig.toolTimeoutSec, 60, 1, 3600);
      try {
        const result = await options.client.request(
          "tools/call",
          { name: options.tool.name, arguments: args },
          timeoutSec * 1000,
          context.abortSignal
        );
        return mcpToolContent(result);
      } catch (error) {
        const requestError = error instanceof McpRequestError ? error : null;
        return {
          ok: false,
          content: error instanceof Error ? error.message : String(error),
          metadata: {
            mcp: true,
            server: options.serverName,
            tool: options.tool.name,
            ...(requestError?.metadata.cancelled ? { cancelled: true } : {}),
            ...(requestError?.metadata.timedOut ? { timedOut: true } : {})
          }
        };
      }
    }
  };
}

export async function createMcpToolRegistry(
  options: CreateMcpToolRegistryOptions
): Promise<CreateMcpToolRegistryResult> {
  const workspacePath = path.resolve(options.workspacePath);
  const config = await loadMcpConfig(workspacePath, options.configPath);
  const summaries: McpServerRunSummary[] = [];
  const tools: RegisteredTool[] = [];
  const clients: McpJsonRpcClient[] = [];
  const seenToolNames = new Set<string>();
  if (!config?.servers || typeof config.servers !== "object") {
    return { registry: createToolRegistryFromTools([]), servers: summaries };
  }

  for (const [serverName, serverConfig] of Object.entries(config.servers)) {
    const enabled = serverConfig.enabled !== false;
    const transport = transportValue(serverConfig.transport);
    const summary: McpServerRunSummary = { name: serverName, enabled, transport, tools_loaded: 0 };
    summaries.push(summary);
    if (!enabled) continue;
    if (transport === "stdio" && (typeof serverConfig.command !== "string" || serverConfig.command.length === 0)) {
      summary.error = "MCP stdio server command must be a non-empty string";
      continue;
    }
    if (transport === "http" && (typeof serverConfig.url !== "string" || serverConfig.url.length === 0)) {
      summary.error = "MCP HTTP server url must be a non-empty string";
      continue;
    }

    const client: McpJsonRpcClient = transport === "http"
      ? new HttpMcpClient(serverName, serverConfig as Required<Pick<McpServerConfig, "url">>)
      : new StdioMcpClient(serverName, serverConfig as Required<Pick<McpServerConfig, "command">>, workspacePath);
    try {
      if (client instanceof StdioMcpClient) await client.start();
      const startupTimeoutSec = numberOrDefault(serverConfig.startupTimeoutSec, 10, 1, 120);
      const listedTools = await initializeClient(client, startupTimeoutSec * 1000);
      const serverPrefix = sanitizeName(serverName);
      for (const tool of listedTools.filter((candidate) => toolAllowed(candidate, serverConfig))) {
        const sigmaName = `mcp_${serverPrefix}_${sanitizeName(tool.name)}`;
        if (seenToolNames.has(sigmaName)) {
          summary.error = summary.error
            ? `${summary.error}; duplicate MCP tool name after sanitization: ${sigmaName}`
            : `Duplicate MCP tool name after sanitization: ${sigmaName}`;
          continue;
        }
        seenToolNames.add(sigmaName);
        tools.push(registeredMcpTool({ serverName, tool, sigmaName, client, serverConfig }));
        summary.tools_loaded += 1;
      }
      clients.push(client);
    } catch (error) {
      summary.error = redactSecretText(
        `${error instanceof Error ? error.message : String(error)}${client.errorTail?.() ? `; detail: ${client.errorTail?.()}` : ""}`
      );
      await client.close();
    }
  }

  const registry = createToolRegistryFromTools(tools);
  const originalClose = registry.close?.bind(registry);
  registry.close = async () => {
    await originalClose?.();
    await Promise.all(clients.map((client) => client.close()));
  };
  return { registry, servers: summaries };
}
