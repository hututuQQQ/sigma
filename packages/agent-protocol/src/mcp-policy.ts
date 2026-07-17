import type { ToolEffect } from "./tools.js";

export const MCP_FORBIDDEN_PERSISTENT_EFFECTS = [
  "filesystem.write",
  "destructive",
  "open_world",
  "filesystem.read.external",
  "process.handoff"
] as const satisfies readonly ToolEffect[];

export type McpCapabilityPolicyErrorCode =
  | "mcp_effects_required"
  | "mcp_persistent_effect_forbidden"
  | "mcp_write_roots_forbidden";

/** A fail-closed error raised before a persistent MCP process receives capabilities. */
export class McpCapabilityPolicyError extends Error {
  override readonly name = "McpCapabilityPolicyError";

  constructor(
    public readonly code: McpCapabilityPolicyErrorCode,
    message: string,
    public readonly serverName: string,
    public readonly forbiddenEffects: readonly ToolEffect[] = []
  ) {
    super(message);
  }
}

export function assertMcpPersistentEffectsAllowed(
  serverName: string,
  effects: readonly ToolEffect[] | undefined
): asserts effects is readonly ToolEffect[] {
  if (!effects) {
    throw new McpCapabilityPolicyError(
      "mcp_effects_required",
      `MCP server '${serverName}' must explicitly declare possible_effects before it can be started.`,
      serverName
    );
  }
  const forbidden = MCP_FORBIDDEN_PERSISTENT_EFFECTS.filter((effect) => effects.includes(effect));
  if (forbidden.length === 0) return;
  throw new McpCapabilityPolicyError(
    "mcp_persistent_effect_forbidden",
    `MCP server '${serverName}' requests forbidden persistent effects: ${forbidden.join(", ")}. `
      + "Sigma MCP servers are read-only and cannot receive workspace write, external-read, handoff, destructive, or open-world capabilities.",
    serverName,
    forbidden
  );
}

export function assertMcpWriteRootsEmpty(serverName: string, writeRoots: readonly string[]): void {
  if (writeRoots.length === 0) return;
  throw new McpCapabilityPolicyError(
    "mcp_write_roots_forbidden",
    `MCP server '${serverName}' cannot be started with writable roots. Sigma MCP processes are always read-only.`,
    serverName,
    ["filesystem.write"]
  );
}
