import type { JsonValue, ToolEffect } from "agent-protocol";

export const MCP_LATEST_PROTOCOL_VERSION = "2025-11-25";
export const MCP_SUPPORTED_PROTOCOL_VERSIONS = [
  MCP_LATEST_PROTOCOL_VERSION,
  "2025-06-18",
  "2025-03-26",
  "2024-11-05"
] as const;

export interface McpImplementation {
  name: string;
  version: string;
  title?: string;
}

export interface McpTimeoutConfig {
  idleTimeoutMs: number;
  hardDeadlineMs: number;
  shutdownGraceMs: number;
}

export interface McpStdioServerConfig {
  name: string;
  command: string;
  args?: string[];
  cwd: string;
  env?: Record<string, string>;
  clientInfo?: McpImplementation;
  supportedProtocolVersions?: string[];
  timeouts?: Partial<McpTimeoutConfig>;
  maxMessageBytes?: number;
  maxStderrBytes?: number;
}

export interface McpServerInfo {
  protocolVersion: string;
  capabilities: Record<string, JsonValue>;
  serverInfo: McpImplementation;
  instructions?: string;
}

export interface McpToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface McpToolDefinition {
  name: string;
  title?: string;
  description?: string;
  inputSchema: { [key: string]: JsonValue };
  outputSchema?: { [key: string]: JsonValue };
  annotations?: McpToolAnnotations;
}

export interface McpContentBlock {
  type: string;
  [key: string]: JsonValue;
}

export interface McpCallToolResult {
  content: McpContentBlock[];
  structuredContent?: { [key: string]: JsonValue };
  isError?: boolean;
}

export interface McpRequestOptions {
  signal?: AbortSignal;
  idleTimeoutMs?: number;
  hardDeadlineMs?: number;
  onProgress?: (progress: McpProgress) => void | Promise<void>;
}

export interface McpProgress {
  progressToken: string | number;
  progress: number;
  total?: number;
  message?: string;
}

export interface McpNotification {
  method: string;
  params?: { [key: string]: JsonValue };
}

export interface McpClientHooks {
  onNotification?(notification: McpNotification): void | Promise<void>;
  onStderr?(text: string): void;
}

export interface McpToolPolicy {
  possibleEffects: ToolEffect[];
  executionMode: "parallel" | "sequential" | "exclusive";
  approval: "auto" | "prompt" | "deny";
  idempotent: boolean;
  timeoutMs: number;
}

export interface McpToolBridgeOptions {
  namespace: string;
  policy?: Partial<McpToolPolicy>;
}
