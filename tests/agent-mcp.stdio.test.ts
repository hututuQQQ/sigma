import { describe, expect, it, vi } from "vitest";
import type { JsonValue, ToolEffect, ToolExecutionContext } from "../packages/agent-protocol/src/index.js";
import {
  McpConnectionError,
  McpProtocolError,
  McpRpcError,
  McpStdioClient,
  McpToolBridge
} from "../packages/agent-mcp/src/index.js";
import { resolveMcpClientSettings } from "../packages/agent-mcp/src/config.js";
import { JsonLineDecoder } from "../packages/agent-mcp/src/framing.js";
import { parseIncomingJsonRpc } from "../packages/agent-mcp/src/json-rpc.js";
import {
  contentBlock,
  initializeResult,
  jsonObject,
  objectValue,
  stringValue,
  toolDefinition
} from "../packages/agent-mcp/src/protocol-values.js";
import { McpStdioTransport, mcpProcessEnvironment } from "../packages/agent-mcp/src/stdio-transport.js";
import type {
  McpCallToolResult,
  McpRequestOptions,
  McpStdioServerConfig,
  McpToolDefinition
} from "../packages/agent-mcp/src/types.js";
import { createHostExecutionBroker } from "./helpers/host-execution-broker.js";

function mcpExecution() {
  return {
    broker: createHostExecutionBroker(),
    possibleEffects: ["filesystem.read" as const],
    policy: {
      sandbox: "required" as const,
      network: "none" as const,
      readRoots: [process.cwd()],
      writeRoots: []
    },
    pollIntervalMs: 2
  };
}

const SERVER = String.raw`
const { spawn } = require("node:child_process");
const mode = process.argv[1] || "normal";
const timers = new Map();
let child;
if (mode === "sticky") {
  child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  process.stderr.write("grandchild:" + child.pid + "\n");
  setInterval(() => {}, 1000);
}
let buffer = "";
const send = value => process.stdout.write(JSON.stringify(value) + "\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  buffer += chunk;
  for (;;) {
    const index = buffer.indexOf("\n");
    if (index < 0) break;
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.method === "initialize") {
      send({ jsonrpc: "2.0", id: message.id, result: {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "fixture", version: "1.0.0" }
      }});
    } else if (message.method === "tools/list") {
      send({ jsonrpc: "2.0", id: message.id, result: { tools: [
        { name: "echo", description: "Echo JSON", inputSchema: { type: "object" } },
        { name: "hang", description: "Wait", inputSchema: { type: "object" } },
        { name: "progress", description: "Report progress", inputSchema: { type: "object" } }
      ] }});
    } else if (message.method === "tools/call" && message.params.name === "echo") {
      send({ jsonrpc: "2.0", id: message.id, result: {
        content: [{ type: "text", text: JSON.stringify(message.params.arguments) }]
      }});
    } else if (message.method === "tools/call" && message.params.name === "progress") {
      const token = message.params._meta.progressToken;
      let progress = 0;
      const timer = setInterval(() => {
        progress += 1;
        send({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: token, progress, total: 100 } });
      }, 8);
      timers.set(message.id, timer);
    } else if (message.method === "notifications/cancelled") {
      const timer = timers.get(message.params.requestId);
      if (timer) clearInterval(timer);
      send({ jsonrpc: "2.0", method: "test/cancel-observed", params: { requestId: message.params.requestId } });
    }
  }
});
`;

const ADVANCED_SERVER = String.raw`
const mode = process.argv[1] || "normal";
let buffer = "";
const send = value => process.stdout.write(JSON.stringify(value) + "\n");
const response = (message, result) => send({ jsonrpc: "2.0", id: message.id, result });
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  buffer += chunk;
  for (;;) {
    const index = buffer.indexOf("\n");
    if (index < 0) break;
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.method === "initialize") {
      if (mode === "bad-version") {
        response(message, { protocolVersion: "unsupported", capabilities: {}, serverInfo: { name: "fixture", version: "1" } });
      } else if (mode === "bad-initialize") {
        response(message, { protocolVersion: message.params.protocolVersion, capabilities: [], serverInfo: { name: "fixture", version: "1" } });
      } else {
        if (mode === "stderr") process.stderr.write("0123456789abcdefghijklmnop");
        response(message, {
          protocolVersion: message.params.protocolVersion,
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: "fixture", version: "2", title: "Advanced fixture" },
          instructions: "fixture instructions"
        });
      }
    } else if (message.method === "tools/list") {
      if (mode === "bad-tools") {
        response(message, { tools: {} });
      } else if (mode === "repeat-cursor") {
        response(message, { tools: [], nextCursor: "again" });
      } else if (mode === "pagination" && !message.params.cursor) {
        response(message, { tools: [{ name: "first", title: "First", inputSchema: {} }], nextCursor: "next" });
      } else {
        response(message, { tools: [{ name: "second", inputSchema: {}, annotations: { readOnlyHint: true } }] });
      }
    } else if (message.method === "rpc/error") {
      send({ jsonrpc: "2.0", id: message.id, error: { code: 42, message: "expected rpc error", data: { retry: false } } });
    } else if (message.method === "rpc/default-error") {
      send({ jsonrpc: "2.0", id: message.id, error: {} });
    } else if (message.method === "batch") {
      send([
        { jsonrpc: "2.0", method: "test/no-params" },
        { jsonrpc: "2.0", method: "test/params", params: { value: true } },
        { jsonrpc: "2.0", id: message.id, result: { batched: true } }
      ]);
    } else if (message.method === "server-requests") {
      send({ jsonrpc: "2.0", id: "ping-request", method: "ping" });
      send({ jsonrpc: "2.0", id: 99, method: "unknown/client/method" });
      response(message, { requested: true });
    } else if (message.method === "bad-response-id") {
      send({ jsonrpc: "2.0", id: "wrong", result: {} });
    } else if (message.method === "both-result-error") {
      send({ jsonrpc: "2.0", id: message.id, result: {}, error: {} });
    } else if (message.method === "malformed") {
      process.stdout.write("not-json\n");
    } else if (message.method === "exit-now") {
      process.exit(7);
    } else if (message.method === "invalid-notification") {
      send({ jsonrpc: "2.0", method: "test/invalid", params: [] });
    } else if (message.method === "late-response") {
      setTimeout(() => response(message, { late: true }), 60);
    } else if (message.method === "progress-variants") {
      const token = message.params._meta.progressToken;
      send({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: { invalid: true }, progress: 1 } });
      send({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: "unknown", progress: 1 } });
      send({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: token, progress: 2, message: "working" } });
      response(message, { progressed: true });
    } else if (message.method === "bad-server-request") {
      send({ jsonrpc: "2.0", id: null, method: "ping" });
    } else if (message.method === "tools/call") {
      if (message.params.name === "bad-content") response(message, { content: {} });
      else response(message, { content: [{ type: "text", text: "ok" }], structuredContent: { ok: true }, isError: false });
    } else if (message.method === "client/notice") {
      send({ jsonrpc: "2.0", method: "test/notice-seen", params: message.params || {} });
    } else if (message.id === "ping-request" || message.id === 99) {
      send({
        jsonrpc: "2.0",
        method: "test/client-response",
        params: { id: message.id, hasResult: Object.prototype.hasOwnProperty.call(message, "result"), hasError: Object.prototype.hasOwnProperty.call(message, "error") }
      });
    }
  }
});
`;

function createClient(
  mode = "normal",
  hooks: ConstructorParameters<typeof McpStdioClient>[1] = {},
  timeouts: { idleTimeoutMs?: number; hardDeadlineMs?: number; shutdownGraceMs?: number } = {}
): McpStdioClient {
  return new McpStdioClient({
    name: "fixture",
    command: process.execPath,
    args: ["-e", SERVER, mode],
    cwd: process.cwd(),
    timeouts: { idleTimeoutMs: 1_000, hardDeadlineMs: 5_000, shutdownGraceMs: 50, ...timeouts }
  }, hooks, mcpExecution());
}

function createAdvancedClient(
  mode = "normal",
  hooks: ConstructorParameters<typeof McpStdioClient>[1] = {},
  overrides: Partial<McpStdioServerConfig> = {}
): McpStdioClient {
  return new McpStdioClient({
    name: "advanced-fixture",
    command: process.execPath,
    args: ["-e", ADVANCED_SERVER, mode],
    cwd: process.cwd(),
    timeouts: { idleTimeoutMs: 250, hardDeadlineMs: 2_000, shutdownGraceMs: 50 },
    ...overrides
  }, hooks, mcpExecution());
}

function executionContext(
  signal: AbortSignal,
  progress: ToolExecutionContext["progress"] = async () => undefined
): ToolExecutionContext {
  return {
    sessionId: "session",
    runId: "run",
    workspacePath: process.cwd(),
    runMode: "change",
    signal,
    progress,
    createArtifact: async () => "artifact"
  };
}

function fakeBridgeClient(
  tools: McpToolDefinition[],
  result: McpCallToolResult,
  progress: Array<{ progress: number; total?: number; message?: string }> = []
): McpStdioClient {
  return {
    listTools: async () => tools,
    callTool: async (_name: string, _arguments: Record<string, JsonValue>, options: McpRequestOptions = {}) => {
      for (const update of progress) {
        await options.onProgress?.({ progressToken: "fake", ...update });
      }
      return result;
    }
  } as unknown as McpStdioClient;
}

async function eventually(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Condition was not met before timeout.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

describe("MCP protocol normalization", () => {
  it("resolves defaults and rejects unsafe client settings", () => {
    const base: McpStdioServerConfig = {
      name: "fixture",
      command: process.execPath,
      cwd: process.cwd()
    };
    expect(resolveMcpClientSettings(base)).toMatchObject({
      timeouts: { idleTimeoutMs: 30_000, hardDeadlineMs: 120_000, shutdownGraceMs: 750 },
      maxMessageBytes: 8 * 1024 * 1024,
      maxStderrBytes: 256 * 1024
    });
    expect(resolveMcpClientSettings({
      ...base,
      supportedProtocolVersions: ["custom"],
      timeouts: { idleTimeoutMs: 1, hardDeadlineMs: 2, shutdownGraceMs: 3 },
      maxMessageBytes: 4,
      maxStderrBytes: 5
    })).toEqual({
      supportedVersions: ["custom"],
      timeouts: { idleTimeoutMs: 1, hardDeadlineMs: 2, shutdownGraceMs: 3 },
      maxMessageBytes: 4,
      maxStderrBytes: 5
    });
    expect(() => resolveMcpClientSettings({ ...base, supportedProtocolVersions: [] })).toThrow("At least one");
    expect(() => resolveMcpClientSettings({ ...base, name: " " })).toThrow("name is required");
    expect(() => resolveMcpClientSettings({ ...base, command: " " })).toThrow("command is required");
    expect(() => resolveMcpClientSettings({ ...base, timeouts: { idleTimeoutMs: 0 } })).toThrow("idleTimeoutMs");
    expect(() => resolveMcpClientSettings({ ...base, maxMessageBytes: Number.NaN })).toThrow("maxMessageBytes");
    expect(() => resolveMcpClientSettings({ ...base, maxStderrBytes: -1 })).toThrow("maxStderrBytes");
  });

  it("classifies JSON-RPC batches and rejects malformed envelopes", () => {
    expect(parseIncomingJsonRpc([
      { jsonrpc: "2.0", id: 1, result: {} },
      { jsonrpc: "2.0", id: "server", method: "ping" },
      { jsonrpc: "2.0", method: "notifications/tools/list_changed" }
    ]).map((message) => message.kind)).toEqual(["response", "request", "notification"]);
    expect(() => parseIncomingJsonRpc(null)).toThrow("must be an object");
    expect(() => parseIncomingJsonRpc({ jsonrpc: "1.0", method: "ping" })).toThrow("JSON-RPC 2.0");
    expect(() => parseIncomingJsonRpc({ jsonrpc: "2.0", id: 1, result: {}, error: {} })).toThrow("both result and error");
    expect(() => parseIncomingJsonRpc({ jsonrpc: "2.0", id: 1 })).toThrow("Unrecognized");
  });

  it("validates initialize, tool, content, and JSON values", () => {
    expect(() => objectValue([], "value")).toThrow("must be an object");
    expect(() => stringValue("", "value")).toThrow("non-empty string");
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => jsonObject(cyclic, "cyclic")).toThrow("not JSON serializable");

    const initialized = initializeResult({
      protocolVersion: "v1",
      capabilities: { tools: {} },
      serverInfo: { name: "fixture", version: "1", title: "Fixture server" },
      instructions: "Use carefully"
    }, ["v1"]);
    expect(initialized).toEqual({
      protocolVersion: "v1",
      capabilities: { tools: {} },
      serverInfo: { name: "fixture", version: "1", title: "Fixture server" },
      instructions: "Use carefully"
    });
    expect(() => initializeResult({
      protocolVersion: "v2",
      capabilities: {},
      serverInfo: { name: "fixture", version: "1" }
    }, ["v1"])).toThrow("unsupported protocol version");
    expect(() => initializeResult({
      protocolVersion: "v1",
      capabilities: [],
      serverInfo: { name: "fixture", version: "1" }
    }, ["v1"])).toThrow("capabilities must be an object");

    expect(contentBlock({ type: "text", text: "ok" }, "content")).toEqual({ type: "text", text: "ok" });
    expect(() => contentBlock({ text: "missing type" }, "content")).toThrow("type must be a non-empty string");
    expect(toolDefinition({
      name: "annotated",
      title: "Title",
      description: "Description",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      annotations: {
        title: "Annotation title",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    })).toEqual({
      name: "annotated",
      title: "Title",
      description: "Description",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      annotations: {
        title: "Annotation title",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    });
    expect(toolDefinition({ name: "minimal", inputSchema: {} })).toEqual({ name: "minimal", inputSchema: {} });
    expect(toolDefinition({
      name: "ignored-annotation-types",
      inputSchema: {},
      annotations: { readOnlyHint: "yes" }
    })).toEqual({ name: "ignored-annotation-types", inputSchema: {}, annotations: {} });
    expect(() => toolDefinition({ name: "bad", inputSchema: {}, annotations: [] })).toThrow("annotations must be an object");
  });

  it("normalizes bridge descriptors, results, errors, and progress", async () => {
    const tools: McpToolDefinition[] = [
      { name: "alpha.one", description: "Alpha", inputSchema: { type: "object" } },
      { name: "beta", title: "Beta title", inputSchema: { type: "object" } },
      { name: "gamma", inputSchema: { type: "object" }, annotations: { title: "Gamma title" } },
      { name: "omega", inputSchema: { type: "object" } }
    ];
    const client = fakeBridgeClient(tools, {
      content: [
        { type: "text", text: "hello" },
        { type: "resource", resource: { text: "resource text" } },
        { type: "resource", resource: { uri: "file:///tmp/value" } },
        { type: "image", data: "encoded" }
      ],
      isError: true
    }, [
      { progress: 3, total: 2, message: "over total" },
      { progress: 1 }
    ]);
    const bridge = await McpToolBridge.create(client, {
      namespace: " scope.name... ",
      policy: { possibleEffects: ["network"], executionMode: "parallel", approval: "auto", idempotent: true, timeoutMs: 321 }
    });
    expect(bridge.descriptors().map(({ name, description }) => ({ name, description }))).toEqual([
      { name: "scope_name__alpha_one", description: "Alpha" },
      { name: "scope_name__beta", description: "Beta title" },
      { name: "scope_name__gamma", description: "Gamma title" },
      { name: "scope_name__omega", description: "MCP tool omega" }
    ]);
    expect(bridge.descriptors()[0]).toMatchObject({
      possibleEffects: ["network"],
      executionMode: "parallel",
      approval: "auto",
      idempotent: true,
      timeoutMs: 321,
      resourceKeys: ["mcp:scope.name"]
    });
    const progress = vi.fn(async () => undefined);
    const receipt = await bridge.execute(
      { callId: "call", name: "scope_name__alpha_one", arguments: { value: true } },
      executionContext(new AbortController().signal, progress)
    );
    expect(receipt).toMatchObject({
      ok: false,
      observedEffects: ["network"],
      diagnostics: ["MCP server reported a tool error."]
    });
    expect(receipt.output).toContain("hello\nresource text\n");
    expect(receipt.output).toContain("file:///tmp/value");
    expect(progress).toHaveBeenNthCalledWith(1, { message: "over total", percent: 100 });
    expect(progress).toHaveBeenNthCalledWith(2, { message: "MCP alpha.one is running." });

    await expect(bridge.execute(
      { callId: "bad-args", name: "scope_name__alpha_one", arguments: null },
      executionContext(new AbortController().signal)
    )).resolves.toMatchObject({ ok: false, diagnostics: ["MCP tool arguments must be an object."] });
    await expect(bridge.execute(
      { callId: "unknown", name: "scope_name__missing", arguments: {} },
      executionContext(new AbortController().signal)
    )).rejects.toThrow("Unknown MCP tool");

    const structured = await McpToolBridge.create(fakeBridgeClient(tools.slice(0, 1), {
      content: [],
      structuredContent: { answer: 42 }
    }), { namespace: "structured", policy: { possibleEffects: ["filesystem.read"] } });
    await expect(structured.execute(
      { callId: "structured", name: "structured__alpha_one", arguments: {} },
      executionContext(new AbortController().signal)
    )).resolves.toMatchObject({ ok: true, output: "{\"answer\":42}", diagnostics: [] });
    const empty = await McpToolBridge.create(fakeBridgeClient(tools.slice(0, 1), { content: [] }), {
      namespace: "empty", policy: { possibleEffects: ["filesystem.read"] }
    });
    await expect(empty.execute(
      { callId: "empty", name: "empty__alpha_one", arguments: {} },
      executionContext(new AbortController().signal)
    )).resolves.toMatchObject({ ok: true, output: "" });
  });

  it("rejects ambiguous bridge namespaces, names, and policies", async () => {
    const single: McpToolDefinition[] = [{ name: "tool", inputSchema: {} }];
    const undeclared = fakeBridgeClient(single, { content: [] });
    const undeclaredList = vi.spyOn(undeclared, "listTools");
    await expect(McpToolBridge.create(undeclared, {
      namespace: "scope", policy: {} as { possibleEffects: ToolEffect[] }
    })).rejects.toMatchObject({ code: "mcp_effects_required" });
    expect(undeclaredList).not.toHaveBeenCalled();
    for (const effect of ["filesystem.write", "destructive", "open_world"] as const) {
      const forbidden = fakeBridgeClient(single, { content: [] });
      const forbiddenList = vi.spyOn(forbidden, "listTools");
      await expect(McpToolBridge.create(forbidden, {
        namespace: "scope", policy: { possibleEffects: [effect] }
      })).rejects.toMatchObject({ code: "mcp_persistent_effect_forbidden", forbiddenEffects: [effect] });
      expect(forbiddenList).not.toHaveBeenCalled();
    }
    await expect(McpToolBridge.create(fakeBridgeClient(single, { content: [] }), {
      namespace: "...", policy: { possibleEffects: ["filesystem.read"] }
    }))
      .rejects.toThrow("namespace is required");
    await expect(McpToolBridge.create(fakeBridgeClient(single, { content: [] }), {
      namespace: "scope",
      policy: { possibleEffects: ["filesystem.read"], timeoutMs: 0 }
    })).rejects.toThrow("timeout must be positive");
    await expect(McpToolBridge.create(fakeBridgeClient([
      { name: "same.name", inputSchema: {} },
      { name: "same_name", inputSchema: {} }
    ], { content: [] }), {
      namespace: "scope", policy: { possibleEffects: ["filesystem.read"] }
    })).rejects.toThrow("Duplicate MCP tool");
    await expect(McpToolBridge.create(fakeBridgeClient([
      { name: "x".repeat(80), inputSchema: {} }
    ], { content: [] }), {
      namespace: "scope", policy: { possibleEffects: ["filesystem.read"] }
    })).rejects.toThrow("cannot be represented safely");
  });
});

describe("MCP stdio client", () => {
  it("negotiates, discovers tools, and bridges typed receipts", async () => {
    const client = createClient();
    try {
      await expect(client.connect()).resolves.toMatchObject({
        protocolVersion: "2025-11-25",
        serverInfo: { name: "fixture", version: "1.0.0" }
      });
      const bridge = await McpToolBridge.create(client, {
        namespace: "fixture",
        policy: { possibleEffects: ["network"], approval: "prompt", timeoutMs: 1_000 }
      });
      expect(bridge.descriptors().map((tool) => tool.name)).toEqual([
        "fixture__echo",
        "fixture__hang",
        "fixture__progress"
      ]);
      const receipt = await bridge.execute({ callId: "call", name: "fixture__echo", arguments: { value: "你好" } }, executionContext(new AbortController().signal));
      expect(receipt).toMatchObject({ ok: true, output: "{\"value\":\"你好\"}", observedEffects: ["network"] });
    } finally {
      await client.close();
    }
  });

  it("propagates AbortSignal promptly and sends a cancellation notification", async () => {
    const notifications: string[] = [];
    const client = createClient("normal", { onNotification: (value) => { notifications.push(value.method); } });
    try {
      await client.connect();
      const controller = new AbortController();
      const startedAt = Date.now();
      const pending = client.callTool("hang", {}, { signal: controller.signal, idleTimeoutMs: 5_000, hardDeadlineMs: 5_000 });
      setTimeout(() => controller.abort(new Error("stop")), 20);
      await expect(pending).rejects.toMatchObject({ name: "AbortError", message: "stop" });
      expect(Date.now() - startedAt).toBeLessThan(500);
      await eventually(() => notifications.includes("test/cancel-observed"));
    } finally {
      await client.close();
    }
  });

  it("distinguishes idle timeout from an absolute hard deadline", async () => {
    const client = createClient();
    try {
      await client.connect();
      await expect(client.callTool("hang", {}, { idleTimeoutMs: 30, hardDeadlineMs: 500 }))
        .rejects.toMatchObject({ name: "TimeoutError", timeoutKind: "idle" });
      let progressEvents = 0;
      await expect(client.callTool("progress", {}, {
        idleTimeoutMs: 1_000,
        hardDeadlineMs: 250,
        onProgress: () => { progressEvents += 1; }
      })).rejects.toMatchObject({ name: "TimeoutError", timeoutKind: "deadline" });
      expect(progressEvents).toBeGreaterThan(0);
    } finally {
      await client.close();
    }
  });

  it("enforces lifecycle state, request metadata, and notification contracts", async () => {
    const unopened = createAdvancedClient();
    expect(unopened.processId).toBeUndefined();
    expect(unopened.serverInfo).toBeUndefined();
    expect(unopened.stderr).toBe("");
    await expect(unopened.listTools()).rejects.toBeInstanceOf(McpConnectionError);
    await expect(unopened.callTool("tool", {})).rejects.toBeInstanceOf(McpConnectionError);
    await expect(unopened.request("method", {})).rejects.toBeInstanceOf(McpConnectionError);
    await expect(unopened.notify("notice")).rejects.toBeInstanceOf(McpConnectionError);
    const aborted = new AbortController();
    aborted.abort("cancelled before connect");
    await expect(unopened.connect(aborted.signal)).rejects.toMatchObject({
      name: "AbortError",
      message: "MCP request cancelled."
    });
    await unopened.close();
    await unopened.close();
    expect(unopened.state).toBe("closed");
    await expect(unopened.connect()).rejects.toThrow("closed");

    const notifications: Array<{ method: string; params?: Record<string, JsonValue> }> = [];
    const client = createAdvancedClient("normal", {
      onNotification: (notification) => { notifications.push(notification); }
    }, { clientInfo: { name: "test-client", version: "1", title: "Test" } });
    try {
      const server = await client.connect();
      expect(client.serverInfo).toEqual(server);
      expect(server).toMatchObject({
        serverInfo: { title: "Advanced fixture" },
        instructions: "fixture instructions"
      });
      await expect(client.connect()).rejects.toThrow("ready");
      await expect(client.request("invalid-timeout", {}, { idleTimeoutMs: 0 })).rejects.toThrow("timeouts must be positive");
      await expect(client.request("invalid-meta", { _meta: [] })).rejects.toThrow("request _meta must be an object");
      const cancelled = new AbortController();
      cancelled.abort("cancelled before request");
      await expect(client.request("cancelled", {}, { signal: cancelled.signal })).rejects.toMatchObject({
        name: "AbortError",
        message: "MCP request cancelled."
      });
      await client.notify("client/notice");
      await client.notify("client/notice", { value: true });
      await eventually(() => notifications.filter((item) => item.method === "test/notice-seen").length === 2);
      expect(notifications.filter((item) => item.method === "test/notice-seen").map((item) => item.params))
        .toEqual([{}, { value: true }]);
    } finally {
      await client.close();
      await client.close();
    }
  });

  it("ignores late responses, normalizes progress variants, and rejects pending work on close", async () => {
    const client = createAdvancedClient();
    try {
      await client.connect();
      await expect(client.request("late-response", {}, { idleTimeoutMs: 15, hardDeadlineMs: 500 }))
        .rejects.toMatchObject({ timeoutKind: "idle" });
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(client.state).toBe("ready");
      const progress = vi.fn();
      await expect(client.request("progress-variants", {}, { onProgress: progress })).resolves.toEqual({ progressed: true });
      await eventually(() => progress.mock.calls.length === 1);
      expect(progress).toHaveBeenCalledWith({ progressToken: expect.any(String), progress: 2, message: "working" });
    } finally {
      await client.close();
    }

    const closing = createAdvancedClient();
    await closing.connect();
    const pending = closing.request("no-response", {});
    const firstClose = closing.close();
    const secondClose = closing.close();
    await expect(pending).rejects.toBeInstanceOf(McpConnectionError);
    await Promise.all([firstClose, secondClose]);
    expect(closing.state).toBe("closed");
  });

  it("paginates tools and rejects malformed or cyclic tool listings", async () => {
    const paginated = createAdvancedClient("pagination");
    try {
      await paginated.connect();
      await expect(paginated.listTools()).resolves.toEqual([
        { name: "first", title: "First", inputSchema: {} },
        { name: "second", inputSchema: {}, annotations: { readOnlyHint: true } }
      ]);
    } finally {
      await paginated.close();
    }

    const repeated = createAdvancedClient("repeat-cursor");
    try {
      await repeated.connect();
      await expect(repeated.listTools()).rejects.toThrow("repeated a tools/list cursor");
    } finally {
      await repeated.close();
    }

    const malformed = createAdvancedClient("bad-tools");
    try {
      await malformed.connect();
      await expect(malformed.listTools()).rejects.toThrow("result.tools must be an array");
    } finally {
      await malformed.close();
    }
  });

  it("normalizes RPC errors, batches, client requests, and call results", async () => {
    const notifications: Array<{ method: string; params?: Record<string, JsonValue> }> = [];
    const client = createAdvancedClient("normal", {
      onNotification: async (notification) => {
        notifications.push(notification);
        if (notification.method === "test/no-params") throw new Error("ignored hook failure");
      }
    });
    try {
      await client.connect();
      const rpc = client.request("rpc/error", {});
      await expect(rpc).rejects.toBeInstanceOf(McpRpcError);
      await expect(rpc).rejects.toMatchObject({ code: 42, message: "expected rpc error", data: { retry: false } });
      await expect(client.request("rpc/default-error", {})).rejects.toMatchObject({
        code: -32603,
        message: "MCP request failed."
      });
      await expect(client.request("batch", {})).resolves.toEqual({ batched: true });
      await expect(client.request("server-requests", {})).resolves.toEqual({ requested: true });
      await eventually(() => notifications.filter((item) => item.method === "test/client-response").length === 2);
      expect(notifications.filter((item) => item.method === "test/client-response").map((item) => item.params)).toEqual([
        { id: "ping-request", hasResult: true, hasError: false },
        { id: 99, hasResult: false, hasError: true }
      ]);
      expect(notifications).toEqual(expect.arrayContaining([
        { method: "test/no-params" },
        { method: "test/params", params: { value: true } }
      ]));
      await expect(client.callTool("normal", {})).resolves.toEqual({
        content: [{ type: "text", text: "ok" }],
        structuredContent: { ok: true },
        isError: false
      });
      await expect(client.callTool("bad-content", {})).rejects.toThrow("result.content must be an array");
    } finally {
      await client.close();
    }
  });

  it.each([
    ["bad-response-id", McpProtocolError],
    ["both-result-error", McpProtocolError],
    ["malformed", McpProtocolError],
    ["invalid-notification", McpProtocolError],
    ["bad-server-request", McpProtocolError],
    ["exit-now", McpConnectionError]
  ] as const)("fails pending requests when the server violates transport protocol: %s", async (method, expectedError) => {
    const client = createAdvancedClient();
    try {
      await client.connect();
      await expect(client.request(method, {}, { idleTimeoutMs: 1_000 })).rejects.toBeInstanceOf(expectedError);
      expect(client.state).toBe("failed");
      await expect(client.request("after-failure", {})).rejects.toBeInstanceOf(McpConnectionError);
    } finally {
      await client.close();
    }
  });

  it("rejects invalid initialization and process startup", async () => {
    for (const mode of ["bad-version", "bad-initialize"]) {
      const client = createAdvancedClient(mode);
      await expect(client.connect()).rejects.toBeInstanceOf(McpProtocolError);
      expect(client.state).toBe("closed");
    }
    const missing = createAdvancedClient("normal", {}, { command: `missing-mcp-${process.pid}-${Date.now()}` });
    await expect(missing.connect()).rejects.toBeInstanceOf(McpConnectionError);
    expect(missing.state).toBe("closed");
  });

  it("rejects unsafe persistent capabilities before the transport spawns a process", async () => {
    for (const effect of ["filesystem.write", "destructive", "open_world"] as const) {
      const execution = mcpExecution();
      const spawn = vi.spyOn(execution.broker, "spawn");
      const client = new McpStdioClient({
        name: `forbidden-${effect}`,
        command: process.execPath,
        args: ["-e", "process.stdin.resume()"],
        cwd: process.cwd()
      }, {}, { ...execution, possibleEffects: [effect] });
      await expect(client.connect()).rejects.toMatchObject({
        code: "mcp_persistent_effect_forbidden",
        forbiddenEffects: [effect]
      });
      expect(spawn).not.toHaveBeenCalled();
      await execution.broker.close();
    }

    const execution = mcpExecution();
    const spawn = vi.spyOn(execution.broker, "spawn");
    const client = new McpStdioClient({
      name: "write-root",
      command: process.execPath,
      args: ["-e", "process.stdin.resume()"],
      cwd: process.cwd()
    }, {}, {
      ...execution,
      policy: { ...execution.policy, writeRoots: [process.cwd()] }
    });
    await expect(client.connect()).rejects.toMatchObject({ code: "mcp_write_roots_forbidden" });
    expect(spawn).not.toHaveBeenCalled();
    await execution.broker.close();
  });

  it("bounds stderr even when diagnostic hooks throw", async () => {
    const seen = vi.fn(() => { throw new Error("diagnostic hook failure"); });
    const client = createAdvancedClient("stderr", { onStderr: seen }, { maxStderrBytes: 8 });
    try {
      await client.connect();
      await eventually(() => seen.mock.calls.length > 0);
      expect(client.stderr).toBe("ijklmnop");
      expect(seen).toHaveBeenCalled();
    } finally {
      await client.close();
    }
  });

  it("decodes split UTF-8 stderr without replacement characters", async () => {
    const seen: string[] = [];
    const script = [
      "const value = Buffer.from([0xe4,0xb8,0xad,0xe6,0x96,0x87,0x20,0xf0,0x9f,0x9a,0x80]);",
      "let index = 0;",
      "const timer = setInterval(() => {",
      "  process.stderr.write(value.subarray(index, index + 1));",
      "  index += 1;",
      "  if (index >= value.length) clearInterval(timer);",
      "}, 2);",
      "process.stdin.resume();"
    ].join("\n");
    const transport = new McpStdioTransport({
      name: "unicode-stderr", command: process.execPath, args: ["-e", script], cwd: process.cwd()
    }, {
      onMessage: () => undefined,
      onFailure: () => undefined,
      onStderr: (text) => seen.push(text)
    }, 1_024, 1_024, 10, mcpExecution());
    try {
      await transport.start();
      await eventually(() => transport.stderr === "中文 🚀");
      expect(seen.join("")).toBe("中文 🚀");
      expect(transport.stderr).not.toContain("�");
    } finally {
      await transport.close();
    }
  });

  it("guards direct transport lifecycle and decodes an unterminated final frame", async () => {
    const config: McpStdioServerConfig = {
      name: "transport",
      command: process.execPath,
      args: ["-e", "process.stdin.resume()"],
      cwd: process.cwd()
    };
    const transport = new McpStdioTransport(config, {
      onMessage: () => undefined,
      onFailure: () => undefined
    }, 1_024, 1_024, 10, mcpExecution());
    await expect(transport.send({ jsonrpc: "2.0", method: "before-start" })).rejects.toBeInstanceOf(McpConnectionError);
    await transport.start();
    expect(transport.processId).toBeTypeOf("number");
    await expect(transport.start()).rejects.toThrow("already started");
    await transport.send({ jsonrpc: "2.0", method: "notice" });
    await transport.close();
    await transport.close();
    await expect(transport.send({ jsonrpc: "2.0", method: "after-close" })).rejects.toBeInstanceOf(McpConnectionError);

    const messages: unknown[] = [];
    const failures: Error[] = [];
    const tail = new McpStdioTransport({
      ...config,
      args: ["-e", "process.stdout.write(JSON.stringify({tail:true}))"]
    }, {
      onMessage: (message) => { messages.push(message); },
      onFailure: (error) => { failures.push(error); }
    }, 1_024, 1_024, 10, mcpExecution());
    await tail.start();
    await eventually(() => messages.length === 1 && failures.length === 1);
    expect(messages).toEqual([{ tail: true }]);
    expect(failures[0]).toBeInstanceOf(McpConnectionError);
    await tail.close();

    const invalidTailFailures: Error[] = [];
    const invalidTail = new McpStdioTransport({
      ...config,
      args: ["-e", "process.stdout.write('{')"]
    }, {
      onMessage: () => undefined,
      onFailure: (error) => { invalidTailFailures.push(error); }
    }, 1_024, 1_024, 10, mcpExecution());
    await invalidTail.start();
    await eventually(() => invalidTailFailures.length > 0);
    expect(invalidTailFailures[0]).toBeInstanceOf(McpProtocolError);
    await invalidTail.close();

    const backpressure = new McpStdioTransport({
      ...config,
      args: ["-e", "setTimeout(() => process.stdin.resume(), 50); setInterval(() => {}, 1000)"]
    }, {
      onMessage: () => undefined,
      onFailure: () => undefined
    }, 1_024, 1_024, 10, mcpExecution());
    await backpressure.start();
    await backpressure.send({ jsonrpc: "2.0", method: "large", payload: "x".repeat(2 * 1024 * 1024) });
    await backpressure.close();
  });

  it("inherits only the MCP environment allowlist plus explicitly configured values", async () => {
    expect(mcpProcessEnvironment({ MCP_EXPLICIT: "allowed" }, {
      PATH: "safe-path",
      DEEPSEEK_API_KEY: "deepseek-secret",
      GLM_API_KEY: "glm-secret",
      NODE_OPTIONS: "--require=malicious.cjs"
    })).toEqual({ PATH: "safe-path", MCP_EXPLICIT: "allowed" });
    const secretKey = `SIGMA_MCP_SECRET_${process.pid}`;
    const previous = process.env[secretKey];
    process.env[secretKey] = "must-not-leak";
    const messages: unknown[] = [];
    const script = `process.stdout.write(JSON.stringify({secret:process.env[${JSON.stringify(secretKey)}],explicit:process.env.MCP_EXPLICIT,path:Boolean(process.env.PATH||process.env.Path)})+"\\n");setInterval(()=>{},1000)`;
    const transport = new McpStdioTransport({
      name: "environment",
      command: process.execPath,
      args: ["-e", script],
      cwd: process.cwd(),
      env: { MCP_EXPLICIT: "allowed" }
    }, {
      onMessage: (message) => { messages.push(message); },
      onFailure: () => undefined
    }, 1_024, 1_024, 10, mcpExecution());
    try {
      await transport.start();
      await eventually(() => messages.length === 1);
      expect(messages[0]).toEqual({ explicit: "allowed", path: true });
    } finally {
      await transport.close();
      if (previous === undefined) delete process.env[secretKey];
      else process.env[secretKey] = previous;
    }
  });

  it("terminates the server process tree after graceful shutdown expires", async () => {
    const client = createClient("sticky");
    await client.connect();
    const serverPid = client.processId;
    await eventually(() => /grandchild:\d+/.test(client.stderr));
    const grandchildPid = Number(/grandchild:(\d+)/.exec(client.stderr)?.[1]);
    expect(serverPid).toBeTypeOf("number");
    expect(grandchildPid).toBeGreaterThan(0);
    await client.close();
    await eventually(() => !processExists(serverPid!) && !processExists(grandchildPid));
  });

  it("rejects malformed and oversized frames", () => {
    const decoder = new JsonLineDecoder(20);
    expect(() => decoder.push(Buffer.from("not-json\n"))).toThrow(McpProtocolError);
    expect(() => new JsonLineDecoder(4).push(Buffer.from("{\"long\":true}"))).toThrow(/exceeded/);
    expect(new JsonLineDecoder(8).push(Buffer.from("{}\n{}\n{}\n"))).toHaveLength(3);
    expect(new JsonLineDecoder(20).push(Buffer.from("\r\n{}\r\n\n"))).toEqual([{}]);
    const whitespaceTail = new JsonLineDecoder(20);
    whitespaceTail.push(Buffer.from("   "));
    expect(whitespaceTail.end()).toEqual([]);
    const completeTail = new JsonLineDecoder(20);
    completeTail.push(Buffer.from("{\"tail\":true}"));
    expect(completeTail.end()).toEqual([{ tail: true }]);
    expect(() => new JsonLineDecoder(4).push(Buffer.from("{\"a\":1}\n"))).toThrow(/exceeded/);
  });
});
