import {
  modelRoutesValue, modelSpecsValue, type ModelRouteConfigValue, type ModelSpecConfigValue
} from "./model-catalog.js";
import { assertMcpPersistentEffectsAllowed } from "agent-protocol";
export type ConfigScalar = string | number | boolean;
export type ConfigToolEffect =
  | "filesystem.read" | "filesystem.read.external" | "filesystem.write"
  | "process.spawn" | "process.spawn.readonly" | "process.handoff"
  | "agent.spawn" | "network" | "validation" | "destructive" | "open_world";
export interface McpServerConfigValue {
  name: string;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  possibleEffects: ConfigToolEffect[];
  approval: "auto" | "prompt" | "deny";
  executionMode: "parallel" | "sequential" | "exclusive";
  idempotent: boolean;
  timeoutMs: number;
  idleTimeoutMs: number;
  hardDeadlineMs: number;
  shutdownGraceMs: number;
}
export interface WorkspaceMcpTrustAttestation {
  required: true;
  trusted: boolean;
  canonicalWorkspacePath: string;
  configDigest: string;
}
export interface WorkspaceCustomizationTrustAttestation {
  required: true;
  trusted: boolean;
  canonicalWorkspacePath: string;
  customizationDigest: string;
}
export type McpConfigSource = "none" | "flags" | "environment" | "home" | "workspace";
export type ConfigValue = ConfigScalar | string[] | McpServerConfigValue[]
  | ModelSpecConfigValue[] | ModelRouteConfigValue[];
export interface ConfigField<T extends ConfigValue = ConfigValue> {
  key: string;
  flag: string;
  shortFlag?: string;
  kind?: "value" | "boolean" | "repeatable";
  env?: string;
  toml?: string;
  description: string;
  defaultValue: T;
  parse(raw: unknown): T;
  secret?: boolean;
  hidden?: boolean;
}
export interface ConfigSources {
  flags?: Record<string, unknown>;
  env?: Record<string, string | undefined>;
  workspace?: Record<string, unknown>;
  home?: Record<string, unknown>;
}
export type ResolvedConfig = Record<string, ConfigValue>;
export const CONFIG_SCHEMA_VERSION = 5 as const;
function stringValue(raw: unknown, key: string, allowEmpty = false): string {
  if (typeof raw !== "string" || (!allowEmpty && !raw.trim())) throw new Error(`Configuration '${key}' requires a${allowEmpty ? "" : " non-empty"} string.`);
  return raw;
}
function numberValue(raw: unknown, key: string, minimum = 0, maximum = Number.POSITIVE_INFINITY): number {
  const value = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN;
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`Configuration '${key}' requires a number from ${minimum} to ${maximum}.`);
  }
  return value;
}
function booleanValue(raw: unknown, key: string): boolean {
  if (typeof raw === "boolean") return raw;
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  throw new Error(`Configuration '${key}' requires true or false.`);
}
function enumValue<T extends string>(raw: unknown, key: string, values: readonly T[]): T {
  if (typeof raw === "string" && values.includes(raw as T)) return raw as T;
  throw new Error(`Configuration '${key}' must be one of: ${values.join(", ")}.`);
}
const EFFECTS: readonly ConfigToolEffect[] = [
  "filesystem.read", "filesystem.read.external", "filesystem.write",
  "process.spawn", "process.spawn.readonly", "process.handoff", "agent.spawn",
  "network", "validation", "destructive", "open_world"
];
const MCP_SERVER_KEYS = new Set([
  "name", "command", "args", "cwd", "env", "possible_effects", "approval", "execution_mode", "idempotent",
  "timeout_ms", "idle_timeout_ms", "hard_deadline_ms", "shutdown_grace_ms"
]);
function objectValue(raw: unknown, key: string): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`Configuration '${key}' requires an object.`);
  return raw as Record<string, unknown>;
}

function stringArray(raw: unknown, key: string): string[] {
  if (!Array.isArray(raw) || raw.some((value) => typeof value !== "string")) throw new Error(`Configuration '${key}' requires a string array.`);
  return [...raw];
}

function mcpServersValue(raw: unknown): McpServerConfigValue[] {
  let source = raw;
  if (typeof source === "string") source = JSON.parse(source) as unknown;
  if (Array.isArray(source) && source.every((item) => typeof item === "string")) {
    source = source.map((item) => JSON.parse(item as string) as unknown);
  }
  if (!Array.isArray(source)) throw new Error("Configuration 'mcpServers' requires an array of server objects.");
  const names = new Set<string>();
  return source.map((rawServer, index) => {
    const server = objectValue(rawServer, `mcpServers[${index}]`);
    const unknown = Object.keys(server).find((key) => !MCP_SERVER_KEYS.has(key));
    if (unknown) throw new Error(`Unknown MCP server configuration key 'mcpServers[${index}].${unknown}'.`);
    const name = stringValue(server.name, `mcpServers[${index}].name`);
    if (names.has(name)) throw new Error(`Duplicate MCP server name '${name}'.`);
    names.add(name);
    const rawEnv = server.env === undefined ? {} : objectValue(server.env, `mcpServers[${index}].env`);
    const env = Object.fromEntries(Object.entries(rawEnv).map(([key, value]) => [key, stringValue(value, `mcpServers[${index}].env.${key}`, true)]));
    if (server.possible_effects === undefined) {
      assertMcpPersistentEffectsAllowed(name, undefined);
    }
    const possibleEffects = stringArray(
      server.possible_effects,
      `mcpServers[${index}].possible_effects`
    ).map((effect) => enumValue(effect, "MCP effect", EFFECTS));
    assertMcpPersistentEffectsAllowed(name, possibleEffects);
    return {
      name,
      command: stringValue(server.command, `mcpServers[${index}].command`),
      args: server.args === undefined ? [] : stringArray(server.args, `mcpServers[${index}].args`),
      cwd: server.cwd === undefined ? "." : stringValue(server.cwd, `mcpServers[${index}].cwd`),
      env,
      possibleEffects,
      approval: server.approval === undefined ? "prompt" : enumValue(server.approval, "MCP approval", ["auto", "prompt", "deny"] as const),
      executionMode: server.execution_mode === undefined ? "sequential" : enumValue(server.execution_mode, "MCP execution mode", ["parallel", "sequential", "exclusive"] as const),
      idempotent: server.idempotent === undefined ? false : booleanValue(server.idempotent, "MCP idempotent"),
      timeoutMs: server.timeout_ms === undefined ? 120_000 : numberValue(server.timeout_ms, "MCP timeout", 1),
      idleTimeoutMs: server.idle_timeout_ms === undefined ? 30_000 : numberValue(server.idle_timeout_ms, "MCP idle timeout", 1),
      hardDeadlineMs: server.hard_deadline_ms === undefined ? 120_000 : numberValue(server.hard_deadline_ms, "MCP hard deadline", 1),
      shutdownGraceMs: server.shutdown_grace_ms === undefined ? 750 : numberValue(server.shutdown_grace_ms, "MCP shutdown grace", 1)
    };
  });
}

const booleanField = (key: string, flag: string, description: string, shortFlag?: string): ConfigField<boolean> => ({
  key, flag, shortFlag, kind: "boolean", description, defaultValue: false, parse: (raw) => booleanValue(raw, key), hidden: true
});

export const SIGMA_CONFIG_SCHEMA: readonly ConfigField[] = [
  { key: "configSchemaVersion", flag: "config-schema-version", toml: "schema_version", description: "Configuration schema version", defaultValue: CONFIG_SCHEMA_VERSION, parse: (raw) => {
    const value = numberValue(raw, "configSchemaVersion", 2, CONFIG_SCHEMA_VERSION);
    if (!Number.isInteger(value)) throw new Error("Configuration 'configSchemaVersion' requires an integer.");
    return value;
  }, hidden: true },
  { key: "provider", flag: "provider", env: "SIGMA_PROVIDER", toml: "model.provider", description: "Model provider", defaultValue: "deepseek", parse: (raw) => enumValue(raw, "provider", ["deepseek", "glm"] as const) },
  { key: "model", flag: "model", env: "SIGMA_MODEL", toml: "model.name", description: "Model name (auto selects provider default)", defaultValue: "auto", parse: (raw) => stringValue(raw, "model") },
  {
    key: "modelSpecs", flag: "model-spec", kind: "repeatable", env: "SIGMA_MODEL_SPECS", toml: "model.specs",
    description: "Model catalog spec JSON (repeatable)", defaultValue: [], parse: modelSpecsValue, hidden: true
  },
  {
    key: "modelRoutes", flag: "model-route", kind: "repeatable", env: "SIGMA_MODEL_ROUTES", toml: "model.routes",
    description: "Model route JSON (repeatable)", defaultValue: [], parse: modelRoutesValue, hidden: true
  },
  { key: "agentProfile", flag: "agent-profile", env: "SIGMA_AGENT_PROFILE", toml: "agent.profile", description: "Resolved Agent Profile identifier", defaultValue: "standard", parse: (raw) => stringValue(raw, "agentProfile") },
  { key: "workspace", flag: "workspace", env: "SIGMA_WORKSPACE", toml: "workspace.path", description: "Workspace path", defaultValue: ".", parse: (raw) => stringValue(raw, "workspace") },
  { key: "permissionMode", flag: "permission-mode", env: "SIGMA_PERMISSION_MODE", toml: "permissions.mode", description: "Tool permission mode (workspace-auto automatically permits workspace-scoped offline operations)", defaultValue: "workspace-auto", parse: (raw) => enumValue(raw, "permissionMode", ["workspace-auto", "ask", "auto", "deny"] as const) },
  { key: "sandboxMode", flag: "sandbox", env: "SIGMA_SANDBOX", toml: "security.sandbox", description: "Process sandbox policy", defaultValue: "required", parse: (raw) => enumValue(raw, "sandboxMode", ["required"] as const) },
  { key: "executionMode", flag: "execution-mode", description: "Execution backend for this run", defaultValue: "sandboxed", parse: (raw) => enumValue(raw, "executionMode", ["sandboxed", "container"] as const) },
  { key: "readScope", flag: "read-scope", env: "SIGMA_READ_SCOPE", toml: "security.read_scope", description: "Filesystem read scope", defaultValue: "workspace", parse: (raw) => enumValue(raw, "readScope", ["workspace", "host"] as const) },
  { key: "networkMode", flag: "network", env: "SIGMA_NETWORK", toml: "security.network", description: "Default process network policy", defaultValue: "none", parse: (raw) => enumValue(raw, "networkMode", ["none", "loopback", "full"] as const) },
  { key: "processHandoff", flag: "process-handoff", env: "SIGMA_PROCESS_HANDOFF", toml: "security.process_handoff", description: "Persistent process handoff policy", defaultValue: "allow", parse: (raw) => enumValue(raw, "processHandoff", ["allow", "deny"] as const) },
  { key: "runDeadlineSec", flag: "run-deadline-sec", env: "SIGMA_RUN_DEADLINE_SEC", toml: "runtime.run_deadline_sec", description: "Whole-run hard deadline in seconds", defaultValue: 900, parse: (raw) => numberValue(raw, "runDeadlineSec", 1) },
  { key: "modelDeadlineSec", flag: "model-deadline-sec", env: "SIGMA_MODEL_DEADLINE_SEC", toml: "runtime.model_deadline_sec", description: "Model first-byte and non-stream request deadline in seconds", defaultValue: 120, parse: (raw) => numberValue(raw, "modelDeadlineSec", 1) },
  { key: "streamIdleSec", flag: "stream-idle-sec", env: "SIGMA_STREAM_IDLE_SEC", toml: "runtime.stream_idle_sec", description: "Model stream idle timeout in seconds", defaultValue: 45, parse: (raw) => numberValue(raw, "streamIdleSec", 1) },
  { key: "streamActiveSec", flag: "stream-active-sec", env: "SIGMA_STREAM_ACTIVE_SEC", toml: "runtime.stream_active_sec", description: "Optional active model stream deadline in seconds (0 uses only the Agent/session deadline)", defaultValue: 0, parse: (raw) => numberValue(raw, "streamActiveSec", 0) },
  { key: "maxModelRetries", flag: "max-model-retries", env: "SIGMA_MAX_MODEL_RETRIES", toml: "runtime.max_model_retries", description: "Maximum model request retries", defaultValue: 2, parse: (raw) => numberValue(raw, "maxModelRetries", 0, 10) },
  { key: "maxParallelTools", flag: "max-parallel-tools", env: "SIGMA_MAX_PARALLEL_TOOLS", toml: "tools.max_parallel", description: "Maximum parallel tool calls", defaultValue: 4, parse: (raw) => numberValue(raw, "maxParallelTools", 1, 32) },
  { key: "maxParallelAgents", flag: "max-parallel-agents", env: "SIGMA_MAX_PARALLEL_AGENTS", toml: "agents.max_parallel", description: "Maximum parallel child agents", defaultValue: 4, parse: (raw) => numberValue(raw, "maxParallelAgents", 1, 32) },
  { key: "maxInputTokens", flag: "max-input-tokens", env: "SIGMA_MAX_INPUT_TOKENS", toml: "budget.max_input_tokens", description: "Session-tree input token budget", defaultValue: 8_000_000, parse: (raw) => numberValue(raw, "maxInputTokens", 1) },
  { key: "maxOutputTokens", flag: "max-output-tokens", env: "SIGMA_MAX_OUTPUT_TOKENS", toml: "budget.max_output_tokens", description: "Session-tree output token budget", defaultValue: 1_000_000, parse: (raw) => numberValue(raw, "maxOutputTokens", 1) },
  { key: "maxCostMicroUsd", flag: "max-cost-micro-usd", env: "SIGMA_MAX_COST_MICRO_USD", toml: "budget.max_cost_micro_usd", description: "Session-tree cost budget in micro-USD", defaultValue: 50_000_000, parse: (raw) => numberValue(raw, "maxCostMicroUsd", 1) },
  { key: "maxModelTurns", flag: "max-model-turns", env: "SIGMA_MAX_MODEL_TURNS", toml: "budget.max_model_turns", description: "Session-tree model turn budget", defaultValue: 256, parse: (raw) => numberValue(raw, "maxModelTurns", 1) },
  { key: "maxToolCalls", flag: "max-tool-calls", env: "SIGMA_MAX_TOOL_CALLS", toml: "budget.max_tool_calls", description: "Session-tree tool call budget", defaultValue: 2_048, parse: (raw) => numberValue(raw, "maxToolCalls", 1) },
  { key: "maxChildren", flag: "max-children", env: "SIGMA_MAX_CHILDREN", toml: "budget.max_children", description: "Session-tree child budget", defaultValue: 32, parse: (raw) => numberValue(raw, "maxChildren", 0) },
  { key: "maxDepth", flag: "max-agent-depth", env: "SIGMA_MAX_AGENT_DEPTH", toml: "budget.max_depth", description: "Maximum child-agent depth", defaultValue: 4, parse: (raw) => numberValue(raw, "maxDepth", 0) },
  { key: "checkpointMaxFiles", flag: "checkpoint-max-files", env: "SIGMA_CHECKPOINT_MAX_FILES", toml: "checkpoint.max_files", description: "Maximum files in a mutation checkpoint", defaultValue: 250_000, parse: (raw) => numberValue(raw, "checkpointMaxFiles", 1) },
  { key: "checkpointMaxBytes", flag: "checkpoint-max-bytes", env: "SIGMA_CHECKPOINT_MAX_BYTES", toml: "checkpoint.max_bytes", description: "Maximum checkpoint preimage bytes", defaultValue: 2_147_483_648, parse: (raw) => numberValue(raw, "checkpointMaxBytes", 1) },
  { key: "outputFormat", flag: "output-format", env: "SIGMA_OUTPUT_FORMAT", toml: "ui.output_format", description: "CLI output format", defaultValue: "text", parse: (raw) => enumValue(raw, "outputFormat", ["text", "json", "stream-json"] as const) },
  { key: "outputSchema", flag: "output-schema", env: "SIGMA_OUTPUT_SCHEMA", toml: "ui.output_schema", description: "JSON output schema version", defaultValue: 3, parse: (raw) => {
    const value = numberValue(raw, "outputSchema", 2, 3);
    if (value !== 2 && value !== 3) throw new Error("Configuration 'outputSchema' must be 2 or 3.");
    return value;
  } },
  { key: "streamJsonMaxLineBytes", flag: "stream-json-max-line-bytes", env: "SIGMA_STREAM_JSON_MAX_LINE_BYTES", toml: "ui.stream_json_max_line_bytes", description: "Optional maximum JSONL record size before base64 chunk framing (0 disables framing)", defaultValue: 0, parse: (raw) => {
    const value = numberValue(raw, "streamJsonMaxLineBytes", 0);
    if (!Number.isInteger(value) || (value > 0 && value < 4_096))
      throw new Error("Configuration 'streamJsonMaxLineBytes' must be 0 or an integer of at least 4096.");
    return value;
  } },
  { key: "initialMode", flag: "initial-mode", description: "Initial TUI session mode", defaultValue: "change", parse: (raw) => enumValue(raw, "initialMode", ["analyze", "change"] as const) },
  { key: "tuiFps", flag: "tui-fps", env: "SIGMA_TUI_FPS", toml: "tui.fps", description: "Maximum TUI frames per second", defaultValue: 30, parse: (raw) => numberValue(raw, "tuiFps", 1, 30) },
  { key: "mcpServers", flag: "mcp-server", kind: "repeatable", env: "SIGMA_MCP_SERVERS", toml: "mcp.servers", description: "MCP stdio server JSON (repeatable)", defaultValue: [], parse: mcpServersValue },
  {
    key: "trustWorkspaceMcp", flag: "trust-workspace-mcp", kind: "boolean",
    description: "Trust this workspace's current MCP configuration", defaultValue: false,
    parse: (raw) => booleanValue(raw, "trustWorkspaceMcp")
  },
  {
    key: "trustWorkspaceCustomization", flag: "trust-workspace-customization", kind: "boolean",
    description: "Trust this workspace's current profiles, hooks, and skills", defaultValue: false,
    parse: (raw) => booleanValue(raw, "trustWorkspaceCustomization")
  },
  booleanField("help", "help", "Show command help", "h"),
  booleanField("stdin", "stdin", "Read instruction from stdin"),
  { key: "prompt", flag: "prompt", description: "Inline instruction", defaultValue: "", parse: (raw) => stringValue(raw, "prompt", true), hidden: true },
  { key: "promptFile", flag: "prompt-file", description: "Read instruction from a file", defaultValue: "", parse: (raw) => stringValue(raw, "promptFile", true), hidden: true },
  booleanField("json", "json", "Emit JSON"),
  booleanField("checkApi", "check-api", "Check provider API connectivity"),
  booleanField("strict", "strict", "Treat warnings as errors"),
  booleanField("force", "force", "Overwrite an existing file"),
  booleanField("latest", "latest", "Select the latest session"),
  booleanField("timeline", "timeline", "Include event timeline"),
  booleanField("reviewerWaiver", "waive-reviewer", "Request a one-time human reviewer waiver"),
  booleanField("dryRun", "dry-run", "Validate without writing"),
  { ...booleanField("restore", "restore", "Safely restore an interrupted checkpoint"), hidden: true },
  { ...booleanField("keep", "keep", "Keep an interrupted checkpoint delta"), hidden: true },
  booleanField("check", "check", "Check whether migration is required"),
  booleanField("write", "write", "Write a migration result"),
  booleanField("all", "all", "Select all records"),
  { key: "initProfile", flag: "init-profile", description: "Initialization profile", defaultValue: "local", parse: (raw) => enumValue(raw, "initProfile", ["local", "team", "ci"] as const), hidden: true },
  { key: "limit", flag: "limit", description: "Result count limit", defaultValue: 20, parse: (raw) => numberValue(raw, "limit", 1, 1_000), hidden: true },
  { key: "sessionId", flag: "session", description: "Session identifier", defaultValue: "", parse: (raw) => stringValue(raw, "sessionId", true), hidden: true },
  { key: "decision", flag: "decision", description: "Approval decision", defaultValue: "allow", parse: (raw) => enumValue(raw, "decision", ["allow", "deny", "always_allow"] as const), hidden: true },
  { key: "reason", flag: "reason", description: "Cancellation reason", defaultValue: "", parse: (raw) => stringValue(raw, "reason", true), hidden: true }
];

function nestedValue(source: Record<string, unknown> | undefined, dottedKey: string | undefined): unknown {
  if (!dottedKey) return undefined;
  let current: unknown = source;
  for (const part of dottedKey.split(".")) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function validateTomlKeys(source: Record<string, unknown> | undefined, schema: readonly ConfigField[], label: string): void {
  if (!source) return;
  const known = new Set(schema.flatMap((field) => field.toml ? [field.toml, ...field.toml.split(".").slice(0, -1).map((_, index, parts) => parts.slice(0, index + 1).join("."))] : []));
  const visit = (value: Record<string, unknown>, prefix = ""): void => {
    for (const [key, child] of Object.entries(value)) {
      const dotted = prefix ? `${prefix}.${key}` : key;
      if (!known.has(dotted)) throw new Error(`Unknown ${label} configuration key '${dotted}'.`);
      if (child && typeof child === "object" && !Array.isArray(child)) visit(child as Record<string, unknown>, dotted);
    }
  };
  visit(source);
}

const WORKSPACE_NUMERIC_CAPS = new Set([
  "runDeadlineSec", "modelDeadlineSec", "streamIdleSec", "streamActiveSec", "maxModelRetries", "maxParallelTools", "maxParallelAgents",
  "maxInputTokens", "maxOutputTokens", "maxCostMicroUsd", "maxModelTurns", "maxToolCalls",
  "maxChildren", "maxDepth", "checkpointMaxFiles", "checkpointMaxBytes"
]);
const ZERO_MEANS_UNBOUNDED_CAPS = new Set(["streamActiveSec"]);

const PERMISSION_STRICTNESS: Readonly<Record<string, number>> = {
  deny: 0, ask: 1, "workspace-auto": 2, auto: 3
};
const NETWORK_STRICTNESS: Readonly<Record<string, number>> = { none: 0, loopback: 1, full: 2 };
const READ_SCOPE_STRICTNESS: Readonly<Record<string, number>> = { workspace: 0, host: 1 };
const HANDOFF_STRICTNESS: Readonly<Record<string, number>> = { deny: 0, allow: 1 };

function restrictWorkspaceValue(field: ConfigField, baseline: ConfigValue, workspaceRaw: unknown): ConfigValue {
  const workspaceValue = field.parse(workspaceRaw);
  if (WORKSPACE_NUMERIC_CAPS.has(field.key)) {
    const baselineNumber = Number(baseline), workspaceNumber = Number(workspaceValue);
    if (ZERO_MEANS_UNBOUNDED_CAPS.has(field.key)) {
      if (baselineNumber === 0) return workspaceNumber;
      if (workspaceNumber === 0) return baselineNumber;
    }
    return Math.min(baselineNumber, workspaceNumber);
  }
  if (field.key === "permissionMode") {
    return PERMISSION_STRICTNESS[String(workspaceValue)] < PERMISSION_STRICTNESS[String(baseline)]
      ? workspaceValue : baseline;
  }
  if (field.key === "networkMode") {
    return NETWORK_STRICTNESS[String(workspaceValue)] < NETWORK_STRICTNESS[String(baseline)]
      ? workspaceValue : baseline;
  }
  if (field.key === "readScope") {
    return READ_SCOPE_STRICTNESS[String(workspaceValue)] < READ_SCOPE_STRICTNESS[String(baseline)]
      ? workspaceValue : baseline;
  }
  if (field.key === "processHandoff") {
    return HANDOFF_STRICTNESS[String(workspaceValue)] < HANDOFF_STRICTNESS[String(baseline)]
      ? workspaceValue : baseline;
  }
  return workspaceValue;
}

export function resolveConfig(sources: ConfigSources, schema = SIGMA_CONFIG_SCHEMA): ResolvedConfig {
  const knownFlags = new Set(schema.map((field) => field.flag));
  for (const flag of Object.keys(sources.flags ?? {})) {
    if (!knownFlags.has(flag)) throw new Error(`Unknown option '--${flag}'.`);
  }
  validateTomlKeys(sources.workspace, schema, "workspace");
  validateTomlKeys(sources.home, schema, "home");
  const result: ResolvedConfig = {};
  for (const field of schema) {
    const explicit = sources.flags?.[field.flag]
      ?? (field.env ? sources.env?.[field.env] : undefined);
    if (explicit !== undefined) {
      result[field.key] = field.parse(explicit);
      continue;
    }
    const workspaceRaw = nestedValue(sources.workspace, field.toml);
    const baseline = field.parse(nestedValue(sources.home, field.toml) ?? field.defaultValue);
    result[field.key] = workspaceRaw === undefined
      ? baseline
      : restrictWorkspaceValue(field, baseline, workspaceRaw);
  }
  return result;
}
interface ParsedFlagToken {
  field: ConfigField;
  inline: string | undefined;
}
function flagIndex(schema: readonly ConfigField[]): Map<string, ConfigField> {
  const byFlag = new Map<string, ConfigField>();
  for (const field of schema) {
    byFlag.set(field.flag, field);
    if (field.shortFlag) byFlag.set(field.shortFlag, field);
  }
  return byFlag;
}
function parseFlagToken(item: string, byFlag: ReadonlyMap<string, ConfigField>): ParsedFlagToken {
  const long = item.startsWith("--");
  const [name, inline] = item.slice(long ? 2 : 1).split("=", 2);
  const field = byFlag.get(name);
  if (!field) throw new Error(`Unknown option '${long ? "--" : "-"}${name}'.`);
  return { field, inline };
}

function storeFlag(flags: Record<string, unknown>, field: ConfigField, raw: string): void {
  if (field.kind !== "repeatable") {
    flags[field.flag] = raw;
    return;
  }
  const previous = flags[field.flag];
  flags[field.flag] = [...(Array.isArray(previous) ? previous : []), raw];
}

function consumeFlag(
  argv: string[],
  index: number,
  parsed: ParsedFlagToken,
  flags: Record<string, unknown>
): number {
  const { field, inline } = parsed;
  if (field.kind === "boolean") {
    flags[field.flag] = inline === undefined ? true : field.parse(inline);
    return index;
  }
  const raw = inline ?? argv[index + 1];
  if (raw === undefined || raw.startsWith("--")) throw new Error(`Option '--${field.flag}' requires a value.`);
  storeFlag(flags, field, raw);
  return inline === undefined ? index + 1 : index;
}

export function parseFlags(argv: string[], schema = SIGMA_CONFIG_SCHEMA): { flags: Record<string, unknown>; positionals: string[] } {
  const byFlag = flagIndex(schema);
  const flags: Record<string, unknown> = {};
  const positionals: string[] = [];
  let positionalOnly = false;
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--") {
      positionalOnly = true;
      continue;
    }
    if (positionalOnly || !item.startsWith("-")) {
      positionals.push(item);
      continue;
    }
    index = consumeFlag(argv, index, parseFlagToken(item, byFlag), flags);
  }
  return { flags, positionals };
}

export function configHelp(schema = SIGMA_CONFIG_SCHEMA): string[] {
  return schema.filter((field) => !field.hidden).map((field) => {
    const value = field.kind === "boolean" ? "" : " <value>";
    const shown = field.secret ? "[hidden]" : String(field.defaultValue);
    return `  --${field.flag}${value}  ${field.description} (default: ${shown})`;
  });
}
