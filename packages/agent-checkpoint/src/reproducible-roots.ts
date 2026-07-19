import { lstat } from "node:fs/promises";
import {
  normalizeCheckpointScopes,
  pinCheckpointParent
} from "./path-safety.js";
import { CheckpointConflictError } from "./types.js";

function pathWithin(parent: string, child: string): boolean {
  return parent === "." || parent === child || child.startsWith(`${parent}/`);
}

async function rootWasAbsentWithStableParent(workspacePath: string, root: string): Promise<boolean> {
  const pinned = await pinCheckpointParent(workspacePath, root).catch((error: unknown) => {
    // A missing or otherwise unstable parent makes the compaction
    // ineligible. The subsequent exact capture remains fail-closed.
    if (error instanceof CheckpointConflictError) return undefined;
    throw error;
  });
  if (!pinned) return false;
  try {
    await pinned.verify();
    const info = await lstat(pinned.targetPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    await pinned.verify();
    return info === undefined;
  } finally {
    await pinned.close();
  }
}

/** Selects only absent, scoped, non-deliverable roots whose parent identity
 * can be pinned. Everything else falls back to exact capture. */
export async function selectReproducibleRoots(input: {
  workspacePath: string;
  scopePaths: readonly string[];
  requestedPaths: readonly string[];
  explicitDeliverablePaths: readonly string[];
  excludedNames: ReadonlySet<string>;
}): Promise<string[]> {
  if (input.requestedPaths.length === 0) return [];
  const requested = (await normalizeCheckpointScopes(input.workspacePath, input.requestedPaths)).scopePaths;
  const explicit = input.explicitDeliverablePaths.length === 0
    ? []
    : (await normalizeCheckpointScopes(input.workspacePath, input.explicitDeliverablePaths)).scopePaths;
  const selected: string[] = [];
  for (const root of requested) {
    if (root === "." || root.split("/").some((part) => input.excludedNames.has(part))) continue;
    if (!input.scopePaths.some((scope) => pathWithin(scope, root))) continue;
    if (explicit.some((deliverable) => pathWithin(root, deliverable) || pathWithin(deliverable, root))) continue;
    if (await rootWasAbsentWithStableParent(input.workspacePath, root)) selected.push(root);
  }
  return selected.sort();
}
