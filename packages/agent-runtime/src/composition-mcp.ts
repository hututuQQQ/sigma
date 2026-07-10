import path from "node:path";
import { realpath } from "node:fs/promises";
import type { McpServerConfigValue } from "agent-config";
import { McpStdioClient, McpToolBridge } from "agent-mcp";
import type { ToolEffect } from "agent-protocol";
import { registerToolExecutor, type EffectToolRegistry } from "agent-tools";

function createClient(server: McpServerConfigValue, cwd: string): McpStdioClient {
  return new McpStdioClient({
    name: server.name,
    command: server.command,
    args: server.args,
    cwd,
    env: server.env,
    timeouts: {
      idleTimeoutMs: server.idleTimeoutMs,
      hardDeadlineMs: server.hardDeadlineMs,
      shutdownGraceMs: server.shutdownGraceMs
    }
  });
}

function containedBy(workspace: string, candidate: string): boolean {
  const relative = path.relative(workspace, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export async function resolveMcpWorkingDirectory(workspace: string, configuredCwd: string): Promise<string> {
  const canonicalWorkspace = await realpath(path.resolve(workspace));
  const canonicalCwd = await realpath(path.resolve(canonicalWorkspace, configuredCwd));
  if (!containedBy(canonicalWorkspace, canonicalCwd)) {
    throw new Error(`MCP working directory must stay inside the workspace: ${configuredCwd}`);
  }
  return canonicalCwd;
}

async function registerClient(client: McpStdioClient, server: McpServerConfigValue, tools: EffectToolRegistry): Promise<void> {
  await client.connect();
  const bridge = await McpToolBridge.create(client, {
    namespace: `mcp_${server.name}`,
    policy: {
      possibleEffects: server.possibleEffects as ToolEffect[],
      approval: server.approval,
      executionMode: server.executionMode,
      idempotent: server.idempotent,
      timeoutMs: server.timeoutMs
    }
  });
  registerToolExecutor(tools, bridge);
}

export async function closeMcpClients(clients: readonly McpStdioClient[]): Promise<void> {
  await Promise.allSettled(clients.map(async (client) => await client.close()));
}

export async function connectMcpServers(
  servers: readonly McpServerConfigValue[],
  workspace: string,
  tools: EffectToolRegistry
): Promise<McpStdioClient[]> {
  const clients: McpStdioClient[] = [];
  try {
    const resolved = await Promise.all(servers.map(async (server) => ({
      server,
      cwd: await resolveMcpWorkingDirectory(workspace, server.cwd)
    })));
    for (const { server, cwd } of resolved) {
      const client = createClient(server, cwd);
      clients.push(client);
      await registerClient(client, server, tools);
    }
    return clients;
  } catch (error) {
    await closeMcpClients(clients);
    throw error;
  }
}
