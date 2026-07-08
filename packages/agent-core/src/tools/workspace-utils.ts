import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import ignore, { type Ignore } from "ignore";
import { resolveWorkspacePath, workspaceRelativePath } from "../policy.js";

export const DEFAULT_IGNORED_NAMES = new Set([".git", "node_modules", "dist", "coverage", ".artifacts"]);
const DEFAULT_IGNORE_PATTERNS = [...DEFAULT_IGNORED_NAMES].map((name) => `${name}/`);

export interface WalkFile {
  absolutePath: string;
  relativePath: string;
}

export function normalizeRelativePath(value: string): string {
  return value.split(path.sep).join("/");
}

export function resolveWorkspaceRelativePath(workspacePath: string, requestedPath: string): {
  absolutePath: string;
  relativePath: string;
} {
  const absolutePath = resolveWorkspacePath(workspacePath, requestedPath);
  const relativePath = workspaceRelativePath(workspacePath, absolutePath) || ".";
  return { absolutePath, relativePath };
}

export function explicitPathIncludesIgnored(relativePath: string): boolean {
  if (relativePath === ".") return false;
  return relativePath.split("/").some((segment) => DEFAULT_IGNORED_NAMES.has(segment) || segment.startsWith("."));
}

export function shouldSkipName(name: string, includeHidden: boolean, explicitIncludesIgnored: boolean): boolean {
  if (explicitIncludesIgnored) return false;
  if (DEFAULT_IGNORED_NAMES.has(name)) return !includeHidden;
  if (name.startsWith(".")) return !includeHidden;
  return false;
}

async function readIgnoreFile(filePath: string): Promise<string[]> {
  try {
    return (await readFile(filePath, "utf8")).split(/\r?\n/);
  } catch {
    return [];
  }
}

export async function createWorkspaceIgnore(workspacePath: string, options: {
  includeHidden?: boolean;
  explicitIncludesIgnored?: boolean;
} = {}): Promise<Ignore | null> {
  if (options.explicitIncludesIgnored) return null;
  const matcher = ignore();
  if (!options.includeHidden) matcher.add(DEFAULT_IGNORE_PATTERNS);
  matcher.add(await readIgnoreFile(path.join(workspacePath, ".gitignore")));
  matcher.add(await readIgnoreFile(path.join(workspacePath, ".agentignore")));
  return matcher;
}

export function ignoredByMatcher(matcher: Ignore | null, relativePath: string, isDirectory = false): boolean {
  if (!matcher) return false;
  const normalized = normalizeRelativePath(relativePath).replace(/^\.\/+/, "");
  if (!normalized || normalized === ".") return false;
  return matcher.ignores(isDirectory ? `${normalized.replace(/\/$/, "")}/` : normalized);
}

export function comparePath(a: string, b: string): number {
  return a.localeCompare(b, "en");
}

export async function isBinaryFile(filePath: string): Promise<boolean> {
  const buffer = await readFile(filePath);
  return buffer.subarray(0, Math.min(buffer.length, 4096)).includes(0);
}

export async function walkFiles(options: {
  workspacePath: string;
  rootPath: string;
  maxFiles: number;
  includeHidden?: boolean;
  explicitIncludesIgnored?: boolean;
}): Promise<{ files: WalkFile[]; truncated: boolean }> {
  const files: WalkFile[] = [];
  const includeHidden = options.includeHidden ?? false;
  const explicitIncludesIgnored = options.explicitIncludesIgnored ?? false;
  const matcher = await createWorkspaceIgnore(options.workspacePath, { includeHidden, explicitIncludesIgnored });
  let truncated = false;

  async function visit(dirPath: string): Promise<void> {
    if (files.length >= options.maxFiles) {
      truncated = true;
      return;
    }
    const entries = (await readdir(dirPath, { withFileTypes: true })).sort((a, b) => comparePath(a.name, b.name));
    for (const entry of entries) {
      if (files.length >= options.maxFiles) {
        truncated = true;
        return;
      }
      if (shouldSkipName(entry.name, includeHidden, explicitIncludesIgnored)) continue;
      const absolutePath = path.join(dirPath, entry.name);
      const relativePath = workspaceRelativePath(options.workspacePath, absolutePath);
      const info = await stat(absolutePath);
      if (ignoredByMatcher(matcher, relativePath, info.isDirectory())) continue;
      if (info.isDirectory()) {
        await visit(absolutePath);
      } else if (info.isFile()) {
        files.push({
          absolutePath,
          relativePath
        });
      }
    }
  }

  const rootInfo = await stat(options.rootPath);
  if (rootInfo.isFile()) {
    files.push({
      absolutePath: options.rootPath,
      relativePath: workspaceRelativePath(options.workspacePath, options.rootPath)
    });
  } else if (rootInfo.isDirectory()) {
    await visit(options.rootPath);
  }

  files.sort((a, b) => comparePath(a.relativePath, b.relativePath));
  return { files, truncated };
}
