import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { CONFIG_SCHEMA_VERSION, renderConfigToml, type ConfigValue } from "agent-config";
import { parse as parseToml } from "smol-toml";
import { loadCliConfig, parseArgs, type CliConfig } from "../config.js";

interface ConfigCommandDeps {
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  homeDir?: string;
}

interface ConfigMigrationResult {
  configPath: string;
  currentVersion: 2 | 3;
  migrationRequired: boolean;
  written: boolean;
  json: boolean;
}

function overrides(config: CliConfig): Partial<Record<string, ConfigValue>> {
  return {
    configSchemaVersion: CONFIG_SCHEMA_VERSION,
    provider: config.provider,
    model: config.model,
    agentProfile: config.agentProfile,
    workspace: ".",
    permissionMode: config.permissionMode,
    sandboxMode: config.sandboxMode,
    networkMode: config.networkMode,
    runDeadlineSec: config.runDeadlineSec,
    modelDeadlineSec: config.modelDeadlineSec,
    streamIdleSec: config.streamIdleSec,
    streamActiveSec: config.streamActiveSec,
    maxModelRetries: config.maxModelRetries,
    maxParallelTools: config.maxParallelTools,
    maxParallelAgents: config.maxParallelAgents,
    maxInputTokens: config.budget.maxInputTokens,
    maxOutputTokens: config.budget.maxOutputTokens,
    maxCostMicroUsd: config.budget.maxCostMicroUsd,
    maxModelTurns: config.budget.maxModelTurns,
    maxToolCalls: config.budget.maxToolCalls,
    maxChildren: config.budget.maxChildren,
    maxDepth: config.budget.maxDepth,
    checkpointMaxFiles: config.checkpoint.maxFiles,
    checkpointMaxBytes: config.checkpoint.maxBytes,
    outputFormat: config.outputFormat,
    outputSchema: config.outputSchema,
    streamJsonMaxLineBytes: config.streamJsonMaxLineBytes,
    tuiFps: config.tuiFps,
    mcpServers: config.mcpServers
  };
}

export async function runConfigCommand(argv: string[], deps: ConfigCommandDeps = {}): Promise<number> {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  if (argv.includes("--help") || argv.includes("-h")) {
    stdout.write("agent config migrate [--workspace <path>] [--check|--write] [--json]\n");
    return 0;
  }
  try {
    const result = await migrateConfig(argv, deps);
    writeMigrationResult(stdout, result);
    return result.migrationRequired && !result.written ? 2 : 0;
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

async function migrateConfig(argv: string[], deps: ConfigCommandDeps): Promise<ConfigMigrationResult> {
  const { flags, positionals } = parseArgs(argv);
  assertMigrationArguments(positionals, flags);
  const config = loadCliConfig(flags, { env: deps.env, cwd: deps.cwd, homeDir: deps.homeDir });
  const configPath = path.join(config.workspace, ".agent", "config.toml");
  const source = await readFile(configPath, "utf8");
  const currentVersion = configVersion(parseToml(source) as Record<string, unknown>);
  const migrationRequired = currentVersion !== CONFIG_SCHEMA_VERSION;
  const written = flags.write === true && migrationRequired;
  if (written) await writeMigratedConfig(configPath, source, config);
  return { configPath, currentVersion, migrationRequired, written, json: flags.json === true };
}

function assertMigrationArguments(positionals: string[], flags: Record<string, unknown>): void {
  if (positionals[0] !== "migrate" || positionals.length !== 1) {
    throw new Error("Usage: agent config migrate [--check|--write]");
  }
  if (flags.check === true && flags.write === true) throw new Error("Choose either --check or --write, not both.");
}

function configVersion(document: Record<string, unknown>): 2 | 3 {
  const current = document.schema_version;
  if (current === undefined || current === 2) return 2;
  if (current === 3) return 3;
  throw new Error(`Unsupported config schema_version '${String(current)}'.`);
}

async function writeMigratedConfig(configPath: string, source: string, config: CliConfig): Promise<void> {
  const backupPath = `${configPath}.v2.bak`;
  try { await writeFile(backupPath, source, { flag: "wx" }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`Migration backup already exists: ${backupPath}`, { cause: error });
    }
    throw error;
  }
  const temporary = `${configPath}.${randomUUID()}.tmp`;
  await writeFile(temporary, renderConfigToml(overrides(config), "Sigma Code 3.0 migrated workspace configuration"), { flag: "wx" });
  await rename(temporary, configPath);
}

function writeMigrationResult(stdout: NodeJS.WritableStream, result: ConfigMigrationResult): void {
  if (result.json) {
    stdout.write(`${JSON.stringify({
      ok: true,
      configPath: result.configPath,
      currentVersion: result.currentVersion,
      targetVersion: CONFIG_SCHEMA_VERSION,
      migrationRequired: result.migrationRequired,
      written: result.written
    })}\n`);
    return;
  }
  if (!result.migrationRequired) stdout.write(`${result.configPath} already uses schema v3\n`);
  else if (result.written) stdout.write(`migrated ${result.configPath}\n`);
  else stdout.write(`${result.configPath} requires migration from v${result.currentVersion} to v3\n`);
}
