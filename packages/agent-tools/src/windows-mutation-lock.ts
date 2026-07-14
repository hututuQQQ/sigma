import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import type { ToolCallPlan } from "agent-protocol";
import {
  isInside,
  lockWindowsDirectories,
  pinWorkspaceTransactionPaths,
  type WindowsDirectoryLock,
  type WindowsPathLockRequest,
  type WorkspaceTransactionDirectoryLease
} from "agent-platform";
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

export async function pinProcessReadRoots(
  context: PlannedToolExecutionContext,
  plan: ToolCallPlan
): Promise<WorkspaceTransactionDirectoryLease> {
  const workspace = path.resolve(context.workspacePath);
  const paths = await processReadPaths(workspace, plan);
  const lease = await pinWorkspaceTransactionPaths([...paths.values()]);
  try {
    await lease.verify();
    const verified = await processReadPaths(workspace, plan);
    const unlocked = [...verified.keys()].filter((key) => !paths.has(key));
    if (unlocked.length > 0) {
      throw writePlanError(
        `Process read paths changed while being pinned: ${unlocked.join(", ")}.`,
        "write_plan_stale"
      );
    }
    return lease;
  } catch (error) {
    await lease.close();
    throw error;
  }
}

function readPathKey(target: WindowsPathLockRequest): string {
  return `${target.kind}:${path.resolve(target.path)}`;
}

async function readPathKind(target: string): Promise<WindowsPathLockRequest["kind"]> {
  const info = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!info || info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) {
    throw writePlanError(`Process read path is not a stable file or directory: ${target}.`, "write_plan_stale");
  }
  if (info.isFile() && info.nlink !== 1) {
    throw writePlanError(`Process read file has multiple hard links: ${target}.`, "write_plan_stale");
  }
  return info.isDirectory() ? "directory" : "file";
}

async function processReadPaths(
  workspace: string,
  plan: ToolCallPlan
): Promise<Map<string, WindowsPathLockRequest>> {
  const requested = await Promise.all(plan.readPaths.map(async (root) => {
    const target = path.isAbsolute(root) ? path.resolve(root) : path.resolve(workspace, root);
    return { path: target, kind: await readPathKind(target) } satisfies WindowsPathLockRequest;
  }));
  const externalAnchors = requested.filter((target) =>
    target.kind === "directory" && !isInside(workspace, target.path)
  );
  const paths = new Map<string, WindowsPathLockRequest>();
  const add = (target: WindowsPathLockRequest): void => { paths.set(readPathKey(target), target); };
  add({ path: workspace, kind: "directory" });
  for (const target of requested) {
    const anchor = isInside(workspace, target.path)
      ? workspace
      : externalAnchors
        .filter((candidate) => isInside(candidate.path, target.path))
        .sort((left, right) => right.path.length - left.path.length)[0]?.path;
    if (!anchor) {
      throw writePlanError(`Approved process read path has no pinned root: ${target.path}.`, "write_plan_stale");
    }
    add({ path: anchor, kind: "directory" });
    const parts = path.relative(anchor, target.path).split(path.sep).filter(Boolean);
    for (let index = 0; index < parts.length; index += 1) {
      const current = path.join(anchor, ...parts.slice(0, index + 1));
      const kind = await readPathKind(current);
      if (index < parts.length - 1 && kind !== "directory") {
        throw writePlanError(`Process read path has an unstable parent: ${target.path}.`, "write_plan_stale");
      }
      add({ path: current, kind });
    }
  }
  return paths;
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
