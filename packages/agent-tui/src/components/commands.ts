import { glyphs, truncateToWidth } from "../ui/theme.js";

export type CommandGroup = "core" | "inspect" | "run" | "configure";

export interface CommandSpec {
  name: string;
  usage: string;
  aliases: string[];
  group: CommandGroup;
  description: string;
  shortcut?: string;
  takesValue?: boolean;
}

export interface ResolvedCommand {
  spec: CommandSpec;
  canonicalInput: string;
  value: string;
}

export const COMMANDS: CommandSpec[] = [
  { name: "/help", usage: "/help", aliases: ["/h", "/?"], group: "core", description: "Show shortcuts and commands", shortcut: "F1" },
  { name: "/status", usage: "/status", aliases: ["/s"], group: "inspect", description: "Show current run settings" },
  { name: "/tokens", usage: "/tokens", aliases: ["/tk"], group: "inspect", description: "Show token usage" },
  { name: "/context", usage: "/context", aliases: ["/c"], group: "inspect", description: "Show context and skills state" },
  { name: "/tools", usage: "/tools", aliases: ["/t"], group: "inspect", description: "Show recent tool calls", shortcut: "Ctrl+T" },
  { name: "/diff", usage: "/diff", aliases: ["/d"], group: "inspect", description: "Show changed-file stats", shortcut: "Ctrl+D" },
  { name: "/diff stat", usage: "/diff stat", aliases: ["/ds"], group: "inspect", description: "Show changed-file stats" },
  { name: "/diff patch", usage: "/diff patch", aliases: ["/dp"], group: "inspect", description: "Show current git patch" },
  { name: "/test", usage: "/test <command>", aliases: [], group: "run", description: "Run a local validation command", takesValue: true },
  { name: "/shell", usage: "/shell <command>", aliases: ["!"], group: "run", description: "Run a local shell command", takesValue: true },
  { name: "/mode plan", usage: "/mode plan", aliases: [], group: "configure", description: "Disable mutating tools for new runs", shortcut: "Tab" },
  { name: "/mode build", usage: "/mode build", aliases: [], group: "configure", description: "Restore normal tool filters", shortcut: "Tab" },
  { name: "/model", usage: "/model <name>", aliases: [], group: "configure", description: "Change model", takesValue: true },
  { name: "/provider", usage: "/provider <deepseek|glm>", aliases: [], group: "configure", description: "Change provider", takesValue: true },
  { name: "/permission", usage: "/permission <ask|yolo>", aliases: [], group: "configure", description: "Change permission mode", takesValue: true },
  { name: "/workspace", usage: "/workspace <path>", aliases: ["/w"], group: "configure", description: "Switch workspace", takesValue: true },
  { name: "/clear", usage: "/clear", aliases: ["/cl"], group: "core", description: "Clear transcript and result" },
  { name: "/exit", usage: "/exit", aliases: ["/q"], group: "core", description: "Exit Sigma" }
];

function normalizedInput(buffer: string): string {
  const trimmed = buffer.trimStart();
  if (trimmed.startsWith("!")) return `! ${trimmed.slice(1).trimStart()}`.trimEnd();
  if (!trimmed.startsWith("/")) return "";
  return trimmed.replace(/\s+/g, " ").trimEnd();
}

function fuzzyIncludes(candidate: string, query: string): boolean {
  if (candidate.includes(query)) return true;
  let searchIndex = 0;
  for (const char of query) {
    const found = candidate.indexOf(char, searchIndex);
    if (found < 0) return false;
    searchIndex = found + 1;
  }
  return true;
}

function specTokens(spec: CommandSpec): string[] {
  return [spec.name, spec.usage, ...spec.aliases, spec.description].map((item) => item.toLowerCase());
}

export function commandSuggestions(buffer: string): CommandSpec[] {
  const query = normalizedInput(buffer).toLowerCase();
  if (!query || query === "/") return COMMANDS;
  if (query.startsWith("!")) return COMMANDS.filter((command) => command.name === "/shell");
  const prefixMatches = COMMANDS.filter((command) => {
    const names = [command.name, command.usage, ...command.aliases].map((item) => item.toLowerCase());
    return names.some((name) => name.startsWith(query) || query.startsWith(name));
  });
  if (query.startsWith("/") && prefixMatches.length > 0) return prefixMatches;
  return COMMANDS.filter((command) => {
    const names = [command.name, command.usage, ...command.aliases].map((item) => item.toLowerCase());
    if (names.some((name) => name.startsWith(query) || query.startsWith(name))) return true;
    return specTokens(command).some((token) => fuzzyIncludes(token, query));
  });
}

function commandKeys(spec: CommandSpec): string[] {
  return [spec.name, ...spec.aliases].sort((a, b) => b.length - a.length);
}

export function resolveCommand(input: string): ResolvedCommand | null {
  const normalized = normalizedInput(input);
  if (!normalized) return null;
  if (normalized.startsWith("!")) {
    const spec = COMMANDS.find((command) => command.name === "/shell");
    if (!spec) return null;
    return {
      spec,
      canonicalInput: "/shell",
      value: normalized.slice(1).trim()
    };
  }

  const matches: Array<{ spec: CommandSpec; key: string }> = [];
  for (const spec of COMMANDS) {
    for (const key of commandKeys(spec)) {
      if (normalized === key || normalized.startsWith(`${key} `)) {
        matches.push({ spec, key });
      }
    }
  }
  matches.sort((a, b) => b.key.length - a.key.length);
  const match = matches[0];
  if (!match) return null;
  return {
    spec: match.spec,
    canonicalInput: match.spec.name,
    value: normalized.slice(match.key.length).trim()
  };
}

export function canonicalCommandInput(input: string): string | null {
  const resolved = resolveCommand(input);
  if (!resolved) return null;
  return [resolved.spec.name, resolved.value].filter(Boolean).join(" ");
}

export function renderCommandPalette(buffer: string, width: number, maxRows = 14): string[] {
  const g = glyphs();
  const suggestions = commandSuggestions(buffer).slice(0, maxRows);
  const query = normalizedInput(buffer) || "/";
  const lines = ["commands"];
  if (query !== "/") lines.push(`  ${truncateToWidth(query, Math.max(10, width - 2))}`);
  if (suggestions.length === 0) {
    lines.push("  no matching commands");
    return lines;
  }

  let lastGroup: CommandGroup | null = null;
  const nameWidth = Math.min(18, Math.max(10, ...suggestions.map((item) => item.name.length)));
  const aliasWidth = Math.min(10, Math.max(4, ...suggestions.map((item) => item.aliases.join(", ").length)));
  for (const command of suggestions) {
    if (command.group !== lastGroup) {
      lines.push(`  ${command.group}`);
      lastGroup = command.group;
    }
    const aliases = command.aliases.join(", ");
    const shortcut = command.shortcut ? ` ${g.separator} ${command.shortcut}` : "";
    const prefix = `  ${command.name.padEnd(nameWidth)}  ${aliases.padEnd(aliasWidth)}  `;
    lines.push(`${prefix}${truncateToWidth(`${command.description}${shortcut}`, Math.max(8, width - prefix.length))}`);
  }
  const remaining = commandSuggestions(buffer).length - suggestions.length;
  if (remaining > 0) lines.push(`  ${g.ellipsis} ${remaining} more`);
  return lines;
}
