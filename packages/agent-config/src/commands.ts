import type { RunMode } from "agent-protocol";

export interface CommandDefinition {
  name: string;
  aliases?: string[];
  summary: string;
  mode?: RunMode;
  handler: "run" | "tui" | "session" | "replay" | "doctor" | "version" | "init" | "completion";
  sessionAction?: "list" | "cancel" | "resume" | "approve";
}

export const SIGMA_COMMANDS: readonly CommandDefinition[] = [
  { name: "run", summary: "Run a workspace-changing task", mode: "change", handler: "run" },
  { name: "inspect", summary: "Analyze a workspace without writes", mode: "analyze", handler: "run" },
  { name: "tui", summary: "Open the interactive terminal UI", handler: "tui" },
  { name: "session", summary: "Inspect or resume sessions", handler: "session" },
  { name: "sessions", summary: "List v2 sessions", handler: "session", sessionAction: "list" },
  { name: "cancel", summary: "Cancel an active session", handler: "session", sessionAction: "cancel" },
  { name: "resume", summary: "Restore a durable session", handler: "session", sessionAction: "resume" },
  { name: "approval", summary: "Resolve a pending approval", handler: "session", sessionAction: "approve" },
  { name: "replay", summary: "Replay a v2 event stream", handler: "replay" },
  { name: "doctor", summary: "Check runtime configuration", handler: "doctor" },
  { name: "version", summary: "Print version information", handler: "version" },
  { name: "init", summary: "Create .agent/config.toml", handler: "init" },
  { name: "completion", summary: "Generate shell completion", handler: "completion" }
];

export class CommandRegistry {
  private readonly commands = new Map<string, CommandDefinition>();

  constructor(definitions: readonly CommandDefinition[] = SIGMA_COMMANDS) {
    for (const definition of definitions) this.register(definition);
  }

  register(definition: CommandDefinition): void {
    const names = [definition.name, ...(definition.aliases ?? [])];
    for (const name of names) {
      if (this.commands.has(name)) throw new Error(`Duplicate command '${name}'.`);
      this.commands.set(name, definition);
    }
  }

  resolve(name: string): CommandDefinition | undefined {
    return this.commands.get(name);
  }

  definitions(): CommandDefinition[] {
    return [...new Set(this.commands.values())].sort((left, right) => left.name.localeCompare(right.name));
  }
}
