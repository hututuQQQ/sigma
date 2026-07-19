import path from "node:path";
import { realpath } from "node:fs/promises";
import { ensurePrivateStateDirectory, isInside } from "agent-platform";

async function canonicalPathAllowMissing(target: string): Promise<string> {
  let ancestor = path.resolve(target);
  while (true) {
    try {
      const canonical = await realpath(ancestor);
      return path.resolve(canonical, path.relative(ancestor, target));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
}

export async function prepareRuntimeStoreRoot(configuredRoot: string, workspace: string): Promise<string> {
  const storeRootDir = path.resolve(configuredRoot);
  if (isInside(workspace, await canonicalPathAllowMissing(storeRootDir))) {
    throw new Error("Runtime state root must be outside the workspace.");
  }
  await ensurePrivateStateDirectory(storeRootDir);
  const canonicalStoreRoot = await realpath(storeRootDir);
  if (isInside(workspace, canonicalStoreRoot)) {
    throw new Error("Runtime state root must remain outside the workspace after creation.");
  }
  return canonicalStoreRoot;
}
