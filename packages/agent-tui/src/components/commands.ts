import { glyphs, truncateToWidth } from "../ui/theme.js";

export interface CommandSpec {
  usage: string;
  description: string;
}

export const COMMANDS: CommandSpec[] = [
  { usage: "/help", description: "Show command palette" },
  { usage: "/status", description: "Show run settings and last result" },
  { usage: "/tokens", description: "Show usage" },
  { usage: "/context", description: "Show repo map, instructions, and skills state" },
  { usage: "/tools", description: "Toggle tools panel" },
  { usage: "/diff", description: "Toggle git diff" },
  { usage: "/diff stat", description: "Show changed-file statistics" },
  { usage: "/diff patch", description: "Show a colorized truncated patch" },
  { usage: "/test <command>", description: "Run a local validation command" },
  { usage: "/model <name>", description: "Change model" },
  { usage: "/provider <name>", description: "Change provider" },
  { usage: "/permission <mode>", description: "Change ask/yolo mode" },
  { usage: "/clear", description: "Clear timeline and result" },
  { usage: "/exit", description: "Exit" }
];

function normalizedQuery(buffer: string): string {
  const trimmed = buffer.trimStart();
  if (!trimmed.startsWith("/")) return "";
  return trimmed.replace(/\s+/g, " ");
}

export function commandSuggestions(buffer: string): CommandSpec[] {
  const query = normalizedQuery(buffer);
  if (!query || query === "/") return COMMANDS;
  return COMMANDS.filter((command) => command.usage.startsWith(query));
}

export function renderCommandPalette(buffer: string, width: number, maxRows = 14): string[] {
  const g = glyphs();
  const suggestions = commandSuggestions(buffer).slice(0, maxRows);
  const query = normalizedQuery(buffer) || "/";
  const lines = [
    `${g.sigma} Command Palette`,
    `query: ${query}`
  ];
  if (suggestions.length === 0) {
    lines.push("No matching commands.");
    return lines;
  }
  const usageWidth = Math.min(24, Math.max(14, ...suggestions.map((item) => item.usage.length + 1)));
  for (const command of suggestions) {
    const usage = command.usage.padEnd(usageWidth, " ");
    lines.push(`${usage}${truncateToWidth(command.description, Math.max(10, width - usageWidth - 6))}`);
  }
  const remaining = commandSuggestions(buffer).length - suggestions.length;
  if (remaining > 0) lines.push(`${g.ellipsis} ${remaining} more`);
  return lines;
}
