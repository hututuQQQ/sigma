import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import type { ToolCallPlan } from "agent-protocol";
import { isInside, lockWindowsDirectories, type WindowsDirectoryLock } from "agent-platform";
import { writePlanError } from "./process-mutation-contract.js";
import type { PlannedToolExecutionContext } from "./registry.js";

export async function lockWindowsMutationRoots(
  context: PlannedToolExecutionContext,
  plan: ToolCallPlan
): Promise<WindowsDirectoryLock | undefined> {
  if (process.platform !== "win32" || !plan.exactEffects.includes("filesystem.write")) return undefined;
  const workspace = path.resolve(context.workspacePath);
  const directories = await windowsMutationDirectories(workspace, plan);
  const lock = await lockWindowsDirectories([...directories]);
  try {
    const verified = await windowsMutationDirectories(workspace, plan);
    const unlocked = [...verified].filter((directory) => !directories.has(directory));
    if (unlocked.length > 0) {
      throw writePlanError(
        `Process mutation directories changed while being pinned: ${unlocked.join(", ")}.`,
        "write_plan_stale"
      );
    }
    return lock;
  } catch (error) {
    await lock.close();
    throw error;
  }
}

async function windowsMutationDirectories(workspace: string, plan: ToolCallPlan): Promise<Set<string>> {
  const directories = new Set<string>([workspace]);
  for (const root of [...plan.checkpointScope, ...plan.writePaths]) {
    const lexical = path.resolve(workspace, root);
    if (!isInside(workspace, lexical)) {
      throw writePlanError(`Process mutation path escapes the workspace: ${root}.`, "write_plan_invalid");
    }
    const parts = path.relative(workspace, lexical).split(path.sep).filter(Boolean);
    let finalDirectory: string | undefined;
    for (let index = 0; index < parts.length; index += 1) {
      const current = path.join(workspace, ...parts.slice(0, index + 1));
      const info = await lstat(current).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (!info) break;
      if (info.isSymbolicLink()) {
        throw writePlanError(`Process mutation paths cannot traverse links: ${root}.`, "write_plan_stale");
      }
      if (!info.isDirectory()) {
        if (index < parts.length - 1) {
          throw writePlanError(`Process mutation path has a non-directory parent: ${root}.`, "write_plan_stale");
        }
        break;
      }
      directories.add(current);
      if (index === parts.length - 1 && plan.writePaths.includes(root)) finalDirectory = current;
    }
    if (root === "." && plan.writePaths.includes(root)) finalDirectory = workspace;
    if (finalDirectory) await collectWindowsDirectoryTree(finalDirectory, directories);
  }
  return directories;
}

async function collectWindowsDirectoryTree(root: string, directories: Set<string>): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isSymbolicLink()) {
      throw writePlanError(`Process expected-change directory contains a link: ${target}.`, "write_plan_stale");
    }
    if (!entry.isDirectory()) continue;
    directories.add(target);
    await collectWindowsDirectoryTree(target, directories);
  }
}
