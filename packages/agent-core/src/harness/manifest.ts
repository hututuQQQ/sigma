import path from "node:path";
import { stat } from "node:fs/promises";
import type { WorkspaceManifest } from "../types.js";
import { walkFiles } from "../tools/workspace-utils.js";

function toManifestPath(workspacePath: string, filePath: string): string {
  return path.relative(workspacePath, filePath).split(path.sep).join("/");
}

export async function listWorkspaceManifest(workspacePath: string): Promise<WorkspaceManifest> {
  const resolved = path.resolve(workspacePath);
  const manifest: WorkspaceManifest = {};
  const walked = await walkFiles({ workspacePath: resolved, rootPath: resolved, maxFiles: 50000 });
  for (const file of walked.files) {
    const entryStat = await stat(file.absolutePath);
    const manifestPath = toManifestPath(resolved, file.absolutePath);
    manifest[manifestPath] = {
      path: manifestPath,
      size: entryStat.size,
      mtimeMs: Math.floor(entryStat.mtimeMs)
    };
  }
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
