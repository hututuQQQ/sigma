import path from "node:path";
import { textLines } from "agent-platform";
import { withHostRepositorySnapshot } from "./repository-host-snapshot.js";
import type { RepositorySnapshotAccess } from "./repository-snapshot-access.js";
import {
  repositoryLanguage,
  type RepositorySnapshot
} from "./repository-path-metadata.js";

const DEFAULT_DEADLINE_MS = 30_000;
const DEFAULT_MAX_FILE_BYTES = 2_000_000;
const DEFAULT_MAX_TOTAL_BYTES = 256 * 1024 * 1024;

export interface RepositoryStatisticsOptions {
  deadline?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
}

export interface RepositoryLanguageStatistics {
  language: string;
  extensions: string[];
  files: number;
  physicalLines: number;
  nonBlankLines: number;
  bytes: number;
}

export interface RepositoryStatistics {
  complete: boolean;
  truncated: boolean;
  snapshotFiles: number;
  observedSourceFiles: number;
  skippedSourceFiles: number;
  totals: Omit<RepositoryLanguageStatistics, "language" | "extensions">;
  languages: RepositoryLanguageStatistics[];
  scope: {
    selection: string;
    exclusions: string;
    physicalLines: string;
    nonBlankLines: string;
    limits: { maxFileBytes: number; maxTotalBytes: number; deadlineMs: number };
  };
}

interface MutableLanguageStatistics {
  language: string;
  extensions: Set<string>;
  files: number;
  physicalLines: number;
  nonBlankLines: number;
  bytes: number;
}

function boundedPositive(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(maximum, Math.floor(value)));
}

function lineMetrics(content: string): { physicalLines: number; nonBlankLines: number } {
  let physicalLines = 0;
  let nonBlankLines = 0;
  for (const line of textLines(content)) {
    physicalLines += 1;
    if (line.text.trim().length > 0) nonBlankLines += 1;
  }
  return { physicalLines, nonBlankLines };
}

function aggregate(
  groups: Map<string, MutableLanguageStatistics>,
  language: string,
  extension: string,
  bytes: number,
  metrics: ReturnType<typeof lineMetrics>
): void {
  const group = groups.get(language) ?? {
    language, extensions: new Set<string>(), files: 0, physicalLines: 0, nonBlankLines: 0, bytes: 0
  };
  group.extensions.add(extension);
  group.files += 1;
  group.physicalLines += metrics.physicalLines;
  group.nonBlankLines += metrics.nonBlankLines;
  group.bytes += bytes;
  groups.set(language, group);
}

function finalized(groups: Map<string, MutableLanguageStatistics>): RepositoryLanguageStatistics[] {
  return [...groups.values()].map((group) => ({
    ...group,
    extensions: [...group.extensions].sort((left, right) => left.localeCompare(right))
  })).sort((left, right) => right.nonBlankLines - left.nonBlankLines
    || right.files - left.files || left.language.localeCompare(right.language));
}

function totals(languages: RepositoryLanguageStatistics[]): RepositoryStatistics["totals"] {
  return languages.reduce((sum, language) => ({
    files: sum.files + language.files,
    physicalLines: sum.physicalLines + language.physicalLines,
    nonBlankLines: sum.nonBlankLines + language.nonBlankLines,
    bytes: sum.bytes + language.bytes
  }), { files: 0, physicalLines: 0, nonBlankLines: 0, bytes: 0 });
}

function sourceCandidates(
  files: string[],
  signal: AbortSignal,
  deadline: number
): { values: Array<{ file: string; language: string }>; truncated: boolean } {
  const values: Array<{ file: string; language: string }> = [];
  for (let index = 0; index < files.length; index += 1) {
    if ((index & 255) === 0) signal.throwIfAborted();
    if (performance.now() >= deadline) return { values, truncated: true };
    const file = files[index]!;
    const language = repositoryLanguage(file);
    if (language) values.push({ file, language });
  }
  return { values, truncated: false };
}

export async function collectRepositoryStatistics(
  workspace: string,
  signal: AbortSignal,
  options: RepositoryStatisticsOptions = {}
): Promise<RepositoryStatistics> {
  const started = performance.now();
  const deadline = options.deadline ?? started + DEFAULT_DEADLINE_MS;
  const deadlineMs = Math.max(1, Math.round(deadline - started));
  const maxFileBytes = boundedPositive(
    options.maxFileBytes, DEFAULT_MAX_FILE_BYTES, DEFAULT_MAX_FILE_BYTES
  );
  const maxTotalBytes = boundedPositive(
    options.maxTotalBytes, DEFAULT_MAX_TOTAL_BYTES, DEFAULT_MAX_TOTAL_BYTES
  );
  const scanDeadline = Math.min(deadline, started + Math.max(1_000, deadlineMs * 0.4));
  return await withHostRepositorySnapshot(
    workspace,
    signal,
    { deadline: scanDeadline },
    async (snapshot, access) => await statisticsFromSnapshot(
      snapshot,
      access,
      signal,
      { deadline, deadlineMs, maxFileBytes, maxTotalBytes }
    )
  );
}

async function statisticsFromSnapshot(
  snapshot: RepositorySnapshot,
  access: RepositorySnapshotAccess,
  signal: AbortSignal,
  bounds: {
    deadline: number;
    deadlineMs: number;
    maxFileBytes: number;
    maxTotalBytes: number;
  }
): Promise<RepositoryStatistics> {
  const { deadline, deadlineMs, maxFileBytes, maxTotalBytes } = bounds;
  const groups = new Map<string, MutableLanguageStatistics>();
  const candidates = sourceCandidates(snapshot.files, signal, deadline);
  const sourceFiles = candidates.values;
  let totalBytes = 0;
  let truncated = snapshot.truncated || candidates.truncated;
  for (const { file, language } of sourceFiles) {
    signal.throwIfAborted();
    if (performance.now() >= deadline || totalBytes >= maxTotalBytes) {
      truncated = true;
      break;
    }
    const loaded = await access.readText(file, maxFileBytes, signal);
    if (performance.now() >= deadline) {
      truncated = true;
      break;
    }
    if (loaded.rejected || loaded.content === null || loaded.content.includes("\0")) {
      continue;
    }
    const bytes = Buffer.byteLength(loaded.content, "utf8");
    if (totalBytes + bytes > maxTotalBytes) {
      truncated = true;
      break;
    }
    totalBytes += bytes;
    aggregate(
      groups, language, path.posix.extname(file).toLowerCase(), bytes, lineMetrics(loaded.content)
    );
  }
  const languages = finalized(groups);
  const summarized = totals(languages);
  const skippedSourceFiles = Math.max(0, sourceFiles.length - summarized.files);
  const complete = !truncated && skippedSourceFiles === 0;
  return {
    complete,
    truncated,
    snapshotFiles: snapshot.files.length,
    observedSourceFiles: sourceFiles.length,
    skippedSourceFiles,
    totals: summarized,
    languages,
    scope: {
      selection: "Files with recognized source-code extensions under the workspace root.",
      exclusions: "Nested .gitignore rules plus standard hidden, generated, vendor, agent-control, and sensitive paths.",
      physicalLines: "Text lines, including blank and comment-only lines; a final unterminated line counts once.",
      nonBlankLines: "Physical lines containing at least one non-whitespace character; comments are not removed.",
      limits: { maxFileBytes, maxTotalBytes, deadlineMs }
    }
  };
}
