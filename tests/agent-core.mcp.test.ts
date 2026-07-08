import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createDefaultToolRegistry,
  createMcpToolRegistry,
  mergeToolRegistries,
  type ToolExecutionContext
} from "../packages/agent-core/src/index.js";

async function workspace(): Promise<{ dir: string; context: ToolExecutionContext }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sigma-mcp-"));
  await mkdir(path.join(dir, ".agent"), { recursive: true });
  return {
    dir,
    context: {
      workspacePath: dir,
      permissionMode: "yolo",
      commandTimeoutSec: 2,
      maxToolOutputChars: 4000,
      runState: { todos: [], nextTodoId: 1, changedFiles: new Set<string>() },
      alwaysAllowTools: new Set<string>()
    }
  };
}

async function writeFakeServer(dir: string, code: string): Promise<string> {
  const serverPath = path.join(dir, ".agent", "fake-mcp-server.mjs");
  await writeFile(serverPath, code, "utf8");
  return serverPath;
}

function echoServerCode(): string {
  return `
let buffer = "";
const tools = [
  { name: "echo", description: "Echo text", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
  { name: "read_echo", description: "Read echo", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }
];
function send(message) { process.stdout.write(JSON.stringify(message) + "\\n"); }
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let index;
  while ((index = buffer.indexOf("\\n")) !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const request = JSON.parse(line);
    if (request.method === "initialize") send({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2024-11-05", capabilities: {} } });
    else if (request.method === "tools/list") send({ jsonrpc: "2.0", id: request.id, result: { tools } });
    else if (request.method === "tools/call") send({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: "echo:" + request.params.arguments.text }] } });
    else if (request.method === "shutdown") send({ jsonrpc: "2.0", id: request.id, result: {} });
  }
});
`;
}

async function writeMcpConfig(dir: string, config: unknown): Promise<void> {
  await writeFile(path.join(dir, ".agent", "mcp.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    req.on("end", () => resolve(body));
  });
}

async function startHttpMcpServer(handler: (message: Record<string, unknown>, req: IncomingMessage, res: ServerResponse) => unknown | Promise<unknown>) {
  const seenHeaders: IncomingMessage["headers"][] = [];
  const server = createServer(async (req, res) => {
    seenHeaders.push(req.headers);
    const message = JSON.parse(await readBody(req)) as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(message, "id")) {
      res.writeHead(202).end("{}");
      return;
    }
    const result = await handler(message, req, res);
    if (!res.writableEnded) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing server address");
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    seenHeaders,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  };
}

describe("MCP stdio bridge", () => {
  it("loads and calls a fake stdio MCP echo tool", async () => {
    const { dir, context } = await workspace();
    const serverPath = await writeFakeServer(dir, echoServerCode());
    await writeMcpConfig(dir, {
      servers: {
        local: {
          command: process.execPath,
          args: [serverPath],
          enabledTools: ["echo"],
          approvalMode: "approve"
        }
      }
    });

    const mcp = await createMcpToolRegistry({ workspacePath: dir });
    expect(mcp.servers).toMatchObject([{ name: "local", enabled: true, tools_loaded: 1 }]);
    expect(mcp.registry.definitions.map((definition) => definition.function.name)).toEqual(["mcp_local_echo"]);
    const result = await mcp.registry.execute(
      { id: "mcp-1", type: "function", function: { name: "mcp_local_echo", arguments: { text: "hi" } } },
      context
    );
    expect(result).toMatchObject({ ok: true, content: "echo:hi" });
    await mcp.registry.close?.();
  });

  it("honors enabled and disabled tools and disabled servers", async () => {
    const { dir } = await workspace();
    const serverPath = await writeFakeServer(dir, echoServerCode());
    await writeMcpConfig(dir, {
      servers: {
        local: {
          command: process.execPath,
          args: [serverPath],
          enabledTools: ["echo", "read_echo"],
          disabledTools: ["read_echo"],
          approvalMode: "approve"
        },
        off: {
          command: process.execPath,
          args: [serverPath],
          enabled: false
        }
      }
    });

    const mcp = await createMcpToolRegistry({ workspacePath: dir });
    expect(mcp.registry.definitions.map((definition) => definition.function.name)).toEqual(["mcp_local_echo"]);
    expect(mcp.servers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "local", enabled: true, tools_loaded: 1 }),
        expect.objectContaining({ name: "off", enabled: false, tools_loaded: 0 })
      ])
    );
    await mcp.registry.close?.();
  });

  it("surfaces bad server and timeout errors without breaking core tools", async () => {
    const { dir, context } = await workspace();
    const hangingServer = await writeFakeServer(dir, "setInterval(() => {}, 1000);\n");
    await writeMcpConfig(dir, {
      servers: {
        bad: { command: process.execPath, args: ["missing-file.mjs"], startupTimeoutSec: 1 },
        slow: { command: process.execPath, args: [hangingServer], startupTimeoutSec: 1 }
      }
    });

    const mcp = await createMcpToolRegistry({ workspacePath: dir });
    expect(mcp.servers.filter((server) => server.error)).toHaveLength(2);
    const merged = mergeToolRegistries([createDefaultToolRegistry(), mcp.registry]);
    const result = await merged.execute(
      { id: "read-missing", type: "function", function: { name: "git_status", arguments: {} } },
      context
    );
    expect(result.ok).toBe(true);
    await merged.close?.();
  });

  it("prompts for unknown-risk MCP tools in ask mode unless approved or read-only auto", async () => {
    const { dir, context } = await workspace();
    const serverPath = await writeFakeServer(dir, echoServerCode());
    context.permissionMode = "ask";
    await writeMcpConfig(dir, {
      servers: {
        local: {
          command: process.execPath,
          args: [serverPath],
          approvalMode: "prompt"
        }
      }
    });

    const mcp = await createMcpToolRegistry({ workspacePath: dir });
    await expect(
      mcp.registry.execute(
        { id: "mcp-1", type: "function", function: { name: "mcp_local_echo", arguments: { text: "no" } } },
        context
      )
    ).resolves.toMatchObject({ ok: false });
    await mcp.registry.close?.();

    await writeMcpConfig(dir, {
      servers: {
        local: {
          command: process.execPath,
          args: [serverPath],
          enabledTools: ["read_echo"],
          approvalMode: "auto"
        }
      }
    });
    const auto = await createMcpToolRegistry({ workspacePath: dir });
    await expect(
      auto.registry.execute(
        { id: "mcp-2", type: "function", function: { name: "mcp_local_read_echo", arguments: { text: "yes" } } },
        context
      )
    ).resolves.toMatchObject({ ok: true, content: "echo:yes" });
    await auto.registry.close?.();
  });

  it("loads and calls an HTTP MCP server with headers and bearer token redaction", async () => {
    const { dir, context } = await workspace();
    process.env.SIGMA_MCP_TOKEN = "secret-http-token";
    const server = await startHttpMcpServer((message) => {
      if (message.method === "initialize") return { protocolVersion: "2024-11-05", capabilities: {} };
      if (message.method === "tools/list") {
        return {
          tools: [
            {
              name: "remote_echo",
              description: "Remote echo",
              inputSchema: { type: "object", properties: { text: { type: "string" } } },
              annotations: { readOnlyHint: true }
            }
          ]
        };
      }
      if (message.method === "tools/call") {
        const params = message.params as { arguments?: { text?: string } };
        return { content: [{ type: "text", text: `remote:${params.arguments?.text ?? ""}` }] };
      }
      return {};
    });
    try {
      await writeMcpConfig(dir, {
        servers: {
          remote: {
            transport: "http",
            url: server.url,
            headers: { "X-Project": "sigma" },
            bearerTokenEnv: "SIGMA_MCP_TOKEN",
            approvalMode: "auto"
          }
        }
      });

      const mcp = await createMcpToolRegistry({ workspacePath: dir });
      expect(mcp.servers).toMatchObject([{ name: "remote", enabled: true, transport: "http", tools_loaded: 1 }]);
      const result = await mcp.registry.execute(
        { id: "http-1", type: "function", function: { name: "mcp_remote_remote_echo", arguments: { text: "hi" } } },
        context
      );
      expect(result).toMatchObject({ ok: true, content: "remote:hi" });
      expect(server.seenHeaders.some((headers) => headers["x-project"] === "sigma")).toBe(true);
      expect(server.seenHeaders.some((headers) => headers.authorization === "Bearer secret-http-token")).toBe(true);
      expect(JSON.stringify(mcp.servers)).not.toContain("secret-http-token");
      await mcp.registry.close?.();
    } finally {
      delete process.env.SIGMA_MCP_TOKEN;
      await server.close();
    }
  });
});
