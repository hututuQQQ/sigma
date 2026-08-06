import type { WorkspaceDirectoryEntry } from "agent-platform";

export interface BoundedDirectoryEntries {
  entries: WorkspaceDirectoryEntry[];
  limitReached: "deadline" | "entries" | null;
}

function lexicalEntryOrder(left: WorkspaceDirectoryEntry, right: WorkspaceDirectoryEntry): number {
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}

/** Fully enumerates one directory within a hard bound before exposing a stable subset. */
export async function boundedDirectoryEntries(
  source: AsyncIterable<WorkspaceDirectoryEntry>,
  maximum: number,
  deadline: number,
  signal: AbortSignal
): Promise<BoundedDirectoryEntries> {
  const entries: WorkspaceDirectoryEntry[] = [];
  for await (const entry of source) {
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
