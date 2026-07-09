import type { ContextAuthority } from "./events.js";

export interface ContextItem {
  id: string;
  authority: Exclude<ContextAuthority, "external_verifier">;
  provenance: string;
  content: string;
  tokenCount: number;
  priority: number;
  cacheKey?: string;
}

export interface ContextBudget {
  contextWindowTokens: number;
  outputReserveTokens: number;
  toolTokens: number;
  systemTokens: number;
  dynamicTokens: number;
  historyTokens: number;
}
