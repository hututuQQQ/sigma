import path from "node:path";
import { compileRepositoryGlob } from "./repository-glob.js";
import {
  BoundedRegexMatcher,
  literalLineMatches,
  MAX_REPOSITORY_REGEX_CHARACTERS,
  type RepositoryLineMatch
} from "./repository-regex-search.js";
import { withHostRepositorySnapshot } from "./repository-host-snapshot.js";
import type { RepositorySnapshot } from "./repository-path-metadata.js";
import type { RepositorySnapshotAccess } from "./repository-snapshot-access.js";
import { normalizedSafeRepositoryPath } from "./repository-scope.js";

const DEFAULT_DEADLINE_MS = 30_000;
const DEFAULT_MAX_FILE_BYTES = 2_000_000;
const DEFAULT_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_MATCHES = 5_000;
const MAX_LITERAL_QUERY_CHARACTERS = 65_536;
const MAX_GLOB_CHARACTERS = 512;

export interface RepositoryTextSearchOptions {
  query: string;
  path?: string;
  glob?: string;
  regex?: boolean;
  limit?: number;
  deadline?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  maxOutputBytes?: number;
}

export interface RepositoryTextMatch {
  file: string;
  line: number;
  text: string;
}

export interface RepositoryTextSearchResult {
  complete: boolean;
  truncated: boolean;
  snapshotFiles: number;
  candidateFiles: number;
  scannedFiles: number;
  skippedFiles: number;
  scannedBytes: number;
  outputBytes: number;
  matches: RepositoryTextMatch[];
  limitsReached: {
    snapshot: boolean;
    deadline: boolean;
    totalBytes: boolean;
    outputBytes: boolean;
    matches: boolean;
  };
  scope: {
    path: string;
    glob: string;
    exclusions: string;
    limits: {
      maxFileBytes: number;
      maxTotalBytes: number;
      maxOutputBytes: number;
      maxMatches: number;
      deadlineMs: number;
    };
  };
}

interface SearchState {
  matches: RepositoryTextMatch[];
  scannedFiles: number;
  skippedFiles: number;
  scannedBytes: number;
  outputBytes: number;
  deadlineReached: boolean;
  totalBytesReached: boolean;
  outputBytesReached: boolean;
  matchLimitReached: boolean;
}

interface ResolvedSearchOptions {
  query: string;
  regex: boolean;
  limit: number;
  deadline: number;
  deadlineMs: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  maxOutputBytes: number;
}

function boundedPositive(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(maximum, Math.floor(value)));
}

function lexicalOrder(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function formatRepositoryTextMatch(match: RepositoryTextMatch): string {
  return JSON.stringify({ file: match.file, line: match.line, text: match.text });
}

function selectedCandidates(
  files: string[],
  searchPath: string,
  glob: string,
  signal: AbortSignal,
  deadline: number
): { files: string[]; deadlineReached: boolean } {
  const prefix = searchPath === "." ? "" : `${searchPath}/`;
  const selected: string[] = [];
  const globMatches = glob ? compileRepositoryGlob(glob) : undefined;
  for (let index = 0; index < files.length; index += 1) {
    if ((index & 255) === 0) {
      signal.throwIfAborted();
      if (performance.now() >= deadline) return { files: selected, deadlineReached: true };
    }
    const file = files[index]!;
    if (searchPath !== "." && file !== searchPath && !file.startsWith(prefix)) continue;
    const globTarget = glob.includes("/") ? file : path.posix.basename(file);
    if (!globMatches || globMatches(globTarget)) selected.push(file);
  }
  selected.sort(lexicalOrder);
  return { files: selected, deadlineReached: performance.now() >= deadline };
}

function appendMatches(
  file: string,
  matches: RepositoryLineMatch[],
  maxOutputBytes: number,
  state: SearchState
): void {
  for (const match of matches) {
    const candidate = { file, line: match.line, text: match.text };
    const serializedBytes = Buffer.byteLength(formatRepositoryTextMatch(candidate), "utf8")
      + (state.matches.length > 0 ? 1 : 0);
    if (state.outputBytes + serializedBytes > maxOutputBytes) {
      state.outputBytesReached = true;
      return;
    }
    state.matches.push(candidate);
    state.outputBytes += serializedBytes;
  }
}

function emptySearchState(): SearchState {
  return {
    matches: [], scannedFiles: 0, skippedFiles: 0, scannedBytes: 0, outputBytes: 0,
    deadlineReached: false, totalBytesReached: false,
    outputBytesReached: false, matchLimitReached: false
  };
}

function preCandidateLimitReached(state: SearchState, options: ResolvedSearchOptions): boolean {
  if (state.deadlineReached || performance.now() >= options.deadline) {
    state.deadlineReached = true;
    return true;
  }
  if (state.scannedBytes >= options.maxTotalBytes) {
    state.totalBytesReached = true;
    return true;
  }
  return false;
}

async function searchCandidate(
  access: RepositorySnapshotAccess,
  file: string,
  options: ResolvedSearchOptions,
  matcher: BoundedRegexMatcher | undefined,
  state: SearchState,
  signal: AbortSignal
): Promise<boolean> {
  signal.throwIfAborted();
  if (preCandidateLimitReached(state, options)) return true;
  const loaded = await access.readText(file, options.maxFileBytes, signal);
  if (performance.now() >= options.deadline) {
    state.deadlineReached = true;
    return true;
  }
  if (loaded.rejected || loaded.content === null || loaded.content.includes("\0")) {
    state.skippedFiles += 1;
    return false;
  }
  const bytes = Buffer.byteLength(loaded.content, "utf8");
  if (state.scannedBytes + bytes > options.maxTotalBytes) {
    state.totalBytesReached = true;
    return true;
  }
  state.scannedBytes += bytes;
  state.scannedFiles += 1;
  const remainingMatches = Math.max(0, options.limit - state.matches.length);
  const outcome = matcher
    ? await matcher.search(loaded.content, remainingMatches, options.deadline, signal)
    : literalLineMatches(loaded.content, options.query, remainingMatches, options.deadline, signal);
  appendMatches(file, outcome.matches, options.maxOutputBytes, state);
  state.deadlineReached ||= outcome.deadlineReached;
  state.matchLimitReached ||= outcome.limitReached;
  return state.deadlineReached || state.matchLimitReached || state.outputBytesReached;
}

async function finishCandidateSearch(
  matcher: BoundedRegexMatcher | undefined,
  state: SearchState,
  operationFailure: unknown
): Promise<SearchState> {
  let cleanupFailure: unknown;
  try {
    await matcher?.close();
  } catch (error) {
    cleanupFailure = error;
  }
  if (operationFailure !== undefined && cleanupFailure !== undefined) {
    throw new AggregateError(
      [operationFailure, cleanupFailure],
      "Repository search and regex-worker cleanup failed.",
      { cause: operationFailure instanceof Error ? operationFailure : undefined }
    );
  }
  if (operationFailure !== undefined) throw operationFailure;
  if (cleanupFailure !== undefined) throw cleanupFailure;
  return state;
}

async function searchCandidates(
  access: RepositorySnapshotAccess,
  files: string[],
  options: ResolvedSearchOptions,
  signal: AbortSignal
): Promise<SearchState> {
  const state = emptySearchState();
  const matcher = options.regex ? new BoundedRegexMatcher(options.query) : undefined;
  let operationFailure: unknown;
  try {
    if (matcher) {
      const initialized = await matcher.search("", 0, options.deadline, signal);
      if (initialized.deadlineReached) state.deadlineReached = true;
    }
    for (const file of files) {
      if (await searchCandidate(access, file, options, matcher, state, signal)) break;
    }
  } catch (error) {
    operationFailure = error;
  }
  return await finishCandidateSearch(matcher, state, operationFailure);
}

function resolvedOptions(
  options: RepositoryTextSearchOptions,
  started: number
): ResolvedSearchOptions {
  const requestedDeadline = options.deadline;
  const deadline = requestedDeadline !== undefined && Number.isFinite(requestedDeadline)
    ? requestedDeadline : started + DEFAULT_DEADLINE_MS;
  const regex = options.regex === true;
  if (regex && options.query.length > MAX_REPOSITORY_REGEX_CHARACTERS) {
    throw new Error(
      `Regex exceeds the ${MAX_REPOSITORY_REGEX_CHARACTERS}-character safety limit.`
    );
  }
  if (regex) {
    try {
      RegExp(options.query, "u");
    } catch (error) {
      throw new Error(
        `Invalid repository regex: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }
  }
  if (!regex && options.query.length > MAX_LITERAL_QUERY_CHARACTERS) {
    throw new Error(
      `Literal search query exceeds the ${MAX_LITERAL_QUERY_CHARACTERS}-character safety limit.`
    );
  }
  return {
    query: options.query,
    regex,
    limit: boundedPositive(options.limit, 500, MAX_MATCHES),
    deadline,
    deadlineMs: Math.max(1, Math.round(deadline - started)),
    maxFileBytes: boundedPositive(
      options.maxFileBytes, DEFAULT_MAX_FILE_BYTES, DEFAULT_MAX_FILE_BYTES
    ),
    maxTotalBytes: boundedPositive(
      options.maxTotalBytes, DEFAULT_MAX_TOTAL_BYTES, DEFAULT_MAX_TOTAL_BYTES
    ),
    maxOutputBytes: boundedPositive(
      options.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, DEFAULT_MAX_OUTPUT_BYTES
    )
  };
}

function completedSearchResult(
  snapshot: RepositorySnapshot,
  candidateFiles: number,
  state: SearchState,
  options: ResolvedSearchOptions,
  searchPath: string,
  glob: string
): RepositoryTextSearchResult {
  const limitsReached = {
    snapshot: snapshot.truncated,
    deadline: state.deadlineReached,
    totalBytes: state.totalBytesReached,
    outputBytes: state.outputBytesReached,
    matches: state.matchLimitReached
  };
  const truncated = Object.values(limitsReached).some(Boolean);
  return {
    complete: !truncated && state.skippedFiles === 0,
    truncated,
    snapshotFiles: snapshot.files.length,
    candidateFiles,
    scannedFiles: state.scannedFiles,
    skippedFiles: state.skippedFiles,
    scannedBytes: state.scannedBytes,
    outputBytes: state.outputBytes,
    matches: state.matches,
    limitsReached,
    scope: {
      path: searchPath,
      glob,
      exclusions: "Nested .gitignore rules plus hidden, generated, vendor, agent-control, sensitive, symbolic-link, directory reparse-point, hard-linked, oversized, and NUL-containing files.",
      limits: {
        maxFileBytes: options.maxFileBytes,
        maxTotalBytes: options.maxTotalBytes,
        maxOutputBytes: options.maxOutputBytes,
        maxMatches: options.limit,
        deadlineMs: options.deadlineMs
      }
    }
  };
}

async function searchSnapshot(
  snapshot: RepositorySnapshot,
  access: RepositorySnapshotAccess,
  searchPath: string,
  glob: string,
  options: ResolvedSearchOptions,
  signal: AbortSignal
): Promise<RepositoryTextSearchResult> {
  const candidates = selectedCandidates(
    snapshot.files, searchPath, glob, signal, options.deadline
  );
  const state = candidates.deadlineReached
    ? { ...emptySearchState(), deadlineReached: true }
    : await searchCandidates(access, candidates.files, options, signal);
  return completedSearchResult(
    snapshot, candidates.files.length, state, options, searchPath, glob
  );
}

export async function searchRepositoryText(
  workspace: string,
  signal: AbortSignal,
  options: RepositoryTextSearchOptions
): Promise<RepositoryTextSearchResult> {
  const started = performance.now();
  const resolved = resolvedOptions(options, started);
  const searchPath = await normalizedSafeRepositoryPath(
    workspace, options.path ?? ".", "search", signal
  );
  const glob = options.glob ?? "";
  if (glob.length > MAX_GLOB_CHARACTERS) {
    throw new Error(`Search glob exceeds the ${MAX_GLOB_CHARACTERS}-character safety limit.`);
  }
  const scanDeadline = Math.min(
    resolved.deadline, started + Math.max(1_000, resolved.deadlineMs * 0.4)
  );
  return await withHostRepositorySnapshot(
    workspace,
    signal,
    { deadline: scanDeadline },
    async (snapshot, access) => await searchSnapshot(
      snapshot, access, searchPath, glob, resolved, signal
    )
  );
}
