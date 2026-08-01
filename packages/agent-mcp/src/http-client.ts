import type { JsonValue } from "agent-protocol";
import { SIGMA_PROJECT_FACTS } from "./generated-project-facts.js";
import {
  McpCancelledError,
  McpConnectionError,
  McpProtocolError,
  McpRpcError,
  McpTimeoutError
} from "./errors.js";
import { parseIncomingJsonRpc } from "./json-rpc.js";
import { contentBlock, initializeResult, jsonObject, objectValue, toolDefinition } from "./protocol-values.js";
import {
  MCP_SUPPORTED_PROTOCOL_VERSIONS,
  type McpCallToolResult,
  type McpHttpServerConfig,
  type McpRequestOptions,
  type McpServerInfo,
  type McpTimeoutConfig,
  type McpToolDefinition
} from "./types.js";

type ClientState = "new" | "connecting" | "ready" | "closing" | "closed" | "failed";

const DEFAULT_TIMEOUTS: McpTimeoutConfig = {
  idleTimeoutMs: 30_000,
  hardDeadlineMs: 120_000,
  shutdownGraceMs: 750
};

function cancellation(signal: AbortSignal | undefined): McpCancelledError {
  const reason = signal?.reason;
  return new McpCancelledError(reason instanceof Error ? reason.message : "MCP request cancelled.", {
    cause: reason instanceof Error ? reason : undefined
  });
}

function validatedConfig(config: McpHttpServerConfig): {
  url: URL;
  headers: Record<string, string>;
  supportedVersions: string[];
  timeouts: McpTimeoutConfig;
  maxMessageBytes: number;
} {
  if (!config.name.trim()) throw new Error("MCP server name is required.");
  const url = new URL(config.url);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("MCP HTTP server URL must use http or https.");
  }
  const supportedVersions = [...(config.supportedProtocolVersions ?? MCP_SUPPORTED_PROTOCOL_VERSIONS)];
  if (supportedVersions.length === 0) throw new Error("At least one MCP protocol version must be supported.");
  const timeouts = { ...DEFAULT_TIMEOUTS, ...config.timeouts };
  for (const [key, value] of Object.entries(timeouts)) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`MCP ${key} must be positive.`);
  }
  const maxMessageBytes = config.maxMessageBytes ?? 8 * 1024 * 1024;
  if (!Number.isFinite(maxMessageBytes) || maxMessageBytes <= 0) {
    throw new Error("MCP maxMessageBytes must be positive.");
  }
  return { url, headers: { ...config.headers }, supportedVersions, timeouts, maxMessageBytes };
}

export class McpHttpClient {
  private readonly url: URL;
  private readonly headers: Record<string, string>;
  private readonly supportedVersions: string[];
  private readonly timeouts: McpTimeoutConfig;
  private readonly maxMessageBytes: number;
  private nextId = 1;
  private stateValue: ClientState = "new";
  private protocolVersion?: string;
  private sessionId?: string;
  private serverInfoValue?: McpServerInfo;

  constructor(private readonly config: McpHttpServerConfig) {
    const resolved = validatedConfig(config);
    this.url = resolved.url;
    this.headers = resolved.headers;
    this.supportedVersions = resolved.supportedVersions;
    this.timeouts = resolved.timeouts;
    this.maxMessageBytes = resolved.maxMessageBytes;
  }

  get state(): ClientState { return this.stateValue; }
  get serverInfo(): McpServerInfo | undefined { return this.serverInfoValue; }

  async connect(signal?: AbortSignal): Promise<McpServerInfo> {
    if (this.stateValue !== "new") {
      throw new McpConnectionError(`Cannot connect an MCP client in '${this.stateValue}' state.`);
    }
    if (signal?.aborted) throw cancellation(signal);
    this.stateValue = "connecting";
    try {
      const result = initializeResult(await this.sendRequest("initialize", {
        protocolVersion: this.supportedVersions[0],
        capabilities: {},
        clientInfo: this.config.clientInfo ?? {
          name: "sigma",
          version: SIGMA_PROJECT_FACTS.productVersion
        }
      }, { signal }), this.supportedVersions);
      this.protocolVersion = result.protocolVersion;
      await this.sendNotification("notifications/initialized", {}, signal);
      this.serverInfoValue = result;
      this.stateValue = "ready";
      return result;
    } catch (error) {
      this.stateValue = "failed";
      throw error;
    }
  }

  async listTools(options: McpRequestOptions = {}): Promise<McpToolDefinition[]> {
    this.assertReady();
    const tools: McpToolDefinition[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const result = objectValue(
        await this.sendRequest("tools/list", cursor ? { cursor } : {}, options),
        "tools/list result"
      );
      if (!Array.isArray(result.tools)) throw new McpProtocolError("tools/list result.tools must be an array.");
      for (const value of result.tools) tools.push(toolDefinition(value));
      cursor = typeof result.nextCursor === "string" && result.nextCursor.length > 0
        ? result.nextCursor
        : undefined;
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
    const result = objectValue(
      await this.sendRequest("tools/call", { name, arguments: argumentsValue }, options),
      "tools/call result"
    );
    if (!Array.isArray(result.content)) throw new McpProtocolError("tools/call result.content must be an array.");
    return {
      content: result.content.map((value, index) => contentBlock(value, `tools/call content[${index}]`)),
      ...(result.structuredContent && typeof result.structuredContent === "object"
        ? { structuredContent: jsonObject(result.structuredContent, "tools/call structuredContent") }
        : {}),
      ...(typeof result.isError === "boolean" ? { isError: result.isError } : {})
    };
  }

  async request(
    method: string,
    params: { [key: string]: JsonValue },
    options: McpRequestOptions = {}
  ): Promise<unknown> {
    this.assertReady();
    return await this.sendRequest(method, params, options);
  }

  async notify(method: string, params?: { [key: string]: JsonValue }): Promise<void> {
    this.assertReady();
    await this.sendNotification(method, params ?? {});
  }

  async close(): Promise<void> {
    if (this.stateValue === "closed") return;
    this.stateValue = "closing";
    try {
      if (this.sessionId) await this.terminateSession(this.sessionId);
    } finally {
      this.sessionId = undefined;
      this.stateValue = "closed";
    }
  }

  private async terminateSession(sessionId: string): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new McpTimeoutError(
      "shutdown",
      `MCP HTTP session shutdown exceeded ${this.timeouts.shutdownGraceMs}ms.`
    )), this.timeouts.shutdownGraceMs);
    timer.unref();
    try {
      const response = await fetch(this.url, {
        method: "DELETE",
        headers: {
          ...this.headers,
          ...(this.protocolVersion ? { "mcp-protocol-version": this.protocolVersion } : {}),
          "mcp-session-id": sessionId
        },
        signal: controller.signal
      });
      if (!response.ok && response.status !== 404) {
        throw new McpConnectionError(
          `MCP HTTP session shutdown returned ${response.status} ${response.statusText}.`
        );
      }
    } catch (error) {
      if (controller.signal.aborted && controller.signal.reason instanceof McpTimeoutError) {
        throw controller.signal.reason;
      }
      if (error instanceof McpConnectionError) throw error;
      throw new McpConnectionError("MCP HTTP session shutdown failed.", {
        cause: error instanceof Error ? error : undefined
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private async sendRequest(
    method: string,
    params: Record<string, unknown>,
    options: McpRequestOptions
  ): Promise<unknown> {
    if (this.stateValue !== "ready" && this.stateValue !== "connecting") {
      throw new McpConnectionError("MCP server is not connected.");
    }
    const id = this.nextId++;
    const value = await this.exchange({
      jsonrpc: "2.0",
      id,
      method,
      params: {
        ...params,
        _meta: {
          ...objectValue(params._meta ?? {}, "request _meta"),
          progressToken: `sigma-mcp-${id}`
        }
      }
    }, options);
    const messages = parseIncomingJsonRpc(value);
    const response = messages.find((message) =>
      message.kind === "response" && message.value.id === id
    );
    if (!response || response.kind !== "response") {
      throw new McpProtocolError(`MCP HTTP '${method}' response did not contain request id ${id}.`);
    }
    if ("error" in response.value) {
      const error = objectValue(response.value.error, "JSON-RPC error");
      throw new McpRpcError(
        typeof error.code === "number" ? error.code : -32603,
        typeof error.message === "string" ? error.message : "MCP request failed.",
        error.data
      );
    }
    return response.value.result;
  }

  private async sendNotification(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<void> {
    await this.exchange({ jsonrpc: "2.0", method, params }, { signal }, false);
  }

  private async readExchangeResponse(response: Response, expectsBody: boolean): Promise<unknown> {
    if (!response.ok) {
      throw new McpConnectionError(`MCP HTTP server returned ${response.status} ${response.statusText}.`);
    }
    this.sessionId = response.headers.get("mcp-session-id") ?? this.sessionId;
    const body = await response.text();
    if (Buffer.byteLength(body, "utf8") > this.maxMessageBytes) {
      throw new McpProtocolError(`MCP HTTP response exceeded ${this.maxMessageBytes} bytes.`);
    }
    if (!expectsBody) return undefined;
    if (!body.trim()) throw new McpProtocolError("MCP HTTP response body is empty.");
    try {
      return JSON.parse(body) as unknown;
    } catch {
      throw new McpProtocolError("MCP HTTP response is not valid JSON.");
    }
  }

  private throwExchangeError(
    error: unknown,
    options: McpRequestOptions,
    controller: AbortController
  ): never {
    if (options.signal?.aborted) throw cancellation(options.signal);
    if (controller.signal.aborted && controller.signal.reason instanceof McpTimeoutError) {
      throw controller.signal.reason;
    }
    if (error instanceof McpConnectionError || error instanceof McpProtocolError) throw error;
    throw new McpConnectionError("MCP HTTP request failed.", {
      cause: error instanceof Error ? error : undefined
    });
  }

  private async exchange(
    message: Record<string, unknown>,
    options: McpRequestOptions,
    expectsBody = true
  ): Promise<unknown> {
    if (options.signal?.aborted) throw cancellation(options.signal);
    const timeoutMs = Math.min(
      options.idleTimeoutMs ?? this.timeouts.idleTimeoutMs,
      options.hardDeadlineMs ?? this.timeouts.hardDeadlineMs
    );
    const controller = new AbortController();
    const onAbort = (): void => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(new McpTimeoutError(
      "deadline",
      `MCP HTTP request exceeded its ${timeoutMs}ms deadline.`
    )), timeoutMs);
    timer.unref();
    try {
      const response = await fetch(this.url, {
        method: "POST",
        headers: {
          ...this.headers,
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          ...(this.protocolVersion ? { "mcp-protocol-version": this.protocolVersion } : {}),
          ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {})
        },
        body: JSON.stringify(message),
        signal: controller.signal
      });
      return await this.readExchangeResponse(response, expectsBody);
    } catch (error) {
      this.throwExchangeError(error, options, controller);
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    }
  }

  private assertReady(): void {
    if (this.stateValue !== "ready") {
      throw new McpConnectionError(`MCP client is not ready (state: ${this.stateValue}).`);
    }
  }
}
