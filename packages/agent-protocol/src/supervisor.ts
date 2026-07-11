import type { JsonValue } from "./json.js";
import type { ToolEffect } from "./tools.js";

export interface SupervisorSpawnInput {
  childId?: string;
  parentId: string;
  instruction: string;
  workspacePath: string;
  intent: "analyze" | "write";
  writeScope: string[];
  delegatedEffects: ToolEffect[];
  detached: boolean;
  metadata: JsonValue;
}

export interface SupervisorPort {
  spawnDurable(input: SupervisorSpawnInput): Promise<{ id: string }>;
  followUp(childId: string, text: string): void;
  join(childId: string): Promise<unknown>;
  list(parentId?: string): unknown[];
  integrate(childId: string, signal?: AbortSignal): Promise<unknown>;
}
