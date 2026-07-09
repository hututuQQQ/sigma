import type { JsonValue } from "agent-protocol";
import { McpProtocolError } from "./errors.js";
import type { McpContentBlock, McpServerInfo, McpToolDefinition } from "./types.js";

export function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new McpProtocolError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

export function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new McpProtocolError(`${label} must be a non-empty string.`);
  }
  return value;
}

export function jsonObject(value: unknown, label: string): { [key: string]: JsonValue } {
  const input = objectValue(value, label);
  try {
    return JSON.parse(JSON.stringify(input)) as { [key: string]: JsonValue };
  } catch {
    throw new McpProtocolError(`${label} is not JSON serializable.`);
  }
}

export function initializeResult(value: unknown, supportedVersions: readonly string[]): McpServerInfo {
  const result = objectValue(value, "initialize result");
  const protocolVersion = stringValue(result.protocolVersion, "initialize protocolVersion");
  if (!supportedVersions.includes(protocolVersion)) {
    throw new McpProtocolError(`MCP server selected unsupported protocol version '${protocolVersion}'.`);
  }
  const implementation = objectValue(result.serverInfo, "initialize serverInfo");
  return {
    protocolVersion,
    capabilities: jsonObject(result.capabilities, "initialize capabilities"),
    serverInfo: {
      name: stringValue(implementation.name, "serverInfo.name"),
      version: stringValue(implementation.version, "serverInfo.version"),
      ...(typeof implementation.title === "string" ? { title: implementation.title } : {})
    },
    ...(typeof result.instructions === "string" ? { instructions: result.instructions } : {})
  };
}

export function contentBlock(value: unknown, label: string): McpContentBlock {
  const block = jsonObject(value, label);
  if (typeof block.type !== "string" || block.type.length === 0) {
    throw new McpProtocolError(`${label}.type must be a non-empty string.`);
  }
  return block as McpContentBlock;
}

export function toolDefinition(value: unknown): McpToolDefinition {
  const tool = objectValue(value, "tool definition");
  const annotations = tool.annotations === undefined ? undefined : objectValue(tool.annotations, "tool annotations");
  return {
    name: stringValue(tool.name, "tool name"),
    inputSchema: jsonObject(tool.inputSchema, "tool inputSchema"),
    ...(typeof tool.title === "string" ? { title: tool.title } : {}),
    ...(typeof tool.description === "string" ? { description: tool.description } : {}),
    ...(tool.outputSchema ? { outputSchema: jsonObject(tool.outputSchema, "tool outputSchema") } : {}),
    ...(annotations ? { annotations: {
      ...(typeof annotations.title === "string" ? { title: annotations.title } : {}),
      ...(typeof annotations.readOnlyHint === "boolean" ? { readOnlyHint: annotations.readOnlyHint } : {}),
      ...(typeof annotations.destructiveHint === "boolean" ? { destructiveHint: annotations.destructiveHint } : {}),
      ...(typeof annotations.idempotentHint === "boolean" ? { idempotentHint: annotations.idempotentHint } : {}),
      ...(typeof annotations.openWorldHint === "boolean" ? { openWorldHint: annotations.openWorldHint } : {})
    } } : {})
  };
}
