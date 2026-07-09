import path from "node:path";
import type { McpServerConfigValue } from "agent-config";
import { McpStdioClient, McpToolBridge } from "agent-mcp";
import type { ToolEffect } from "agent-protocol";
import { registerToolExecutor, type EffectToolRegistry } from "agent-tools";

function createClient(server: McpServerConfigValue, workspace: string): McpStdioClient {
  return new McpStdioClient({
    name: server.name,
    command: server.command,
    args: server.args,
    cwd: path.resolve(workspace, server.cwd),
    env: server.env,
    timeouts: {
      idleTimeoutMs: server.idleTimeoutMs,
      hardDeadlineMs: server.hardDeadlineMs,
      shutdownGraceMs: server.shutdownGraceMs
    }
  });
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
    for (const server of servers) {
      const client = createClient(server, workspace);
      clients.push(client);
      await registerClient(client, server, tools);
    }
    return clients;
  } catch (error) {
    await closeMcpClients(clients);
    throw error;
  }
}
