import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import {
  McpCancelledError,
  McpConnectionError,
  McpHttpClient,
  McpProtocolError,
  McpRpcError
} from "../packages/agent-mcp/src/index.js";

async function requestBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  let text = "";
  for await (const chunk of request) text += String(chunk);
  return JSON.parse(text) as Record<string, unknown>;
}

function json(response: ServerResponse, value: unknown): void {
  response.writeHead(200, { "content-type": "application/json", "mcp-session-id": "http-session" });
  response.end(JSON.stringify(value));
}

describe("MCP Streamable HTTP client", () => {
  it("validates configuration and rejects operations in invalid lifecycle states", async () => {
    const base = { name: "fixture", url: "http://127.0.0.1:1/mcp" };
    expect(() => new McpHttpClient({ ...base, name: " " })).toThrow("name is required");
    expect(() => new McpHttpClient({ ...base, url: "file:///tmp/mcp" })).toThrow("http or https");
    expect(() => new McpHttpClient({ ...base, supportedProtocolVersions: [] })).toThrow(
      "At least one MCP protocol version"
    );
    expect(() => new McpHttpClient({
      ...base,
      timeouts: { idleTimeoutMs: Number.NaN }
    })).toThrow("idleTimeoutMs must be positive");
    expect(() => new McpHttpClient({
      ...base,
      timeouts: { hardDeadlineMs: 0 }
    })).toThrow("hardDeadlineMs must be positive");
    expect(() => new McpHttpClient({ ...base, maxMessageBytes: Number.POSITIVE_INFINITY })).toThrow(
      "maxMessageBytes must be positive"
    );
    expect(() => new McpHttpClient({ ...base, maxMessageBytes: 0 })).toThrow(
      "maxMessageBytes must be positive"
    );

    const client = new McpHttpClient(base);
    await expect(client.listTools()).rejects.toBeInstanceOf(McpConnectionError);
    await expect(client.callTool("tool", {})).rejects.toBeInstanceOf(McpConnectionError);
    await expect(client.request("custom", {})).rejects.toBeInstanceOf(McpConnectionError);
    await expect(client.notify("custom")).rejects.toBeInstanceOf(McpConnectionError);

    const aborted = new AbortController();
    aborted.abort("cancelled");
    await expect(client.connect(aborted.signal)).rejects.toBeInstanceOf(McpCancelledError);
    expect(client.state).toBe("new");
    await client.close();
    await client.close();
    expect(client.state).toBe("closed");
    await expect(client.connect()).rejects.toBeInstanceOf(McpConnectionError);
  });

  it("initializes, authenticates, lists tools, and calls a tool", async () => {
    const requests: Array<{ authorization?: string; protocolVersion?: string; message: Record<string, unknown> }> = [];
    let terminated = false;
    const server = createServer(async (request, response) => {
      if (request.method === "DELETE") {
        terminated = request.headers["mcp-session-id"] === "http-session";
        response.writeHead(204);
        response.end();
        return;
      }
      const message = await requestBody(request);
      requests.push({
        authorization: request.headers.authorization,
        protocolVersion: request.headers["mcp-protocol-version"] as string | undefined,
        message
      });
      if (message.method === "notifications/initialized") {
        response.writeHead(202);
        response.end();
        return;
      }
      if (message.method === "initialize") {
        json(response, {
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: "2025-11-25",
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "fixture-http", version: "1" }
          }
        });
        return;
      }
      if (message.method === "tools/list") {
        json(response, {
          jsonrpc: "2.0",
          id: message.id,
          result: {
            tools: [{ name: "preview_snapshot", description: "Inspect preview", inputSchema: { type: "object" } }]
          }
        });
        return;
      }
      const params = message.params as Record<string, unknown>;
      json(response, {
        jsonrpc: "2.0",
        id: message.id,
        result: {
          content: [{ type: "text", text: JSON.stringify(params.arguments) }],
          structuredContent: { ok: true }
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    const client = new McpHttpClient({
      name: "fixture",
      url: `http://127.0.0.1:${address.port}/mcp`,
      headers: { Authorization: "Bearer test-token" }
    });
    try {
      await expect(client.connect()).resolves.toMatchObject({
        protocolVersion: "2025-11-25",
        serverInfo: { name: "fixture-http" }
      });
      await expect(client.listTools()).resolves.toEqual([
        expect.objectContaining({ name: "preview_snapshot" })
      ]);
      await expect(client.callTool("preview_snapshot", { tabId: "tab-1" })).resolves.toMatchObject({
        structuredContent: { ok: true },
        content: [{ type: "text", text: '{"tabId":"tab-1"}' }]
      });
      expect(requests.every((entry) => entry.authorization === "Bearer test-token")).toBe(true);
      expect(requests.slice(1).every((entry) => entry.protocolVersion === "2025-11-25")).toBe(true);
    } finally {
      await client.close();
      expect(terminated).toBe(true);
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("paginates tools and surfaces protocol and RPC failures without corrupting the session", async () => {
    let listRequests = 0;
    let callRequests = 0;
    const server = createServer(async (request, response) => {
      if (request.method === "DELETE") {
        response.writeHead(404);
        response.end();
        return;
      }
      const message = await requestBody(request);
      if (message.method === "notifications/initialized" || message.method === "custom/notice") {
        response.writeHead(202);
        response.end();
        return;
      }
      if (message.method === "initialize") {
        json(response, {
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            serverInfo: { name: "fixture-http", version: "1" }
          }
        });
        return;
      }
      if (message.method === "tools/list") {
        listRequests += 1;
        if (listRequests === 1) {
          json(response, {
            jsonrpc: "2.0",
            id: message.id,
            result: {
              tools: [{ name: "first", inputSchema: { type: "object" } }],
              nextCursor: "page-2"
            }
          });
          return;
        }
        if (listRequests === 2) {
          json(response, {
            jsonrpc: "2.0",
            id: message.id,
            result: { tools: [{ name: "second", inputSchema: { type: "object" } }] }
          });
          return;
        }
        if (listRequests <= 4) {
          json(response, {
            jsonrpc: "2.0",
            id: message.id,
            result: { tools: [], nextCursor: "repeat" }
          });
          return;
        }
        json(response, { jsonrpc: "2.0", id: message.id, result: { tools: "invalid" } });
        return;
      }
      if (message.method === "tools/call") {
        callRequests += 1;
        json(response, {
          jsonrpc: "2.0",
          id: message.id,
          result: callRequests === 1
            ? { content: [{ type: "text", text: "ok" }], isError: false }
            : { content: "invalid" }
        });
        return;
      }
      if (message.method === "explode") {
        json(response, {
          jsonrpc: "2.0",
          id: message.id,
          error: { code: 42, message: "boom", data: { retryable: false } }
        });
        return;
      }
      json(response, { jsonrpc: "2.0", id: 999, result: null });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    const client = new McpHttpClient({
      name: "fixture",
      url: `http://127.0.0.1:${address.port}/mcp`
    });
    try {
      await client.connect();
      await expect(client.listTools()).resolves.toEqual([
        expect.objectContaining({ name: "first" }),
        expect.objectContaining({ name: "second" })
      ]);
      await expect(client.listTools()).rejects.toBeInstanceOf(McpProtocolError);
      await expect(client.listTools()).rejects.toThrow("result.tools must be an array");
      await expect(client.callTool("first", {})).resolves.toEqual({
        content: [{ type: "text", text: "ok" }],
        isError: false
      });
      await expect(client.callTool("invalid", {})).rejects.toThrow(
        "tools/call result.content must be an array"
      );
      const rpcError = await client.request("explode", {}).catch((error: unknown) => error);
      expect(rpcError).toBeInstanceOf(McpRpcError);
      expect(rpcError).toEqual(expect.objectContaining({
        name: "McpRpcError",
        code: 42,
        message: "boom",
        data: { retryable: false }
      }));
      await expect(client.request("missing", {})).rejects.toThrow("did not contain request id");
      await expect(client.notify("custom/notice")).resolves.toBeUndefined();
      expect(client.serverInfo).toMatchObject({ serverInfo: { name: "fixture-http" } });
    } finally {
      await client.close();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
