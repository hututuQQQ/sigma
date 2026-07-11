import type {
  JsonValue,
  ToolDescriptor,
  ToolExecutionContext,
  ToolExecutor,
  ToolReceipt,
  ToolRequest
} from "agent-protocol";
import { assertMcpPersistentEffectsAllowed } from "agent-protocol";
import { McpProtocolError } from "./errors.js";
import { McpStdioClient } from "./stdio-client.js";
import type { McpContentBlock, McpRequestOptions, McpToolBridgeOptions, McpToolDefinition, McpToolPolicy } from "./types.js";

const DEFAULT_POLICY: McpToolPolicy = {
  possibleEffects: [],
  executionMode: "sequential",
  approval: "prompt",
  idempotent: false,
  timeoutMs: 120_000
};

function argumentsObject(value: JsonValue): { [key: string]: JsonValue } | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as { [key: string]: JsonValue }
    : undefined;
}

function renderBlock(block: McpContentBlock): string {
  if (block.type === "text" && typeof block.text === "string") return block.text;
  if (block.type === "resource" && block.resource && typeof block.resource === "object" && !Array.isArray(block.resource)) {
    const resource = block.resource as { [key: string]: JsonValue };
    if (typeof resource.text === "string") return resource.text;
  }
  return JSON.stringify(block);
}

function publicToolName(namespace: string, remoteName: string): string {
  const clean = (value: string): string => value.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  const name = `${clean(namespace)}__${clean(remoteName)}`;
  if (!name || name.length > 64) throw new McpProtocolError(`MCP tool name '${namespace}/${remoteName}' cannot be represented safely.`);
  return name;
}

function receipt(
  request: ToolRequest,
  startedAt: string,
  ok: boolean,
  output: string,
  descriptor: ToolDescriptor,
  diagnostics: string[] = []
): ToolReceipt {
  return {
    callId: request.callId,
    ok,
    output,
    observedEffects: [...descriptor.possibleEffects],
    artifacts: [],
    diagnostics,
    startedAt,
    completedAt: new Date().toISOString()
  };
}

export class McpToolBridge implements ToolExecutor {
  private readonly descriptorValues: ToolDescriptor[];
  private readonly remoteTools = new Map<string, McpToolDefinition>();
  private readonly descriptorByName = new Map<string, ToolDescriptor>();

  private constructor(
    private readonly client: McpStdioClient,
    tools: McpToolDefinition[],
    options: McpToolBridgeOptions
  ) {
    const namespace = options.namespace.trim().replace(/\.+$/, "");
    if (!namespace) throw new Error("MCP tool namespace is required.");
    const policy: McpToolPolicy = {
      ...DEFAULT_POLICY,
      ...options.policy,
      possibleEffects: [...options.policy.possibleEffects]
    };
    if (!Number.isFinite(policy.timeoutMs) || policy.timeoutMs <= 0) throw new Error("MCP tool timeout must be positive.");
    for (const tool of tools) {
      const publicName = publicToolName(namespace, tool.name);
      if (this.remoteTools.has(publicName)) throw new McpProtocolError(`Duplicate MCP tool '${tool.name}'.`);
      const descriptor: ToolDescriptor = {
        name: publicName,
        description: tool.description ?? tool.title ?? tool.annotations?.title ?? `MCP tool ${tool.name}`,
        inputSchema: tool.inputSchema,
        possibleEffects: [...policy.possibleEffects],
        executionMode: policy.executionMode,
        resourceKeys: [`mcp:${namespace}`],
        approval: policy.approval,
        idempotent: policy.idempotent,
        timeoutMs: policy.timeoutMs
      };
      this.remoteTools.set(publicName, tool);
      this.descriptorByName.set(publicName, descriptor);
    }
    this.descriptorValues = [...this.descriptorByName.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  static async create(
    client: McpStdioClient,
    options: McpToolBridgeOptions,
    requestOptions: McpRequestOptions = {}
  ): Promise<McpToolBridge> {
    assertMcpPersistentEffectsAllowed(options.namespace, options.policy?.possibleEffects);
    return new McpToolBridge(client, await client.listTools(requestOptions), options);
  }

  descriptors(): readonly ToolDescriptor[] {
    return this.descriptorValues;
  }

  async execute(request: ToolRequest, context: ToolExecutionContext): Promise<ToolReceipt> {
    const startedAt = new Date().toISOString();
    const remote = this.remoteTools.get(request.name);
    const descriptor = this.descriptorByName.get(request.name);
    if (!remote || !descriptor) throw new Error(`Unknown MCP tool '${request.name}'.`);
    const args = argumentsObject(request.arguments);
    if (!args) return receipt(request, startedAt, false, "", descriptor, ["MCP tool arguments must be an object."]);
    const result = await this.client.callTool(remote.name, args, {
      signal: context.signal,
      hardDeadlineMs: descriptor.timeoutMs,
      onProgress: async (progress) => {
        const percent = progress.total && progress.total > 0
          ? Math.max(0, Math.min(100, progress.progress / progress.total * 100))
          : undefined;
        await context.progress({ message: progress.message ?? `MCP ${remote.name} is running.`, ...(percent === undefined ? {} : { percent }) });
      }
    });
    const rendered = result.content.map(renderBlock).filter(Boolean).join("\n");
    const output = rendered || (result.structuredContent ? JSON.stringify(result.structuredContent) : "");
    const ok = result.isError !== true;
    return receipt(request, startedAt, ok, output, descriptor, ok ? [] : ["MCP server reported a tool error."]);
  }
}
