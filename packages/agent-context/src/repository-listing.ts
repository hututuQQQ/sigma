import path from "node:path";
import { compileRepositoryGlob } from "./repository-glob.js";
import { withHostRepositorySnapshot } from "./repository-host-snapshot.js";
import type { RepositorySnapshot } from "./repository-path-metadata.js";
import { normalizedSafeRepositoryPath } from "./repository-scope.js";

const DEFAULT_DEADLINE_MS = 30_000;
const DEFAULT_ENTRY_LIMIT = 2_000;
export const MAX_REPOSITORY_LIST_ENTRIES = 20_000;
export const MAX_REPOSITORY_LIST_OUTPUT_BYTES = 64 * 1024;
const MAX_GLOB_CHARACTERS = 512;
const SUPPORTED_GLOB_SYNTAX = "literals, '/', '*', '?', and '**'";

type UnsupportedGlobConstruct =
  | "backslash separators"
  | "brace expansion"
  | "character classes"
  | "extended globs"
  | "leading negation";

function unsupportedGlobConstruct(pattern: string): UnsupportedGlobConstruct | undefined {
  if (pattern.includes("\\")) return "backslash separators";
  if (/[{}]/u.test(pattern)) return "brace expansion";
  if (/[[\]]/u.test(pattern)) return "character classes";
  if (/[@+!*?]\(/u.test(pattern)) return "extended globs";
  if (pattern.startsWith("!")) return "leading negation";
  return undefined;
}

function assertSupportedGlob(pattern: string): void {
  const construct = unsupportedGlobConstruct(pattern);
  if (!construct) return;
  throw Object.assign(new Error(
    `Unsupported list glob syntax: ${construct}; use ${SUPPORTED_GLOB_SYNTAX}.`
  ), { code: "unsupported_repository_glob_syntax" });
}

export interface RepositoryListOptions {
  path?: string;
  glob?: string;
  limit?: number;
  deadline?: number;
  maxOutputBytes?: number;
}

export interface RepositoryListResult {
  complete: boolean;
  truncated: boolean;
  snapshotFiles: number;
  matchedEntriesObserved: number;
  listedEntries: number;
  omittedEntriesAtLeast: number;
  outputBytes: number;
  entries: string[];
  limitsReached: {
    snapshot: boolean;
    deadline: boolean;
    entries: boolean;
    outputBytes: boolean;
  };
  scope: {
    path: string;
    glob: string;
    exclusions: string;
    limits: { maxEntries: number; maxOutputBytes: number; deadlineMs: number };
  };
}

interface ResolvedListOptions {
  path: string;
  glob: string;
  limit: number;
  deadline: number;
  deadlineMs: number;
  maxOutputBytes: number;
}

function boundedPositive(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(maximum, Math.floor(value)));
}

function lexicalOrder(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function formatRepositoryListEntry(file: string): string {
  return JSON.stringify(file);
}

function resolvedOptions(options: RepositoryListOptions, started: number): ResolvedListOptions {
  const requestedDeadline = options.deadline;
  const deadline = requestedDeadline !== undefined && Number.isFinite(requestedDeadline)
    ? requestedDeadline : started + DEFAULT_DEADLINE_MS;
  const glob = options.glob ?? "";
  if (glob.length > MAX_GLOB_CHARACTERS) {
    throw new Error(`List glob exceeds the ${MAX_GLOB_CHARACTERS}-character safety limit.`);
  }
  assertSupportedGlob(glob);
  return {
    path: options.path ?? ".",
    glob,
    limit: boundedPositive(options.limit, DEFAULT_ENTRY_LIMIT, MAX_REPOSITORY_LIST_ENTRIES),
    deadline,
    deadlineMs: Math.max(1, Math.round(deadline - started)),
    maxOutputBytes: boundedPositive(
      options.maxOutputBytes,
      MAX_REPOSITORY_LIST_OUTPUT_BYTES,
      MAX_REPOSITORY_LIST_OUTPUT_BYTES
    )
  };
}

function listSnapshot(
  snapshot: RepositorySnapshot,
  options: ResolvedListOptions,
  signal: AbortSignal
): RepositoryListResult {
  const prefix = options.path === "." ? "" : `${options.path}/`;
  const globMatches = options.glob ? compileRepositoryGlob(options.glob) : undefined;
  const ordered = [...snapshot.files].sort(lexicalOrder);
  const entries: string[] = [];
  let matchedEntriesObserved = 0;
  let outputBytes = 0;
  let deadlineReached = performance.now() >= options.deadline;
  let entryLimitReached = false;
  let outputLimitReached = false;
  for (const file of ordered) {
    signal.throwIfAborted();
    if (performance.now() >= options.deadline) {
      deadlineReached = true;
      break;
    }
    if (options.path !== "." && file !== options.path && !file.startsWith(prefix)) continue;
    const globTarget = options.glob.includes("/") ? file : path.posix.basename(file);
    if (globMatches && !globMatches(globTarget)) continue;
    matchedEntriesObserved += 1;
    if (entries.length >= options.limit) {
      entryLimitReached = true;
      break;
    }
    const line = formatRepositoryListEntry(file);
    const addition = Buffer.byteLength(line, "utf8") + (entries.length === 0 ? 0 : 1);
    if (outputBytes + addition > options.maxOutputBytes) {
      outputLimitReached = true;
      break;
    }
    entries.push(file);
    outputBytes += addition;
  }
  signal.throwIfAborted();
  deadlineReached ||= performance.now() >= options.deadline;
  const limitsReached = {
    snapshot: snapshot.truncated,
    deadline: deadlineReached,
    entries: entryLimitReached,
    outputBytes: outputLimitReached
  };
  const truncated = Object.values(limitsReached).some(Boolean);
  return {
    complete: !truncated,
    truncated,
    snapshotFiles: snapshot.files.length,
    matchedEntriesObserved,
    listedEntries: entries.length,
    omittedEntriesAtLeast: Math.max(0, matchedEntriesObserved - entries.length),
    outputBytes,
    entries,
    limitsReached,
    scope: {
      path: options.path,
      glob: options.glob,
      exclusions: "Nested .gitignore rules plus hidden, generated, vendor, agent-control, sensitive, symbolic-link, and directory reparse-point paths.",
      limits: {
        maxEntries: options.limit,
        maxOutputBytes: options.maxOutputBytes,
        deadlineMs: options.deadlineMs
      }
    }
  };
}

export async function listRepositoryFiles(
  workspace: string,
  signal: AbortSignal,
  options: RepositoryListOptions = {}
): Promise<RepositoryListResult> {
  const started = performance.now();
  const resolved = resolvedOptions(options, started);
  resolved.path = await normalizedSafeRepositoryPath(workspace, resolved.path, "list", signal);
  const scanDeadline = Math.min(
    resolved.deadline, started + Math.max(1_000, resolved.deadlineMs * 0.4)
  );
  return await withHostRepositorySnapshot(
    workspace,
    signal,
    { deadline: scanDeadline },
    async (snapshot) => listSnapshot(snapshot, resolved, signal)
  );
}
