import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { HarnessCleanupResult } from "../types.js";

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function wildcardRegex(pattern: string): RegExp {
  return new RegExp(`^${pattern.split("*").map(escapeRegex).join(".*")}$`);
}

async function pathsForPattern(pattern: string): Promise<string[]> {
  if (!pattern.includes("*")) return [pattern];
  const normalized = path.resolve(pattern);
  const dir = path.dirname(normalized);
  const basePattern = path.basename(normalized);
  const regex = wildcardRegex(basePattern);
  try {
    const entries = await readdir(dir);
    return entries.filter((entry) => regex.test(entry)).map((entry) => path.join(dir, entry));
  } catch {
    return [];
  }
}

export async function runPreVerifierCleanup(patterns: string[]): Promise<HarnessCleanupResult | null> {
  if (patterns.length === 0) return null;
  const removed: string[] = [];
  const skipped: string[] = [];
  const warnings: string[] = [];

  for (const pattern of patterns) {
    for (const candidate of await pathsForPattern(pattern)) {
      try {
        const candidateStat = await stat(candidate);
        if (!candidateStat.isFile()) {
          skipped.push(candidate);
          continue;
        }
        await rm(candidate, { force: true });
        removed.push(candidate);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        warnings.push(`${candidate}: ${message}`);
        skipped.push(candidate);
      }
    }
  }

  return {
    patterns,
    removed,
    skipped,
    exit_code: warnings.length > 0 ? 1 : 0,
    warning: warnings.length > 0 ? warnings.join("; ") : undefined
  };
}
