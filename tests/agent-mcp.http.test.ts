import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { McpHttpClient } from "../packages/agent-mcp/src/index.js";

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
});
