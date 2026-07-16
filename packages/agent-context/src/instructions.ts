import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { resolveWorkspacePath } from "agent-platform";
import type { ContextItem } from "agent-protocol";
import { approximateTokens } from "./unicode.js";

export interface LoadInstructionsOptions {
  workspacePath: string;
  targetPath?: string;
  maxBytes?: number;
}

async function readableFile(filePath: string, maxBytes: number): Promise<string | null> {
  try {
    const info = await stat(filePath);
    if (!info.isFile() || info.size > maxBytes) return null;
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

export async function loadNestedInstructions(options: LoadInstructionsOptions): Promise<ContextItem[]> {
  const root = await resolveWorkspacePath(options.workspacePath, ".");
  const target = await resolveWorkspacePath(root, options.targetPath ?? ".");
  let targetDirectory = target;
  try {
    const targetInfo = await stat(target);
    if (!targetInfo.isDirectory()) targetDirectory = path.dirname(target);
  } catch {
    if (path.extname(target)) targetDirectory = path.dirname(target);
  }
  const relative = path.relative(root, targetDirectory);
  const directories = [root];
  if (relative) {
    let current = root;
    for (const part of relative.split(path.sep)) {
      current = path.join(current, part);
      directories.push(current);
    }
  }
  const maxBytes = options.maxBytes ?? 256 * 1024;
  const items: ContextItem[] = [];
  for (const directory of directories) {
    const filePath = await resolveWorkspacePath(root, path.join(directory, "AGENTS.md"));
    const content = await readableFile(filePath, maxBytes);
    if (!content) continue;
    const relativePath = path.relative(root, filePath).split(path.sep).join("/") || "AGENTS.md";
    items.push({
      id: `project:${relativePath}`,
      authority: "project",
      provenance: relativePath,
      content,
      tokenCount: approximateTokens(content),
      priority: 900,
      cacheKey: `project-instructions:${relativePath}`
    });
  }
  return items;
}
