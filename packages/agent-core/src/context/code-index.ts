import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { ToolExecutionContext } from "../types.js";
import { workspaceRelativePath } from "../policy.js";
import {
  explicitPathIncludesIgnored,
  resolveWorkspaceRelativePath,
  walkFiles,
  type WalkFile
} from "../tools/workspace-utils.js";
import { parseWithTreeSitter } from "./tree-sitter-provider.js";

export type CodeSymbolKind = "function" | "class" | "interface" | "type" | "const" | "method" | "test" | "unknown";

export interface CodeSymbol {
  name: string;
  kind: CodeSymbolKind;
  line: number;
  exported: boolean;
}

export interface CodeIndexFile {
  path: string;
  absolutePath: string;
  size: number;
  mtimeMs: number;
  ext: string;
  language: string;
  symbols: CodeSymbol[];
  imports: string[];
  isTest: boolean;
  isConfig: boolean;
}

export interface CodeIndex {
  workspacePath: string;
  rootPath: string;
  files: CodeIndexFile[];
  truncated: boolean;
  generatedAt: string;
}

export interface BuildCodeIndexOptions {
  workspacePath: string;
  path?: string;
  maxFiles?: number;
  maxFileBytes?: number;
}

const DEFAULT_MAX_FILES = 20000;
const DEFAULT_MAX_FILE_BYTES = 256000;

const CONFIG_BASE_NAMES = new Set([
  "package.json",
  "tsconfig.json",
  "jsconfig.json",
  "pyproject.toml",
  "requirements.txt",
  "setup.py",
  "pytest.ini",
  "go.mod",
  "Cargo.toml",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "Makefile",
  "makefile",
  "eslint.config.js",
  "vite.config.ts",
  "vitest.config.ts"
]);

function languageForPath(filePath: string): string {
  const ext = path.posix.extname(filePath).toLowerCase();
  const base = path.posix.basename(filePath);
  if (base === "Makefile" || base === "makefile") return "make";
  const mapping: Record<string, string> = {
    ".ts": "typescript",
    ".tsx": "typescript",
    ".js": "javascript",
    ".jsx": "javascript",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".py": "python",
    ".go": "go",
    ".rs": "rust",
    ".java": "java",
    ".kt": "kotlin",
    ".kts": "kotlin",
    ".json": "json",
    ".toml": "toml",
    ".yaml": "yaml",
    ".yml": "yaml",
    ".md": "markdown",
    ".sh": "shell"
  };
  return mapping[ext] ?? (ext.replace(/^\./, "") || "text");
}

function isBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, Math.min(buffer.length, 4096)).includes(0);
}

export function isTestPath(filePath: string): boolean {
  return /(^|\/)(test|tests|__tests__)(\/|$)|[._-](test|spec)\.[A-Za-z0-9]+$/.test(filePath);
}

export function isConfigPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  const base = normalized.split("/").pop() ?? normalized;
  return CONFIG_BASE_NAMES.has(base) ||
    /(^|\/)\.(github|agent|vscode|config)(\/|$)/.test(normalized) ||
    /(^|\/)(eslint|prettier|vitest|vite|webpack|rollup|babel|jest|mocha|pytest|ruff|mypy|tsup|turbo|nx)\.config\./i.test(normalized);
}

function pushSymbol(symbols: CodeSymbol[], match: RegExpMatchArray | null, kind: CodeSymbolKind, line: number): void {
  if (!match) return;
  const name = match[1] ?? match[2];
  if (!name) return;
  symbols.push({
    name,
    kind,
    line,
    exported: /\bexport\b/.test(match[0])
  });
}

function parseSymbolsAndImports(text: string, language: string, filePath = ""): { symbols: CodeSymbol[]; imports: string[] } {
  const treeSitterParsed = parseWithTreeSitter({ filePath, language, text });
  if (treeSitterParsed) return treeSitterParsed;
  const symbols: CodeSymbol[] = [];
  const imports = new Set<string>();
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lineNo = index + 1;

    if (language === "typescript" || language === "javascript") {
      pushSymbol(symbols, line.match(/^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/), "function", lineNo);
      pushSymbol(symbols, line.match(/^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)\b/), "class", lineNo);
      pushSymbol(symbols, line.match(/^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)\b/), "interface", lineNo);
      pushSymbol(symbols, line.match(/^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\b/), "type", lineNo);
      pushSymbol(symbols, line.match(/^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=/), "const", lineNo);
      pushSymbol(symbols, line.match(/^\s*(?:describe|it|test)\s*\(\s*["'`]([^"'`]+)["'`]/), "test", lineNo);
      const fromMatch = line.match(/\bfrom\s+["']([^"']+)["']/);
      const requireMatch = line.match(/\brequire\(\s*["']([^"']+)["']\s*\)/);
      if (fromMatch) imports.add(fromMatch[1]);
      if (requireMatch) imports.add(requireMatch[1]);
    } else if (language === "python") {
      pushSymbol(symbols, line.match(/^\s*def\s+([A-Za-z_]\w*)\s*\(/), "function", lineNo);
      pushSymbol(symbols, line.match(/^\s*class\s+([A-Za-z_]\w*)\b/), "class", lineNo);
      const importMatch = line.match(/^\s*(?:from\s+([A-Za-z0-9_.$]+)\s+import|import\s+([A-Za-z0-9_.$]+))/);
      if (importMatch) imports.add(importMatch[1] ?? importMatch[2]);
    } else if (language === "go") {
      pushSymbol(symbols, line.match(/^\s*func\s+(?:\([^)]+\)\s*)?([A-Za-z_]\w*)\s*\(/), "function", lineNo);
      pushSymbol(symbols, line.match(/^\s*type\s+([A-Za-z_]\w*)\s+(?:struct|interface)\b/), "type", lineNo);
      const importMatch = line.match(/^\s*import\s+(?:[A-Za-z_]\w*\s+)?["`]([^"`]+)["`]/);
      if (importMatch) imports.add(importMatch[1]);
    } else if (language === "rust") {
      pushSymbol(symbols, line.match(/^\s*(?:pub\s+)?fn\s+([A-Za-z_]\w*)\s*\(/), "function", lineNo);
      pushSymbol(symbols, line.match(/^\s*(?:pub\s+)?(?:struct|enum|trait)\s+([A-Za-z_]\w*)\b/), "type", lineNo);
      const useMatch = line.match(/^\s*use\s+([^;]+);/);
      if (useMatch) imports.add(useMatch[1]);
    }
  }
  return { symbols, imports: [...imports].sort((a, b) => a.localeCompare(b, "en")) };
}

async function indexFile(file: WalkFile, maxFileBytes: number): Promise<CodeIndexFile | null> {
  const info = await stat(file.absolutePath);
  const ext = path.posix.extname(file.relativePath).toLowerCase();
  const language = languageForPath(file.relativePath);
  let symbols: CodeSymbol[] = [];
  let imports: string[] = [];
  if (info.size <= maxFileBytes) {
    const buffer = await readFile(file.absolutePath);
    if (!isBinary(buffer)) {
      const parsed = parseSymbolsAndImports(buffer.toString("utf8"), language, file.relativePath);
      symbols = parsed.symbols;
      imports = parsed.imports;
    }
  }
  return {
    path: file.relativePath,
    absolutePath: file.absolutePath,
    size: info.size,
    mtimeMs: info.mtimeMs,
    ext,
    language,
    symbols,
    imports,
    isTest: isTestPath(file.relativePath),
    isConfig: isConfigPath(file.relativePath)
  };
}

export async function buildCodeIndex(options: BuildCodeIndexOptions): Promise<CodeIndex> {
  const workspacePath = path.resolve(options.workspacePath);
  const requestedPath = options.path ?? ".";
  const resolved = resolveWorkspaceRelativePath(workspacePath, requestedPath);
  const rootInfo = await stat(resolved.absolutePath);
  const walked = rootInfo.isFile()
    ? {
        files: [{ absolutePath: resolved.absolutePath, relativePath: workspaceRelativePath(workspacePath, resolved.absolutePath) }],
        truncated: false
      }
    : await walkFiles({
        workspacePath,
        rootPath: resolved.absolutePath,
        maxFiles: options.maxFiles ?? DEFAULT_MAX_FILES,
        explicitIncludesIgnored: explicitPathIncludesIgnored(resolved.relativePath)
      });
  const files: CodeIndexFile[] = [];
  for (const file of walked.files) {
    const indexed = await indexFile(file, options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES);
    if (indexed) files.push(indexed);
  }
  return {
    workspacePath,
    rootPath: resolved.absolutePath,
    files,
    truncated: walked.truncated,
    generatedAt: new Date().toISOString()
  };
}

export async function getCodeIndexForTool(
  context: ToolExecutionContext,
  options: Omit<BuildCodeIndexOptions, "workspacePath"> = {}
): Promise<CodeIndex> {
  const cacheKey = JSON.stringify({
    path: options.path ?? ".",
    maxFiles: options.maxFiles ?? DEFAULT_MAX_FILES,
    maxFileBytes: options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
    version: context.runState.contextIndexVersion ?? 0
  });
  context.runState.contextIndexes ??= new Map<string, unknown>();
  const cached = context.runState.contextIndexes.get(cacheKey);
  if (cached) return cached as CodeIndex;
  const index = await buildCodeIndex({ workspacePath: context.workspacePath, ...options });
  context.runState.contextIndexes.set(cacheKey, index);
  return index;
}

export function invalidateContextIndexes(context: ToolExecutionContext): void {
  context.runState.contextIndexVersion = (context.runState.contextIndexVersion ?? 0) + 1;
  context.runState.contextIndexes?.clear();
}
