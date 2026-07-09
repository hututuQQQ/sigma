import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { configHelp, parseFlags, resolveConfig, type McpServerConfigValue } from "agent-config";
import { parse as parseToml } from "smol-toml";

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
}

function readToml(filePath: string): Record<string, unknown> | undefined {
  if (!existsSync(filePath)) return undefined;
  const parsed = parseToml(readFileSync(filePath, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`Configuration must be a TOML table: ${filePath}`);
  return parsed as Record<string, unknown>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const parsed = parseFlags(argv);
  return { flags: parsed.flags, positionals: parsed.positionals };
}

export function loadCliConfig(flags: Record<string, unknown>): CliConfig {
  const workspaceHint = typeof flags.workspace === "string"
    ? flags.workspace
    : process.env.SIGMA_WORKSPACE ?? process.cwd();
  const workspace = path.resolve(workspaceHint);
  const values = resolveConfig({
    flags,
    env: process.env,
    workspace: readToml(path.join(workspace, ".agent", "config.toml")),
    home: readToml(path.join(os.homedir(), ".sigma", "config.toml"))
  });
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
    mcpServers: values.mcpServers as McpServerConfigValue[]
  };
}

export function cliConfigHelp(): string {
  return configHelp().join("\n");
}
