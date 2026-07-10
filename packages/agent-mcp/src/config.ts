import {
  MCP_SUPPORTED_PROTOCOL_VERSIONS,
  type McpStdioServerConfig,
  type McpTimeoutConfig
} from "./types.js";

const DEFAULT_TIMEOUTS: McpTimeoutConfig = {
  idleTimeoutMs: 30_000,
  hardDeadlineMs: 120_000,
  shutdownGraceMs: 750
};

export interface ResolvedMcpClientSettings {
  timeouts: McpTimeoutConfig;
  supportedVersions: string[];
  maxMessageBytes: number;
  maxStderrBytes: number;
}

export function resolveMcpClientSettings(config: McpStdioServerConfig): ResolvedMcpClientSettings {
  const timeouts = { ...DEFAULT_TIMEOUTS, ...config.timeouts };
  const supportedVersions = [...(config.supportedProtocolVersions ?? MCP_SUPPORTED_PROTOCOL_VERSIONS)];
  if (supportedVersions.length === 0) throw new Error("At least one MCP protocol version must be supported.");
  if (!config.name.trim()) throw new Error("MCP server name is required.");
  if (!config.command.trim()) throw new Error("MCP server command is required.");
  for (const [key, value] of Object.entries(timeouts)) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`MCP ${key} must be positive.`);
  }
  const maxMessageBytes = config.maxMessageBytes ?? 8 * 1024 * 1024;
  const maxStderrBytes = config.maxStderrBytes ?? 256 * 1024;
  if (!Number.isFinite(maxMessageBytes) || maxMessageBytes <= 0) throw new Error("MCP maxMessageBytes must be positive.");
  if (!Number.isFinite(maxStderrBytes) || maxStderrBytes <= 0) throw new Error("MCP maxStderrBytes must be positive.");
  return { timeouts, supportedVersions, maxMessageBytes, maxStderrBytes };
}
