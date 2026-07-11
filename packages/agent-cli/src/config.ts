import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  configHelp,
  parseFlags,
  resolveConfig,
  type McpConfigSource,
  type McpServerConfigValue,
  type ModelRouteConfigValue,
  type ModelSpecConfigValue,
  type WorkspaceCustomizationTrustAttestation,
  type WorkspaceMcpTrustAttestation
} from "agent-config";
import { parse as parseToml } from "smol-toml";
import { resolveWorkspaceMcpTrust } from "./workspace-mcp-trust.js";
import { resolveWorkspaceCustomizationTrust } from "./workspace-customization-trust.js";

export interface ParsedArgs {
  flags: Record<string, unknown>;
  positionals: string[];
}

export interface CliConfig {
  workspace: string;
  provider: "deepseek" | "glm";
  model: string;
  agentProfile: string;
  permissionMode: "ask" | "auto" | "deny";
  sandboxMode: "required";
  networkMode: "none" | "full";
  allowUnsafeHostExec: boolean;
  unsafeHostExecRequested: boolean;
  reviewerWaiver: boolean;
  legacySingleModelRoute: boolean;
  modelSpecs: ModelSpecConfigValue[];
  modelRoutes: ModelRouteConfigValue[];
  runDeadlineSec: number;
  modelDeadlineSec: number;
  streamIdleSec: number;
  maxParallelTools: number;
  maxParallelAgents: number;
  budget: {
    maxInputTokens: number;
    maxOutputTokens: number;
    maxCostMicroUsd: number;
    maxModelTurns: number;
    maxToolCalls: number;
    maxChildren: number;
    maxDepth: number;
  };
  checkpoint: { maxFiles: number; maxBytes: number };
  outputFormat: "text" | "json" | "stream-json";
  outputSchema: 2 | 3;
  tuiFps: number;
  mcpServers: McpServerConfigValue[];
  mcpSource: McpConfigSource;
  workspaceMcpTrust?: WorkspaceMcpTrustAttestation;
  workspaceCustomizationTrust?: WorkspaceCustomizationTrustAttestation;
}

export interface CliConfigLoadOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  homeDir?: string;
  trustStorePath?: string;
  customizationTrustStorePath?: string;
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

export function workspaceCustomizationTrustMessage(config: CliConfig): string | undefined {
  if (!config.workspaceCustomizationTrust || config.workspaceCustomizationTrust.trusted) return undefined;
  return "Workspace executable hooks are not trusted. Review .agent/hooks plus workspace profiles and skills, then rerun with "
    + "--trust-workspace-customization. Trust is bound to the canonical workspace and one unified customization digest.";
}

interface ConfigInputs {
  env: NodeJS.ProcessEnv;
  workspace: string;
  homeDir: string;
  workspaceDocument?: TomlDocument;
  homeDocument?: TomlDocument;
}

function configInputs(flags: Record<string, unknown>, options: CliConfigLoadOptions): ConfigInputs {
  const env = options.env ?? process.env;
  const workspaceHint = typeof flags.workspace === "string"
    ? flags.workspace
    : env.SIGMA_WORKSPACE ?? options.cwd ?? process.cwd();
  const workspace = path.resolve(workspaceHint);
  const homeDir = options.homeDir ?? os.homedir();
  return {
    env,
    workspace,
    homeDir,
    workspaceDocument: readToml(path.join(workspace, ".agent", "config.toml")),
    homeDocument: readToml(path.join(homeDir, ".sigma", "config.toml"))
  };
}

function assertUnsafeHostConfiguration(flags: Record<string, unknown>, document: TomlDocument | undefined): void {
  const security = document?.values.security;
  const workspaceOptIn = security && typeof security === "object" && !Array.isArray(security)
    && (security as Record<string, unknown>).allow_unsafe_host_exec === true;
  if (workspaceOptIn) {
    throw new Error("security.allow_unsafe_host_exec is home-only and cannot be enabled by workspace configuration.");
  }
  if (Object.hasOwn(flags, "allow-unsafe-host-exec")) {
    throw new Error("--allow-unsafe-host-exec is not accepted; set security.allow_unsafe_host_exec in ~/.sigma/config.toml and use --unsafe-host-exec per run.");
  }
}

function mcpTrustAttestation(
  source: McpConfigSource,
  grant: boolean,
  input: ConfigInputs,
  options: CliConfigLoadOptions
): WorkspaceMcpTrustAttestation | undefined {
  if (grant && source !== "workspace") throw new Error("--trust-workspace-mcp requires MCP servers from .agent/config.toml.");
  if (source !== "workspace" || !input.workspaceDocument) return undefined;
  return resolveWorkspaceMcpTrust({
    workspacePath: input.workspace,
    configSource: input.workspaceDocument.source,
    trustStorePath: options.trustStorePath ?? path.join(input.homeDir, ".sigma", "workspace-mcp-trust.json"),
    grant
  });
}

function customizationTrustAttestation(
  grant: boolean,
  input: ConfigInputs,
  options: CliConfigLoadOptions
): WorkspaceCustomizationTrustAttestation | undefined {
  if (!existsSync(input.workspace)) {
    if (grant) throw new Error("--trust-workspace-customization requires an existing workspace.");
    return undefined;
  }
  const trust = resolveWorkspaceCustomizationTrust({
    workspacePath: input.workspace,
    trustStorePath: options.customizationTrustStorePath
      ?? path.join(input.homeDir, ".sigma", "workspace-customization-trust.json"),
    grant
  });
  if (!trust.hasWorkspaceHooks) return undefined;
  return {
    required: true,
    trusted: trust.trusted,
    canonicalWorkspacePath: trust.canonicalWorkspacePath,
    customizationDigest: trust.customizationDigest
  };
}

function unsafeHostSettings(values: ReturnType<typeof resolveConfig>): {
  allowUnsafeHostExec: boolean;
  unsafeHostExecRequested: boolean;
} {
  const allowUnsafeHostExec = values.allowUnsafeHostExec === true;
  const unsafeHostExecRequested = values.unsafeHostExec === true;
  if (unsafeHostExecRequested && !allowUnsafeHostExec) {
    throw new Error("--unsafe-host-exec requires security.allow_unsafe_host_exec=true in ~/.sigma/config.toml.");
  }
  return { allowUnsafeHostExec, unsafeHostExecRequested };
}

function cliConfig(
  values: ReturnType<typeof resolveConfig>,
  input: ConfigInputs,
  legacySingleModelRoute: boolean,
  mcpServers: McpServerConfigValue[],
  source: McpConfigSource,
  trust: WorkspaceMcpTrustAttestation | undefined,
  customizationTrust: WorkspaceCustomizationTrustAttestation | undefined
): CliConfig {
  const unsafe = unsafeHostSettings(values);
  return {
    workspace: path.resolve(input.workspace, String(values.workspace)),
    provider: values.provider as CliConfig["provider"],
    model: String(values.model),
    agentProfile: String(values.agentProfile),
    permissionMode: values.permissionMode as CliConfig["permissionMode"],
    sandboxMode: values.sandboxMode as CliConfig["sandboxMode"],
    networkMode: values.networkMode as CliConfig["networkMode"],
    ...unsafe,
    reviewerWaiver: values.reviewerWaiver === true,
    legacySingleModelRoute,
    modelSpecs: values.modelSpecs as ModelSpecConfigValue[],
    modelRoutes: values.modelRoutes as ModelRouteConfigValue[],
    runDeadlineSec: Number(values.runDeadlineSec),
    modelDeadlineSec: Number(values.modelDeadlineSec),
    streamIdleSec: Number(values.streamIdleSec),
    maxParallelTools: Number(values.maxParallelTools),
    maxParallelAgents: Number(values.maxParallelAgents),
    budget: {
      maxInputTokens: Number(values.maxInputTokens), maxOutputTokens: Number(values.maxOutputTokens),
      maxCostMicroUsd: Number(values.maxCostMicroUsd), maxModelTurns: Number(values.maxModelTurns),
      maxToolCalls: Number(values.maxToolCalls), maxChildren: Number(values.maxChildren), maxDepth: Number(values.maxDepth)
    },
    checkpoint: { maxFiles: Number(values.checkpointMaxFiles), maxBytes: Number(values.checkpointMaxBytes) },
    outputFormat: values.outputFormat as CliConfig["outputFormat"],
    outputSchema: Number(values.outputSchema) as 2 | 3,
    tuiFps: Number(values.tuiFps),
    mcpServers,
    mcpSource: source,
    ...(trust ? { workspaceMcpTrust: trust } : {}),
    ...(customizationTrust ? { workspaceCustomizationTrust: customizationTrust } : {})
  };
}

export function loadCliConfig(flags: Record<string, unknown>, options: CliConfigLoadOptions = {}): CliConfig {
  const input = configInputs(flags, options);
  assertUnsafeHostConfiguration(flags, input.workspaceDocument);
  const values = resolveConfig({
    flags,
    env: input.env,
    workspace: input.workspaceDocument?.values,
    home: input.homeDocument?.values
  });
  const mcpServers = values.mcpServers as McpServerConfigValue[];
  const source = mcpSource(flags, input.env, input.workspaceDocument, input.homeDocument, mcpServers);
  const grant = values.trustWorkspaceMcp === true;
  const trust = mcpTrustAttestation(source, grant, input, options);
  const customizationTrust = customizationTrustAttestation(
    values.trustWorkspaceCustomization === true, input, options
  );
  const legacySingleModelRoute = Object.hasOwn(flags, "provider") || Object.hasOwn(flags, "model");
  return cliConfig(values, input, legacySingleModelRoute, mcpServers, source, trust, customizationTrust);
}

export function cliConfigHelp(): string {
  return configHelp().join("\n");
}
