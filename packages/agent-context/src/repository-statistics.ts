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
const DEFAULT_MAX_TOP_LEVEL_DIRECTORIES = 20;
const ROOT_DIRECTORY_KEY = "";

export interface RepositoryStatisticsOptions {
  deadline?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  maxTopLevelDirectories?: number;
}

export interface RepositoryLanguageStatistics {
  language: string;
  extensions: string[];
  files: number;
  physicalLines: number;
  nonBlankLines: number;
  bytes: number;
}

export interface RepositoryTopLevelDirectoryStatistics {
  kind: "root" | "directory" | "remainder";
  directory: string | null;
  files: number;
  physicalLines: number;
  nonBlankLines: number;
  bytes: number;
}

export interface RepositoryStatistics {
  complete: boolean;
  truncated: boolean;
  deadlineReached: boolean;
  snapshotFiles: number;
  observedSourceFiles: number;
  skippedSourceFiles: number;
  totals: Omit<RepositoryLanguageStatistics, "language" | "extensions">;
  languages: RepositoryLanguageStatistics[];
  topLevelDirectories: RepositoryTopLevelDirectoryStatistics[];
  omittedDirectories: number;
  scope: {
    selection: string;
    exclusions: string;
    topLevelDirectories: string;
    physicalLines: string;
    nonBlankLines: string;
    limits: {
      maxFileBytes: number;
      maxTotalBytes: number;
      maxTopLevelDirectories: number;
      deadlineMs: number;
    };
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

type MutableDirectoryStatistics = RepositoryTopLevelDirectoryStatistics;

interface StatisticsBounds {
  deadline: number;
  deadlineMs: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  maxTopLevelDirectories: number;
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

function stableTextOrder(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function addMetrics(
  group: Pick<MutableLanguageStatistics, "files" | "physicalLines" | "nonBlankLines" | "bytes">,
  bytes: number,
  metrics: ReturnType<typeof lineMetrics>
): void {
  group.files += 1;
  group.physicalLines += metrics.physicalLines;
  group.nonBlankLines += metrics.nonBlankLines;
  group.bytes += bytes;
}

function aggregateLanguage(
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
  addMetrics(group, bytes, metrics);
  groups.set(language, group);
}

function aggregateDirectory(
  groups: Map<string, MutableDirectoryStatistics>,
  file: string,
  bytes: number,
  metrics: ReturnType<typeof lineMetrics>
): void {
  const separator = file.indexOf("/");
  const key = separator < 0 ? ROOT_DIRECTORY_KEY : file.slice(0, separator);
  const group = groups.get(key) ?? {
    kind: separator < 0 ? "root" as const : "directory" as const,
    directory: separator < 0 ? null : key,
    files: 0,
    physicalLines: 0,
    nonBlankLines: 0,
    bytes: 0
  };
  addMetrics(group, bytes, metrics);
  groups.set(key, group);
}

function statisticsOrder(
  left: Pick<RepositoryLanguageStatistics, "nonBlankLines" | "files" | "physicalLines" | "bytes">,
  right: Pick<RepositoryLanguageStatistics, "nonBlankLines" | "files" | "physicalLines" | "bytes">
): number {
  return right.nonBlankLines - left.nonBlankLines
    || right.files - left.files
    || right.physicalLines - left.physicalLines
    || right.bytes - left.bytes;
}

function finalizedLanguages(
  groups: Map<string, MutableLanguageStatistics>
): RepositoryLanguageStatistics[] {
  return [...groups.values()].map((group) => ({
    ...group,
    extensions: [...group.extensions].sort(stableTextOrder)
  })).sort((left, right) => statisticsOrder(left, right)
    || stableTextOrder(left.language, right.language));
}

function combinedDirectoryStatistics(
  groups: RepositoryTopLevelDirectoryStatistics[]
): RepositoryTopLevelDirectoryStatistics {
  return groups.reduce<RepositoryTopLevelDirectoryStatistics>((sum, group) => ({
    kind: "remainder",
    directory: null,
    files: sum.files + group.files,
    physicalLines: sum.physicalLines + group.physicalLines,
    nonBlankLines: sum.nonBlankLines + group.nonBlankLines,
    bytes: sum.bytes + group.bytes
  }), {
    kind: "remainder",
    directory: null,
    files: 0,
    physicalLines: 0,
    nonBlankLines: 0,
    bytes: 0
  });
}

function finalizedDirectories(
  groups: Map<string, MutableDirectoryStatistics>,
  maximum: number
): { values: RepositoryTopLevelDirectoryStatistics[]; omittedDirectories: number } {
  const ranked = [...groups.values()].sort((left, right) => statisticsOrder(left, right)
    || stableTextOrder(left.directory ?? ROOT_DIRECTORY_KEY, right.directory ?? ROOT_DIRECTORY_KEY));
  if (ranked.length <= maximum) return { values: ranked, omittedDirectories: 0 };
  const retained = ranked.slice(0, maximum - 1);
  const omitted = ranked.slice(maximum - 1);
  const omittedDirectories = omitted.filter((group) => group.kind === "directory").length;
  return {
    values: [...retained, combinedDirectoryStatistics(omitted)],
    omittedDirectories
  };
}

function totals(languages: RepositoryLanguageStatistics[]): RepositoryStatistics["totals"] {
  return languages.reduce((sum, language) => ({
    files: sum.files + language.files,
    physicalLines: sum.physicalLines + language.physicalLines,
    nonBlankLines: sum.nonBlankLines + language.nonBlankLines,
    bytes: sum.bytes + language.bytes
  }), { files: 0, physicalLines: 0, nonBlankLines: 0, bytes: 0 });
}

function statisticsScope(bounds: StatisticsBounds): RepositoryStatistics["scope"] {
  return {
    selection: "Files with recognized source-code extensions under the workspace root. Deadline-limited runs expose no partial counts or aggregates.",
    exclusions: "Nested .gitignore rules plus standard hidden, generated, vendor, agent-control, sensitive, symbolic-link, directory reparse-point, and hard-linked source paths.",
    topLevelDirectories: `Accepted source files are grouped once by their first path segment. A root group has kind='root' and directory=null. Groups are ranked by non-blank lines, files, physical lines, and bytes (all descending), then by directory in lexical order. At most ${bounds.maxTopLevelDirectories} output groups are returned; a final kind='remainder', directory=null group occupies one slot and combines every group omitted from individual output. omittedDirectories counts only real directory groups combined there, not the root group.`,
    physicalLines: "Text lines, including blank and comment-only lines; a final unterminated line counts once.",
    nonBlankLines: "Physical lines containing at least one non-whitespace character; comments are not removed.",
    limits: {
      maxFileBytes: bounds.maxFileBytes,
      maxTotalBytes: bounds.maxTotalBytes,
      maxTopLevelDirectories: bounds.maxTopLevelDirectories,
      deadlineMs: bounds.deadlineMs
    }
  };
}

function deadlineStatistics(bounds: StatisticsBounds): RepositoryStatistics {
  return {
    complete: false,
    truncated: true,
    deadlineReached: true,
    snapshotFiles: 0,
    observedSourceFiles: 0,
    skippedSourceFiles: 0,
    totals: { files: 0, physicalLines: 0, nonBlankLines: 0, bytes: 0 },
    languages: [],
    topLevelDirectories: [],
    omittedDirectories: 0,
    scope: statisticsScope(bounds)
  };
}

function sourceCandidates(
  files: string[],
  signal: AbortSignal,
  deadline: number
): { values: Array<{ file: string; language: string }>; deadlineReached: boolean } {
  signal.throwIfAborted();
  if (performance.now() >= deadline) return { values: [], deadlineReached: true };
  const orderedFiles = [...files].sort(stableTextOrder);
  const values: Array<{ file: string; language: string }> = [];
  for (let index = 0; index < orderedFiles.length; index += 1) {
    if ((index & 255) === 0) signal.throwIfAborted();
    if (performance.now() >= deadline) return { values, deadlineReached: true };
    const file = orderedFiles[index]!;
    const language = repositoryLanguage(file);
    if (language) values.push({ file, language });
  }
  return { values, deadlineReached: false };
}

export async function collectRepositoryStatistics(
  workspace: string,
  signal: AbortSignal,
  options: RepositoryStatisticsOptions = {}
): Promise<RepositoryStatistics> {
  const started = performance.now();
  const deadline = options.deadline !== undefined && Number.isFinite(options.deadline)
    ? options.deadline : started + DEFAULT_DEADLINE_MS;
  const deadlineMs = Math.max(1, Math.round(deadline - started));
  const maxFileBytes = boundedPositive(
    options.maxFileBytes, DEFAULT_MAX_FILE_BYTES, DEFAULT_MAX_FILE_BYTES
  );
  const maxTotalBytes = boundedPositive(
    options.maxTotalBytes, DEFAULT_MAX_TOTAL_BYTES, DEFAULT_MAX_TOTAL_BYTES
  );
  const maxTopLevelDirectories = boundedPositive(
    options.maxTopLevelDirectories,
    DEFAULT_MAX_TOP_LEVEL_DIRECTORIES,
    DEFAULT_MAX_TOP_LEVEL_DIRECTORIES
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
      { deadline, deadlineMs, maxFileBytes, maxTotalBytes, maxTopLevelDirectories }
    )
  );
}

async function statisticsFromSnapshot(
  snapshot: RepositorySnapshot,
  access: RepositorySnapshotAccess,
  signal: AbortSignal,
  bounds: StatisticsBounds
): Promise<RepositoryStatistics> {
  const {
    deadline, maxFileBytes, maxTotalBytes, maxTopLevelDirectories
  } = bounds;
  const languageGroups = new Map<string, MutableLanguageStatistics>();
  const directoryGroups = new Map<string, MutableDirectoryStatistics>();
  const candidates = sourceCandidates(snapshot.files, signal, deadline);
  if (snapshot.deadlineReached || candidates.deadlineReached) return deadlineStatistics(bounds);
  const sourceFiles = candidates.values;
  let totalBytes = 0;
  let truncated = snapshot.truncated;
  let deadlineReached = false;
  for (const { file, language } of sourceFiles) {
    signal.throwIfAborted();
    if (performance.now() >= deadline) {
      deadlineReached = true;
      break;
    }
    if (totalBytes >= maxTotalBytes) {
      truncated = true;
      break;
    }
    const loaded = await access.readText(file, maxFileBytes, signal);
    if (performance.now() >= deadline) {
      deadlineReached = true;
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
    const metrics = lineMetrics(loaded.content);
    aggregateLanguage(
      languageGroups, language, path.posix.extname(file).toLowerCase(), bytes, metrics
    );
    aggregateDirectory(directoryGroups, file, bytes, metrics);
  }
  signal.throwIfAborted();
  if (deadlineReached || performance.now() >= deadline) return deadlineStatistics(bounds);
  const languages = finalizedLanguages(languageGroups);
  const directories = finalizedDirectories(directoryGroups, maxTopLevelDirectories);
  const summarized = totals(languages);
  const skippedSourceFiles = Math.max(0, sourceFiles.length - summarized.files);
  const complete = !truncated && skippedSourceFiles === 0;
  return {
    complete,
    truncated,
    deadlineReached: false,
    snapshotFiles: snapshot.files.length,
    observedSourceFiles: sourceFiles.length,
    skippedSourceFiles,
    totals: summarized,
    languages,
    topLevelDirectories: directories.values,
    omittedDirectories: directories.omittedDirectories,
    scope: statisticsScope(bounds)
  };
}
