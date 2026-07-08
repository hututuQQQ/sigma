import { createHash } from "node:crypto";
import type { ContextSourceEntry, ContextSourceKind, ContextSourceMap } from "../types.js";

export function estimateContextTokens(chars: number): number {
  return Math.max(1, Math.ceil(chars / 4));
}

export function contextCacheKey(kind: ContextSourceKind, label: string, content: string): string {
  return createHash("sha1").update(`${kind}\0${label}\0${content}`).digest("hex");
}

export function contextSourceEntry(options: {
  id: string;
  kind: ContextSourceKind;
  label: string;
  content: string;
  cacheable?: boolean;
  truncated?: boolean;
  modelVisible?: boolean;
  activationReason?: string;
  path?: string;
  authority?: ContextSourceEntry["authority"];
}): ContextSourceEntry {
  return {
    id: options.id,
    kind: options.kind,
    label: options.label,
    chars: options.content.length,
    estimated_tokens: estimateContextTokens(options.content.length),
    cache_key: options.cacheable ? contextCacheKey(options.kind, options.label, options.content) : undefined,
    cacheable: options.cacheable,
    truncated: options.truncated,
    model_visible: options.modelVisible ?? true,
    activation_reason: options.activationReason,
    path: options.path,
    authority: options.authority
  };
}

export function buildContextSourceMap(entries: ContextSourceEntry[]): ContextSourceMap {
  return {
    entries,
    total_estimated_tokens: entries.reduce((total, entry) => total + entry.estimated_tokens, 0),
    generated_at: new Date().toISOString()
  };
}

export function contextPressure(estimatedTokens: number, maxMessageHistoryChars?: number): "low" | "medium" | "high" | "critical" {
  if (!maxMessageHistoryChars || maxMessageHistoryChars <= 0) {
    if (estimatedTokens < 32000) return "low";
    if (estimatedTokens < 64000) return "medium";
    if (estimatedTokens < 100000) return "high";
    return "critical";
  }
  const maxEstimatedTokens = estimateContextTokens(maxMessageHistoryChars);
  const ratio = estimatedTokens / Math.max(1, maxEstimatedTokens);
  if (ratio < 0.5) return "low";
  if (ratio < 0.75) return "medium";
  if (ratio < 0.9) return "high";
  return "critical";
}
