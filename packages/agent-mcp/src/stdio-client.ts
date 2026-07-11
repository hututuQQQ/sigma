import type { JsonValue } from "agent-protocol";
import { resolveMcpClientSettings } from "./config.js";
import {
  McpCancelledError,
  McpConnectionError,
  McpProtocolError,
  McpRpcError,
  McpTimeoutError
} from "./errors.js";
import { contentBlock, initializeResult, jsonObject, objectValue, toolDefinition } from "./protocol-values.js";
import { parseIncomingJsonRpc } from "./json-rpc.js";
import { McpStdioTransport } from "./stdio-transport.js";
import {
  type McpCallToolResult,
  type McpClientHooks,
  type McpNotification,
  type McpProgress,
  type McpProcessExecution,
  type McpRequestOptions,
  type McpServerInfo,
  type McpStdioServerConfig,
  type McpToolDefinition,
  type McpTimeoutConfig
} from "./types.js";

type ClientState = "new" | "connecting" | "ready" | "closing" | "closed" | "failed";

interface PendingRequest {
  id: number;
  method: string;
  progressToken: string;
  cancellable: boolean;
  idleTimeoutMs: number;
  resolve(value: unknown): void;
  reject(error: Error): void;
  onProgress?: McpRequestOptions["onProgress"];
  signal?: AbortSignal;
  onAbort?: () => void;
  idleTimer?: ReturnType<typeof setTimeout>;
  deadlineTimer?: ReturnType<typeof setTimeout>;
}

interface RequestSettings extends McpRequestOptions {
  cancellable?: boolean;
}

function cancellation(signal: AbortSignal | undefined): McpCancelledError {
  const reason = signal?.reason;
  return new McpCancelledError(reason instanceof Error ? reason.message : "MCP request cancelled.", {
    cause: reason instanceof Error ? reason : undefined
  });
}

export class McpStdioClient {
  private readonly timeouts: McpTimeoutConfig;
  private readonly supportedVersions: string[];
  private readonly transport: McpStdioTransport;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly progressRequests = new Map<string, number>();
  private nextId = 1;
  private stateValue: ClientState = "new";
  private closePromise?: Promise<void>;
  private serverInfoValue?: McpServerInfo;

  constructor(
    private readonly config: McpStdioServerConfig,
    private readonly hooks: McpClientHooks = {},
    execution?: McpProcessExecution
  ) {
    const settings = resolveMcpClientSettings(config);
    this.timeouts = settings.timeouts;
    this.supportedVersions = settings.supportedVersions;
    this.transport = new McpStdioTransport(config, {
      onMessage: (message) => this.handleMessage(message),
      onFailure: (error) => this.fail(error, false),
      onStderr: hooks.onStderr
    }, settings.maxMessageBytes, settings.maxStderrBytes, settings.timeouts.shutdownGraceMs, execution);
  }

  get state(): ClientState { return this.stateValue; }
  get processId(): number | undefined { return this.transport.processId; }
  get stderr(): string { return this.transport.stderr; }
  get serverInfo(): McpServerInfo | undefined { return this.serverInfoValue; }

  async connect(signal?: AbortSignal): Promise<McpServerInfo> {
    if (this.stateValue !== "new") throw new McpConnectionError(`Cannot connect an MCP client in '${this.stateValue}' state.`);
    if (signal?.aborted) throw cancellation(signal);
    this.stateValue = "connecting";
    try {
      await this.transport.start();
      const result = initializeResult(await this.sendRequest("initialize", {
        protocolVersion: this.supportedVersions[0],
        capabilities: {},
        clientInfo: this.config.clientInfo ?? { name: "sigma", version: "2.0.0" }
      }, { signal, cancellable: false }), this.supportedVersions);
      await this.enqueue({ jsonrpc: "2.0", method: "notifications/initialized" });
      this.serverInfoValue = result;
      this.stateValue = "ready";
      return result;
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async listTools(options: McpRequestOptions = {}): Promise<McpToolDefinition[]> {
    this.assertReady();
    const tools: McpToolDefinition[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const result = objectValue(await this.sendRequest("tools/list", cursor ? { cursor } : {}, options), "tools/list result");
      if (!Array.isArray(result.tools)) throw new McpProtocolError("tools/list result.tools must be an array.");
      for (const value of result.tools) tools.push(toolDefinition(value));
      cursor = typeof result.nextCursor === "string" && result.nextCursor.length > 0 ? result.nextCursor : undefined;
      if (cursor && cursors.has(cursor)) throw new McpProtocolError("MCP server repeated a tools/list cursor.");
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return tools;
  }

  async callTool(
    name: string,
    argumentsValue: { [key: string]: JsonValue },
    options: McpRequestOptions = {}
  ): Promise<McpCallToolResult> {
    this.assertReady();
    const result = objectValue(await this.sendRequest("tools/call", { name, arguments: argumentsValue }, options), "tools/call result");
    if (!Array.isArray(result.content)) throw new McpProtocolError("tools/call result.content must be an array.");
    return {
      content: result.content.map((value, index) => contentBlock(value, `tools/call content[${index}]`)),
      ...(result.structuredContent && typeof result.structuredContent === "object"
        ? { structuredContent: jsonObject(result.structuredContent, "tools/call structuredContent") }
        : {}),
      ...(typeof result.isError === "boolean" ? { isError: result.isError } : {})
    };
  }

  async request(method: string, params: { [key: string]: JsonValue }, options: McpRequestOptions = {}): Promise<unknown> {
    this.assertReady();
    return await this.sendRequest(method, params, options);
  }

  async notify(method: string, params?: { [key: string]: JsonValue }): Promise<void> {
    this.assertReady();
    await this.enqueue({ jsonrpc: "2.0", method, ...(params ? { params } : {}) });
  }

  async close(): Promise<void> {
    if (this.stateValue === "closed") return;
    if (this.closePromise) return await this.closePromise;
    this.closePromise = this.closeInternal();
    return await this.closePromise;
  }

  private sendRequest(method: string, params: Record<string, unknown>, settings: RequestSettings): Promise<unknown> {
    if (this.stateValue !== "ready" && this.stateValue !== "connecting") {
      return Promise.reject(new McpConnectionError("MCP server is not connected."));
    }
    if (settings.signal?.aborted) return Promise.reject(cancellation(settings.signal));
    const id = this.nextId++;
    const progressToken = `sigma-mcp-${id}`;
    const idleTimeoutMs = settings.idleTimeoutMs ?? this.timeouts.idleTimeoutMs;
    const hardDeadlineMs = settings.hardDeadlineMs ?? this.timeouts.hardDeadlineMs;
    if (idleTimeoutMs <= 0 || hardDeadlineMs <= 0) return Promise.reject(new Error("MCP request timeouts must be positive."));
    const requestParams = {
      ...params,
      _meta: { ...(objectValue(params._meta ?? {}, "request _meta")), progressToken }
    };
    return new Promise((resolve, reject) => {
      const pending: PendingRequest = {
        id,
        method,
        progressToken,
        cancellable: settings.cancellable !== false && method !== "initialize",
        idleTimeoutMs,
        resolve,
        reject,
        onProgress: settings.onProgress,
        signal: settings.signal
      };
      pending.onAbort = () => this.cancelPending(pending, cancellation(settings.signal));
      settings.signal?.addEventListener("abort", pending.onAbort, { once: true });
      pending.deadlineTimer = setTimeout(() => this.cancelPending(pending, new McpTimeoutError(
        "deadline",
        `MCP '${method}' exceeded its ${hardDeadlineMs}ms hard deadline.`
      )), hardDeadlineMs);
      pending.deadlineTimer.unref();
      this.pending.set(id, pending);
      this.progressRequests.set(progressToken, id);
      this.armIdle(pending);
      void this.enqueue({ jsonrpc: "2.0", id, method, params: requestParams }).catch((error: unknown) => {
        this.settle(pending, undefined, error instanceof Error ? error : new McpConnectionError(String(error)));
      });
    });
  }

  private armIdle(pending: PendingRequest): void {
    clearTimeout(pending.idleTimer);
    pending.idleTimer = setTimeout(() => this.cancelPending(pending, new McpTimeoutError(
      "idle",
      `MCP '${pending.method}' was idle for ${pending.idleTimeoutMs}ms.`
    )), pending.idleTimeoutMs);
    pending.idleTimer.unref();
  }

  private cancelPending(pending: PendingRequest, error: Error): void {
    if (!this.pending.has(pending.id)) return;
    if (pending.cancellable) {
      void this.enqueue({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: pending.id, reason: error.message }
      }).catch(() => undefined);
    }
    this.settle(pending, undefined, error);
  }

  private settle(pending: PendingRequest, value?: unknown, error?: Error): void {
    if (!this.pending.delete(pending.id)) return;
    this.progressRequests.delete(pending.progressToken);
    clearTimeout(pending.idleTimer);
    clearTimeout(pending.deadlineTimer);
    if (pending.signal && pending.onAbort) pending.signal.removeEventListener("abort", pending.onAbort);
    if (error) pending.reject(error);
    else pending.resolve(value);
  }

  private handleMessage(input: unknown): void {
    for (const message of parseIncomingJsonRpc(input)) {
      if (message.kind === "response") this.handleResponse(message.value);
      else if (message.kind === "request") this.handleServerRequest(message.value);
      else this.handleNotification(message.value);
    }
  }

  private handleResponse(message: Record<string, unknown>): void {
    if (typeof message.id !== "number") throw new McpProtocolError("MCP response id must match a numeric client request id.");
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.armIdle(pending);
    if ("error" in message) {
      const value = objectValue(message.error, "JSON-RPC error");
      const code = typeof value.code === "number" ? value.code : -32603;
      const text = typeof value.message === "string" ? value.message : "MCP request failed.";
      this.settle(pending, undefined, new McpRpcError(code, text, value.data));
    } else {
      this.settle(pending, message.result);
    }
  }

  private handleNotification(message: Record<string, unknown>): void {
    const params = message.params === undefined ? undefined : jsonObject(message.params, "notification params");
    if (message.method === "notifications/progress" && params) {
      const token = params.progressToken;
      const id = typeof token === "string" || typeof token === "number" ? this.progressRequests.get(String(token)) : undefined;
      const pending = id === undefined ? undefined : this.pending.get(id);
      if (pending && typeof params.progress === "number") {
        this.armIdle(pending);
        const progress: McpProgress = {
          progressToken: token as string | number,
          progress: params.progress,
          ...(typeof params.total === "number" ? { total: params.total } : {}),
          ...(typeof params.message === "string" ? { message: params.message } : {})
        };
        if (pending.onProgress) void Promise.resolve(pending.onProgress(progress)).catch(() => undefined);
      }
    }
    const notification: McpNotification = { method: message.method as string, ...(params ? { params } : {}) };
    if (this.hooks.onNotification) void Promise.resolve(this.hooks.onNotification(notification)).catch(() => undefined);
  }

  private handleServerRequest(message: Record<string, unknown>): void {
    const id = message.id;
    if (typeof id !== "number" && typeof id !== "string") throw new McpProtocolError("Server request id must be a string or number.");
    const response = message.method === "ping"
      ? { jsonrpc: "2.0", id, result: {} }
      : { jsonrpc: "2.0", id, error: { code: -32601, message: `Unsupported client method '${message.method as string}'.` } };
    void this.enqueue(response).catch(() => undefined);
  }

  private enqueue(message: Record<string, unknown>): Promise<void> { return this.transport.send(message); }

  private fail(error: Error, terminate = true): void {
    if (this.stateValue === "closing" || this.stateValue === "closed" || this.stateValue === "failed") return;
    this.stateValue = "failed";
    for (const pending of [...this.pending.values()]) this.settle(pending, undefined, error);
    if (terminate) void this.transport.close().catch(() => undefined);
  }

  private async closeInternal(): Promise<void> {
    this.stateValue = "closing";
    const error = new McpConnectionError("MCP client closed.");
    for (const pending of [...this.pending.values()]) this.settle(pending, undefined, error);
    await this.transport.close();
    this.stateValue = "closed";
  }

  private assertReady(): void {
    if (this.stateValue !== "ready") throw new McpConnectionError(`MCP client is not ready (state: ${this.stateValue}).`);
  }
}
