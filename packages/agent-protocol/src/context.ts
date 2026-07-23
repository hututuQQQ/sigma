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

/**
 * Durable semantic replacement for a stable, omitted history prefix.
 *
 * The original event log remains authoritative and is never deleted. The
 * archive is only a model-context projection, so it deliberately carries no
 * system/developer/user authority of its own.
 */
export interface ContextArchiveV1 {
  schemaVersion: 1;
  item: ContextItem;
  omittedHistoryTurns: number;
  sourceDigest: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function isContextItem(value: unknown): value is ContextItem {
  const item = record(value);
  return Boolean(item
    && typeof item.id === "string" && item.id.length > 0
    && ["system", "developer", "user", "project", "runtime", "tool"].includes(String(item.authority))
    && typeof item.provenance === "string" && item.provenance.length > 0
    && typeof item.content === "string"
    && Number.isSafeInteger(item.tokenCount) && Number(item.tokenCount) >= 0
    && typeof item.priority === "number" && Number.isFinite(item.priority)
    && (item.cacheKey === undefined || typeof item.cacheKey === "string"));
}

export function isContextArchiveV1(value: unknown): value is ContextArchiveV1 {
  const archive = record(value);
  return Boolean(archive
    && archive.schemaVersion === 1
    && isContextItem(archive.item)
    && Number.isSafeInteger(archive.omittedHistoryTurns)
    && Number(archive.omittedHistoryTurns) >= 0
    && typeof archive.sourceDigest === "string"
    && /^[a-f0-9]{64}$/u.test(archive.sourceDigest)
    && archive.item.cacheKey === archive.sourceDigest);
}

export interface ContextBudget {
  contextWindowTokens: number;
  outputReserveTokens: number;
  toolTokens: number;
  systemTokens: number;
  dynamicTokens: number;
  historyTokens: number;
}
