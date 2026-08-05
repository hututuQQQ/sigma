import path from "node:path";
import { parseRepositoryCodeFile, type RepositoryCodeFile } from "./repository-code-parser.js";
import { repositoryLanguage, type StableTextRead } from "./repository-path-metadata.js";
import { safeAutomaticFilePath } from "./repository-path-safety.js";
import { readStableWorkspaceText } from "./repository-safe-read.js";
import { lexicalScore } from "./unicode.js";

const MAX_INDEXED_SOURCE_FILES = 768;
const MAX_SOURCE_FILE_BYTES = 128 * 1024;
const MAX_TOTAL_SOURCE_BYTES = 48 * 1024 * 1024;
const SOURCE_SCAN_CONCURRENCY = 16;
export const REPOSITORY_CODE_INDEX_BUDGET_MS = 1_500;

const entrypointNames = new Set([
  "__init__", "app", "client", "core", "index", "lib", "main", "mod", "server"
]);

export interface RepositoryCodeIndex {
  files: Map<string, RepositoryCodeFile>;
  eligibleFiles: number;
  scannedFiles: number;
  sourceBytes: number;
  truncated: boolean;
}

export interface BuildRepositoryCodeIndexOptions {
  workspace: string;
  repositoryFiles: readonly string[];
  query: string;
  focusPaths?: readonly string[];
  previous?: RepositoryCodeIndex;
  readText?: (file: string, maxBytes: number, signal: AbortSignal) => Promise<StableTextRead>;
  signal: AbortSignal;
  deadline?: number;
}

interface SourceCandidate {
  file: string;
  focus: number;
  query: number;
  role: number;
}

function normalizedFocusPaths(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.replaceAll("\\", "/").replace(/^\.\//u, "")))]
    .filter((value) => value && value !== ".git" && !value.startsWith(".git/"));
}

function focusPriority(file: string, focusPaths: readonly string[]): number {
  let score = 0;
  for (const focus of focusPaths) {
    if (focus === "." || file === focus) score = Math.max(score, 4);
    else if (file.startsWith(`${focus.replace(/\/$/u, "")}/`)) score = Math.max(score, 3);
    else if (path.posix.dirname(file) === path.posix.dirname(focus)) score = Math.max(score, 1);
  }
  return score;
}

function sourceRolePriority(file: string): number {
  const basename = path.posix.basename(file, path.posix.extname(file)).toLowerCase();
  const parts = file.toLowerCase().split("/");
  let score = entrypointNames.has(basename) ? 4 : 0;
  if (parts.includes("src") || parts.includes("lib") || parts.includes("app")) score += 2;
  if (parts.length <= 2) score += 1;
  if (/\.(?:test|spec)$/u.test(basename)) score -= 1;
  return score;
}

function indexableSource(file: string): boolean {
  if (!safeAutomaticFilePath(file) || !repositoryLanguage(file)) return false;
  const basename = path.posix.basename(file).toLowerCase();
  return !basename.includes(".min.") && !basename.endsWith(".d.ts");
}

function sourceCandidates(
  files: readonly string[],
  query: string,
  focusPaths: readonly string[]
): SourceCandidate[] {
  return files.filter(indexableSource).map((file) => ({
    file,
    focus: focusPriority(file, focusPaths),
    query: lexicalScore(query, file),
    role: sourceRolePriority(file)
  })).sort((left, right) => right.focus - left.focus || right.query - left.query
    || right.role - left.role || left.file.localeCompare(right.file));
}

function affectedByFocus(file: string, focusPaths: readonly string[]): boolean {
  if (focusPaths.length === 0) return false;
  return focusPaths.some((focus) => focus === "." || file === focus
    || file.startsWith(`${focus.replace(/\/$/u, "")}/`));
}

function reusableFiles(
  previous: RepositoryCodeIndex | undefined,
  repositoryFiles: ReadonlySet<string>,
  focusPaths: readonly string[]
): Map<string, RepositoryCodeFile> {
  const result = new Map<string, RepositoryCodeFile>();
  for (const [file, record] of previous?.files ?? []) {
    if (repositoryFiles.has(file) && !affectedByFocus(file, focusPaths)) result.set(file, record);
  }
  return result;
}

function sourceBytes(files: ReadonlyMap<string, RepositoryCodeFile>): number {
  let total = 0;
  for (const file of files.values()) total += file.byteLength;
  return total;
}

async function scanSource(
  options: BuildRepositoryCodeIndexOptions,
  repositoryFiles: ReadonlySet<string>,
  candidate: string
): Promise<RepositoryCodeFile | undefined> {
  const loaded = options.readText
    ? await options.readText(candidate, MAX_SOURCE_FILE_BYTES, options.signal)
    : await readStableWorkspaceText(
        options.workspace, candidate, MAX_SOURCE_FILE_BYTES, options.signal
      );
  if (!loaded.content || loaded.content.includes("\0")) return undefined;
  return parseRepositoryCodeFile(candidate, loaded.content, repositoryFiles);
}

async function fillIndex(
  options: BuildRepositoryCodeIndexOptions,
  repositoryFiles: ReadonlySet<string>,
  candidates: readonly string[],
  indexed: Map<string, RepositoryCodeFile>,
  deadline: number
): Promise<{ bytes: number; deadlineReached: boolean }> {
  let bytes = sourceBytes(indexed);
  let cursor = 0;
  let deadlineReached = false;
  const worker = async (): Promise<void> => {
    while (cursor < candidates.length && bytes < MAX_TOTAL_SOURCE_BYTES) {
      options.signal.throwIfAborted();
      if (performance.now() >= deadline) {
        deadlineReached = true;
        return;
      }
      const file = candidates[cursor++]!;
      const record = await scanSource(options, repositoryFiles, file);
      if (!record) continue;
      indexed.set(file, record);
      bytes += record.byteLength;
    }
  };
  const workers = Math.min(SOURCE_SCAN_CONCURRENCY, candidates.length);
  await Promise.all(Array.from({ length: workers }, worker));
  return { bytes, deadlineReached };
}

export async function buildRepositoryCodeIndex(
  options: BuildRepositoryCodeIndexOptions
): Promise<RepositoryCodeIndex> {
  const focusPaths = normalizedFocusPaths(options.focusPaths ?? []);
  const repositoryFiles = new Set(options.repositoryFiles);
  const candidates = sourceCandidates(options.repositoryFiles, options.query, focusPaths);
  const indexed = reusableFiles(options.previous, repositoryFiles, focusPaths);
  const selected = candidates.slice(0, MAX_INDEXED_SOURCE_FILES)
    .map((candidate) => candidate.file)
    .filter((file) => !indexed.has(file));
  const deadline = options.deadline ?? performance.now() + REPOSITORY_CODE_INDEX_BUDGET_MS;
  const result = await fillIndex(options, repositoryFiles, selected, indexed, deadline);
  options.signal.throwIfAborted();
  return {
    files: indexed,
    eligibleFiles: candidates.length,
    scannedFiles: indexed.size,
    sourceBytes: result.bytes,
    truncated: result.deadlineReached || indexed.size < candidates.length
  };
}
