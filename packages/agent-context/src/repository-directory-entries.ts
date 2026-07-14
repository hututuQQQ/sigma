import type { Dirent } from "node:fs";
import { opendir } from "node:fs/promises";

export interface BoundedDirectoryEntries {
  entries: Dirent[];
  limitReached: "deadline" | "entries" | null;
}

function lexicalEntryOrder(left: Dirent, right: Dirent): number {
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}

/** Fully enumerates one directory within a hard bound before exposing a stable subset. */
export async function boundedDirectoryEntries(
  directory: string,
  maximum: number,
  deadline: number,
  signal: AbortSignal
): Promise<BoundedDirectoryEntries> {
  const entries: Dirent[] = [];
  const opened = await opendir(directory);
  for await (const entry of opened) {
    signal.throwIfAborted();
    if (performance.now() >= deadline) return { entries: [], limitReached: "deadline" };
    if (entries.length >= maximum) return { entries: [], limitReached: "entries" };
    entries.push(entry);
  }
  signal.throwIfAborted();
  if (performance.now() >= deadline) return { entries: [], limitReached: "deadline" };
  entries.sort(lexicalEntryOrder);
  if (performance.now() >= deadline) return { entries: [], limitReached: "deadline" };
  return { entries, limitReached: null };
}
