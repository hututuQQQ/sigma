import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  configHelp,
  parseFlags,
  resolveConfig,
  type McpConfigSource,
  type McpServerConfigValue,
  type WorkspaceMcpTrustAttestation
} from "agent-config";
import { parse as parseToml } from "smol-toml";
import { resolveWorkspaceMcpTrust } from "./workspace-mcp-trust.js";

export interface ParsedArgs {
  flags: Record<string, unknown>;
  positionals: string[];
}

export interface CliConfig {
  workspace: string;
  provider: "deepseek" | "glm";
  model: string;
  permissionMode: "ask" | "auto" | "deny";
  runDeadlineSec: number;
  modelDeadlineSec: number;
  streamIdleSec: number;
  maxParallelTools: number;
  maxParallelAgents: number;
  outputFormat: "text" | "json" | "stream-json";
  tuiFps: number;
  mcpServers: McpServerConfigValue[];
  mcpSource: McpConfigSource;
  workspaceMcpTrust?: WorkspaceMcpTrustAttestation;
}

export interface CliConfigLoadOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  homeDir?: string;
  trustStorePath?: string;
}

interface TomlDocument {
  source: string;
  values: Record<string, unknown>;
}

function readToml(filePath: string): TomlDocument | undefined {
  if (!existsSync(filePath)) return undefined;
  const source = readFileSync(filePath, "utf8");
  const parsed = parseToml(source);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`Configuration must be a TOML table: ${filePath}`);
  return { source, values: parsed as Record<string, unknown> };
}

export function parseArgs(argv: string[]): ParsedArgs {
  const parsed = parseFlags(argv);
  return { flags: parsed.flags, positionals: parsed.positionals };
}

function workspaceDefinesMcp(document: TomlDocument | undefined): boolean {
  const mcp = document?.values.mcp;
  return Boolean(mcp && typeof mcp === "object" && !Array.isArray(mcp)
    && Object.hasOwn(mcp as Record<string, unknown>, "servers"));
}

function mcpSource(
  flags: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  workspaceDocument: TomlDocument | undefined,
  homeDocument: TomlDocument | undefined,
  servers: readonly McpServerConfigValue[]
): McpConfigSource {
  if (servers.length === 0) return "none";
  if (Object.hasOwn(flags, "mcp-server")) return "flags";
  if (env.SIGMA_MCP_SERVERS !== undefined) return "environment";
  if (workspaceDefinesMcp(workspaceDocument)) return "workspace";
  if (workspaceDefinesMcp(homeDocument)) return "home";
  return "none";
}

export function workspaceMcpTrustMessage(config: CliConfig): string | undefined {
  if (config.mcpSource !== "workspace" || config.workspaceMcpTrust?.trusted) return undefined;
  return "Workspace MCP configuration is not trusted. Review .agent/config.toml, then rerun with "
    + "--trust-workspace-mcp. Trust is bound to this canonical workspace and the current configuration digest.";
}

export function loadCliConfig(flags: Record<string, unknown>, options: CliConfigLoadOptions = {}): CliConfig {
  const env = options.env ?? process.env;
  const workspaceHint = typeof flags.workspace === "string"
    ? flags.workspace
    : env.SIGMA_WORKSPACE ?? options.cwd ?? process.cwd();
  const workspace = path.resolve(workspaceHint);
  const homeDir = options.homeDir ?? os.homedir();
  const workspaceDocument = readToml(path.join(workspace, ".agent", "config.toml"));
  const homeDocument = readToml(path.join(homeDir, ".sigma", "config.toml"));
  const values = resolveConfig({
    flags,
    env,
    workspace: workspaceDocument?.values,
    home: homeDocument?.values
  });
  const mcpServers = values.mcpServers as McpServerConfigValue[];
  const source = mcpSource(flags, env, workspaceDocument, homeDocument, mcpServers);
  const grant = values.trustWorkspaceMcp === true;
  if (grant && source !== "workspace") throw new Error("--trust-workspace-mcp requires MCP servers from .agent/config.toml.");
  const workspaceMcpTrust = source === "workspace" && workspaceDocument
    ? resolveWorkspaceMcpTrust({
      workspacePath: workspace,
      configSource: workspaceDocument.source,
      trustStorePath: options.trustStorePath ?? path.join(homeDir, ".sigma", "workspace-mcp-trust.json"),
      grant
    })
    : undefined;
  return {
    workspace: path.resolve(String(values.workspace)),
    provider: values.provider as CliConfig["provider"],
    model: String(values.model),
    permissionMode: values.permissionMode as CliConfig["permissionMode"],
    runDeadlineSec: Number(values.runDeadlineSec),
    modelDeadlineSec: Number(values.modelDeadlineSec),
    streamIdleSec: Number(values.streamIdleSec),
    maxParallelTools: Number(values.maxParallelTools),
    maxParallelAgents: Number(values.maxParallelAgents),
    outputFormat: values.outputFormat as CliConfig["outputFormat"],
    tuiFps: Number(values.tuiFps),
    mcpServers,
    mcpSource: source,
    ...(workspaceMcpTrust ? { workspaceMcpTrust } : {})
  };
}

export function cliConfigHelp(): string {
  return configHelp().join("\n");
}
