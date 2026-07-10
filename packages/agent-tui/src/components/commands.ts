export interface TuiCommandDefinition {
  action: "new" | "mode" | "followup" | "activity" | "help" | "quit";
  name: string;
  usage: string;
  description: string;
  acceptsArguments?: boolean;
}

export const tuiCommands: readonly TuiCommandDefinition[] = [
  { action: "new", name: "/new", usage: "/new", description: "Start a new session" },
  { action: "mode", name: "/mode", usage: "/mode analyze|change", description: "Change mode for the next run", acceptsArguments: true },
  { action: "followup", name: "/followup", usage: "/followup <message>", description: "Queue work after the active answer", acceptsArguments: true },
  { action: "activity", name: "/activity", usage: "/activity", description: "Collapse or expand activity" },
  { action: "help", name: "/help", usage: "/help", description: "Show commands and shortcuts" },
  { action: "quit", name: "/quit", usage: "/quit", description: "Exit Sigma" },
  { action: "quit", name: "/exit", usage: "/exit", description: "Exit Sigma" }
];

export function parseTuiCommand(value: string): { command: TuiCommandDefinition; argument: string } | undefined {
  if (!value.startsWith("/")) return undefined;
  const [name, ...rest] = value.trim().split(/\s+/u);
  const command = tuiCommands.find((item) => item.name === name.toLowerCase());
  return command ? { command, argument: rest.join(" ").trim() } : undefined;
}

export function matchingCommands(value: string): TuiCommandDefinition[] {
  if (!value.startsWith("/") || /\s/u.test(value)) return [];
  const query = value.toLowerCase();
  return tuiCommands.filter((item) => item.name.startsWith(query));
}

export function helpText(): string {
  const commands = tuiCommands.map((item) => `${item.usage.padEnd(26)} ${item.description}`).join("\n");
  return `Sigma shortcuts\n\nEnter       send / steer now\nShift+Enter add a line\nCtrl+J      add a line\nAlt+Enter   queue a follow-up\nPgUp/PgDn   scroll conversation\nCtrl+U/D    scroll half a page\nCtrl+O      toggle activity\n?           open this help\nCtrl+C      cancel; press twice to exit\n\nCommands\n\n${commands}\n\nEsc close`;
}
