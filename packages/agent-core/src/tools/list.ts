import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { ToolExecutionContext, ToolResult } from "../types.js";
import { truncateMiddle } from "../compaction.js";
import { workspaceRelativePath } from "../policy.js";
import {
  comparePath,
  explicitPathIncludesIgnored,
  resolveWorkspaceRelativePath,
  shouldSkipName
} from "./workspace-utils.js";

interface ListArgs {
  path?: unknown;
  depth?: unknown;
  includeHidden?: unknown;
  maxEntries?: unknown;
}

interface ListEntry {
  type: "file" | "directory";
  path: string;
  size?: number;
}

function numberOrDefault(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

export async function executeListTool(args: unknown, context: ToolExecutionContext): Promise<ToolResult> {
  const parsed = (args && typeof args === "object" ? args : {}) as ListArgs;
  const requestedPath = typeof parsed.path === "string" && parsed.path.length > 0 ? parsed.path : ".";
  const depth = numberOrDefault(parsed.depth, 2, 0, 20);
  const maxEntries = numberOrDefault(parsed.maxEntries, 200, 1, 5000);
  const includeHidden = parsed.includeHidden === true;

  let rootPath: string;
  let rootRelative: string;
  try {
    const resolved = resolveWorkspaceRelativePath(context.workspacePath, requestedPath);
    rootPath = resolved.absolutePath;
    rootRelative = resolved.relativePath;
  } catch (error) {
    return { ok: false, content: error instanceof Error ? error.message : String(error) };
  }

  const entries: ListEntry[] = [];
  const explicitIncludesIgnored = explicitPathIncludesIgnored(rootRelative);
  let truncated = false;

  async function addEntry(absolutePath: string, remainingDepth: number, includeSelf = true): Promise<void> {
    if (entries.length >= maxEntries) {
      truncated = true;
      return;
    }
    const info = await stat(absolutePath);
    const relative = workspaceRelativePath(context.workspacePath, absolutePath) || ".";
    if (info.isDirectory()) {
      if (includeSelf) entries.push({ type: "directory", path: relative });
      if (remainingDepth <= 0) return;
      const children = (await readdir(absolutePath, { withFileTypes: true })).sort((a, b) => comparePath(a.name, b.name));
      for (const child of children) {
        if (entries.length >= maxEntries) {
          truncated = true;
          return;
        }
        if (shouldSkipName(child.name, includeHidden, explicitIncludesIgnored)) continue;
        await addEntry(path.join(absolutePath, child.name), remainingDepth - 1);
      }
      return;
    }
    if (info.isFile()) {
      entries.push({ type: "file", path: relative, size: info.size });
    }
  }

  try {
    const rootInfo = await stat(rootPath);
    await addEntry(rootPath, depth, !rootInfo.isDirectory());
  } catch (error) {
    return { ok: false, content: error instanceof Error ? error.message : String(error) };
  }

  entries.sort((a, b) => comparePath(a.path, b.path) || comparePath(a.type, b.type));
  const content = JSON.stringify({ entries, truncated }, null, 2);
  const truncatedContent = truncateMiddle(content, context.maxToolOutputChars);
  return {
    ok: true,
    content: truncatedContent.text,
    metadata: {
      entries,
      truncated: truncated || truncatedContent.truncated,
      root: rootRelative
    }
  };
}
