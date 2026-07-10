import { SIGMA_CONFIG_SCHEMA, type ConfigValue, type McpServerConfigValue } from "./schema.js";

function scalar(value: string | number | boolean | string[]): string {
  if (Array.isArray(value)) return `[${value.map((item) => JSON.stringify(item)).join(", ")}]`;
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

function mcpServer(server: McpServerConfigValue): string {
  const values: Array<[string, string | number | boolean | string[]]> = [
    ["name", server.name], ["command", server.command], ["args", server.args], ["cwd", server.cwd],
    ["possible_effects", server.possibleEffects], ["approval", server.approval],
    ["execution_mode", server.executionMode], ["idempotent", server.idempotent],
    ["timeout_ms", server.timeoutMs], ["idle_timeout_ms", server.idleTimeoutMs],
    ["hard_deadline_ms", server.hardDeadlineMs], ["shutdown_grace_ms", server.shutdownGraceMs]
  ];
  const lines = ["[[mcp.servers]]", ...values.map(([key, value]) => `${key} = ${scalar(value)}`)];
  for (const [key, value] of Object.entries(server.env)) lines.push(`env.${JSON.stringify(key)} = ${JSON.stringify(value)}`);
  return lines.join("\n");
}

export function renderConfigToml(overrides: Partial<Record<string, ConfigValue>> = {}, comment?: string): string {
  const sections = new Map<string, string[]>();
  let mcpServers: McpServerConfigValue[] = [];
  for (const field of SIGMA_CONFIG_SCHEMA) {
    if (!field.toml) continue;
    const value = overrides[field.key] ?? field.defaultValue;
    if (field.key === "mcpServers") {
      mcpServers = value as McpServerConfigValue[];
      continue;
    }
    const [section, key] = field.toml.split(".");
    const lines = sections.get(section) ?? [];
    lines.push(`${key} = ${scalar(value as string | number | boolean | string[])}`);
    sections.set(section, lines);
  }
  const blocks = [...sections].map(([section, lines]) => `[${section}]\n${lines.join("\n")}`);
  if (mcpServers.length > 0) blocks.push(mcpServers.map(mcpServer).join("\n\n"));
  return `${comment ? `# ${comment}\n\n` : ""}${blocks.join("\n\n")}\n`;
}
