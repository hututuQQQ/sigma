import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { WorkspaceManifest } from "../types.js";

const SKIP_DIRS = new Set([".git", "node_modules"]);

function toManifestPath(workspacePath: string, filePath: string): string {
  return path.relative(workspacePath, filePath).split(path.sep).join("/");
}

async function walk(workspacePath: string, currentPath: string, manifest: WorkspaceManifest): Promise<void> {
  const entries = await readdir(currentPath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
    const entryPath = path.join(currentPath, entry.name);
    if (entry.isDirectory()) {
      await walk(workspacePath, entryPath, manifest);
      continue;
    }
    if (!entry.isFile()) continue;

    const entryStat = await stat(entryPath);
    const manifestPath = toManifestPath(workspacePath, entryPath);
    manifest[manifestPath] = {
      path: manifestPath,
      size: entryStat.size,
      mtimeMs: Math.floor(entryStat.mtimeMs)
    };
  }
}

export async function listWorkspaceManifest(workspacePath: string): Promise<WorkspaceManifest> {
  const resolved = path.resolve(workspacePath);
  const manifest: WorkspaceManifest = {};
  await walk(resolved, resolved, manifest);
  return manifest;
}

export function changedWorkspaceFiles(before: WorkspaceManifest, after: WorkspaceManifest): string[] {
  return Object.keys(after)
    .filter((filePath) => {
      const beforeEntry = before[filePath];
      const afterEntry = after[filePath];
      return !beforeEntry || beforeEntry.size !== afterEntry.size || beforeEntry.mtimeMs !== afterEntry.mtimeMs;
    })
    .sort();
}
