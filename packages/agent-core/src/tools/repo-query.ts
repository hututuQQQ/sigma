import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { truncateMiddle } from "../compaction.js";
import type { ToolExecutionContext, ToolResult } from "../types.js";
import { workspaceRelativePath } from "../policy.js";
import {
  explicitPathIncludesIgnored,
  resolveWorkspaceRelativePath,
  walkFiles,
  type WalkFile
} from "./workspace-utils.js";

type RepoQueryKind = "text" | "symbol" | "test" | "config" | "path";

interface RepoQueryArgs {
  query?: unknown;
  kind?: unknown;
  path?: unknown;
  maxSnippets?: unknown;
  maxChars?: unknown;
}

interface RepoQueryMatch {
  path: string;
  lineStart: number;
  lineEnd: number;
  score: number;
  snippet: string;
}

const MAX_FILE_BYTES = 256000;
const MAX_FILES = 20000;
const CONFIG_NAMES = new Set([
  "package.json",
  "tsconfig.json",
  "pyproject.toml",
  "requirements.txt",
  "go.mod",
  "Cargo.toml",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "Makefile",
  ".eslintrc",
  ".prettierrc"
]);

function numberOrDefault(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function kindValue(value: unknown): RepoQueryKind {
  return value === "symbol" || value === "test" || value === "config" || value === "path" ? value : "text";
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_.+-]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

function isBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, Math.min(buffer.length, 4096)).includes(0);
}

function isTestPath(filePath: string): boolean {
  return /(^|\/)(test|tests|__tests__)(\/|$)|[._-](test|spec)\.[A-Za-z0-9]+$/.test(filePath);
}

function isConfigPath(filePath: string): boolean {
  const base = filePath.split("/").pop() ?? filePath;
  return CONFIG_NAMES.has(base) || /(^|\/)\.(github|agent|vscode|config)(\/|$)/.test(filePath);
}

function looksLikeSymbolLine(line: string): boolean {
  return /^\s*(export\s+)?(async\s+)?(function|class|interface|type|const|let|var|def|struct|enum|trait|impl)\s+[A-Za-z0-9_$]+/.test(
    line
  );
}

function looksLikeTestLine(line: string): boolean {
  return /\b(describe|it|test)\s*\(|\b(assert|expect)\s*\(/.test(line);
}

function pathScore(file: WalkFile, tokens: string[], kind: RepoQueryKind): number {
  const lowerPath = file.relativePath.toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (lowerPath.includes(token)) score += 8;
  }
  if (kind === "test" && isTestPath(file.relativePath)) score += 20;
  if (kind === "config" && isConfigPath(file.relativePath)) score += 20;
  return score;
}

function snippetForLines(lines: string[], index: number, radius: number): { lineStart: number; lineEnd: number; snippet: string } {
  const start = Math.max(0, index - radius);
  const end = Math.min(lines.length - 1, index + radius);
  return {
    lineStart: start + 1,
    lineEnd: end + 1,
    snippet: lines.slice(start, end + 1).join("\n")
  };
}

async function scoreFile(options: {
  file: WalkFile;
  tokens: string[];
  kind: RepoQueryKind;
}): Promise<RepoQueryMatch[]> {
  const matches: RepoQueryMatch[] = [];
  const basePathScore = pathScore(options.file, options.tokens, options.kind);

  if (options.kind === "path" && basePathScore > 0) {
    matches.push({
      path: options.file.relativePath,
      lineStart: 1,
      lineEnd: 1,
      score: basePathScore,
      snippet: options.file.relativePath
    });
    return matches;
  }
  if (options.kind === "path") return [];

  const info = await stat(options.file.absolutePath);
  if (info.size > MAX_FILE_BYTES) return [];
  const buffer = await readFile(options.file.absolutePath);
  if (isBinary(buffer)) return [];
  const text = buffer.toString("utf8");
  const lines = text.split(/\r?\n/);
  const isConfigFile = isConfigPath(options.file.relativePath);
  const isTestFile = isTestPath(options.file.relativePath);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lowerLine = line.toLowerCase();
    const tokenHits = options.tokens.filter((token) => lowerLine.includes(token)).length;
    const isSymbolLine = looksLikeSymbolLine(line);
    const isTestLine = looksLikeTestLine(line);

    if (options.kind === "text" && tokenHits === 0) continue;
    if (options.kind === "symbol" && (tokenHits === 0 || !isSymbolLine)) continue;
    if (options.kind === "config" && (tokenHits === 0 || !isConfigFile)) continue;
    if (options.kind === "test" && (tokenHits === 0 || (!isTestFile && !isTestLine))) continue;

    let score = basePathScore + tokenHits * 10;
    for (const token of options.tokens) {
      if (lowerLine === token) score += 4;
    }
    if (options.kind === "symbol") score += 18;
    if (options.kind === "config") score += 8;
    if (options.kind === "test") score += 8;
    if (score <= 0) continue;
    const snippet = snippetForLines(lines, index, options.kind === "symbol" ? 1 : 2);
    matches.push({
      path: options.file.relativePath,
      lineStart: snippet.lineStart,
      lineEnd: snippet.lineEnd,
      score,
      snippet: snippet.snippet
    });
  }
  return matches;
}

export async function executeRepoQueryTool(args: unknown, context: ToolExecutionContext): Promise<ToolResult> {
  const parsed = (args && typeof args === "object" ? args : {}) as RepoQueryArgs;
  if (typeof parsed.query !== "string" || parsed.query.trim().length === 0) {
    return { ok: false, content: "repo_query requires a non-empty query string" };
  }
  const kind = kindValue(parsed.kind);
  const requestedPath = typeof parsed.path === "string" && parsed.path.length > 0 ? parsed.path : ".";
  const maxSnippets = numberOrDefault(parsed.maxSnippets, 8, 1, 50);
  const maxChars = numberOrDefault(parsed.maxChars, context.maxToolOutputChars, 500, 50000);
  const tokens = tokenize(parsed.query);
  if (tokens.length === 0) return { ok: false, content: "repo_query query did not contain searchable tokens" };

  let rootPath: string;
  let rootRelative: string;
  try {
    const resolved = resolveWorkspaceRelativePath(context.workspacePath, requestedPath);
    rootPath = resolved.absolutePath;
    rootRelative = resolved.relativePath;
  } catch (error) {
    return { ok: false, content: error instanceof Error ? error.message : String(error) };
  }

  try {
    const rootInfo = await stat(rootPath);
    const walked = rootInfo.isFile()
      ? {
          files: [{ absolutePath: rootPath, relativePath: workspaceRelativePath(context.workspacePath, rootPath) }],
          truncated: false
        }
      : await walkFiles({
          workspacePath: context.workspacePath,
          rootPath,
          maxFiles: MAX_FILES,
          explicitIncludesIgnored: explicitPathIncludesIgnored(rootRelative)
        });
    const matches: RepoQueryMatch[] = [];
    for (const file of walked.files) {
      matches.push(...(await scoreFile({ file, tokens, kind })));
    }
    matches.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path, "en") || a.lineStart - b.lineStart);
    const selected: RepoQueryMatch[] = [];
    const seen = new Set<string>();
    for (const match of matches) {
      const key = `${match.path}:${match.lineStart}:${match.lineEnd}`;
      if (seen.has(key)) continue;
      seen.add(key);
      selected.push(match);
      if (selected.length >= maxSnippets) break;
    }
    const content = JSON.stringify(
      {
        query: parsed.query,
        kind,
        matches: selected,
        truncated: walked.truncated || matches.length > selected.length
      },
      null,
      2
    );
    const truncated = truncateMiddle(content, maxChars);
    return {
      ok: true,
      content: truncated.text,
      metadata: {
        matches: selected,
        truncated: walked.truncated || matches.length > selected.length || truncated.truncated
      }
    };
  } catch (error) {
    return { ok: false, content: error instanceof Error ? error.message : String(error) };
  }
}
