import { constants as fsConstants, type BigIntStats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import { lexicalTokens } from "./unicode.js";

const orientationFiles = new Set([
  "cargo.toml", "go.mod", "package.json", "pom.xml", "pyproject.toml", "readme.md",
  "requirements.txt", "workspace.json"
]);
const manifestFiles = new Set([
  "build.gradle", "build.gradle.kts", "cargo.toml", "cmakelists.txt", "composer.json",
  "deno.json", "deno.jsonc", "flake.nix", "gemfile", "go.mod", "go.work", "makefile", "mix.exs",
  "package.json", "pnpm-workspace.yaml", "pom.xml", "pyproject.toml", "requirements.txt",
  "settings.gradle", "settings.gradle.kts", "tsconfig.json", "workspace.json"
]);
const languageByExtension = new Map([
  [".c", "C"], [".cc", "C++"], [".cpp", "C++"], [".cs", "C#"], [".cxx", "C++"],
  [".css", "CSS"], [".dart", "Dart"], [".ex", "Elixir"], [".exs", "Elixir"],
  [".fs", "F#"], [".fsx", "F#"],
  [".go", "Go"], [".h", "C/C++"], [".hpp", "C++"], [".java", "Java"],
  [".html", "HTML"], [".js", "JavaScript"], [".jsx", "JavaScript"], [".kt", "Kotlin"], [".kts", "Kotlin"],
  [".lua", "Lua"],
  [".mjs", "JavaScript"], [".php", "PHP"], [".py", "Python"], [".r", "R"], [".rb", "Ruby"],
  [".rs", "Rust"], [".scala", "Scala"], [".sh", "Shell"], [".sql", "SQL"],
  [".swift", "Swift"], [".ts", "TypeScript"], [".tsx", "TypeScript"],
  [".vb", "Visual Basic"], [".vue", "Vue"], [".zig", "Zig"]
]);
const MAX_STRUCTURE_GROUPS = 20;
const MAX_MANIFEST_PATHS = 40;
const fatalUtf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export interface RepositorySnapshot {
  files: string[];
  diff: string;
  truncated: boolean;
  source: "git" | "host";
}

export interface StableTextRead {
  content: string | null;
  rejected: boolean;
}

export interface MetadataBudget {
  signal: AbortSignal;
  deadline?: number;
}

export interface RankedFilesResult {
  values: Array<{ file: string; score: number; orientation: number }>;
  budgetExceeded: boolean;
}

export interface StructureSummaryResult {
  lines: string[];
  budgetExceeded: boolean;
}

export function repositoryLanguage(file: string): string | undefined {
  return languageByExtension.get(path.posix.extname(file).toLowerCase());
}

function stableReadFlags(): number {
  const noFollow = Reflect.get(fsConstants, "O_NOFOLLOW");
  return fsConstants.O_RDONLY | (typeof noFollow === "number" ? noFollow : 0);
}

function sameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameStableFileState(left: BigIntStats, right: BigIntStats): boolean {
  return sameFileIdentity(left, right) && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

async function stablePathState(target: string): Promise<BigIntStats | null> {
  return await lstat(target, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
    throw error;
  });
}

function acceptableStableFile(state: BigIntStats, maxBytes: number): boolean {
  return state.isFile() && !state.isSymbolicLink()
    && state.nlink === 1n && state.size <= BigInt(maxBytes);
}

export async function captureStableBoundedTextState(
  target: string,
  maxBytes: number
): Promise<BigIntStats | null> {
  const state = await stablePathState(target).catch(() => null);
  return state && acceptableStableFile(state, maxBytes) ? state : null;
}

async function readExpectedBytes(
  handle: Awaited<ReturnType<typeof open>>,
  expectedBytes: number,
  maxBytes: number,
  signal: AbortSignal
): Promise<Buffer | null> {
  const capacity = Math.min(maxBytes + 1, Math.max(1, expectedBytes + 1));
  const buffer = Buffer.alloc(capacity);
  let offset = 0;
  while (offset < buffer.length) {
    signal.throwIfAborted();
    const result = await handle.read(buffer, offset, buffer.length - offset, offset);
    if (result.bytesRead === 0) break;
    offset += result.bytesRead;
  }
  return offset === expectedBytes ? buffer.subarray(0, offset) : null;
}

async function readVerifiedHandle(
  handle: Awaited<ReturnType<typeof open>>,
  target: string,
  pathBefore: BigIntStats,
  maxBytes: number,
  signal: AbortSignal
): Promise<StableTextRead> {
  signal.throwIfAborted();
  const openedBefore = await handle.stat({ bigint: true });
  if (!acceptableStableFile(openedBefore, maxBytes)
    || !sameStableFileState(pathBefore, openedBefore)) {
    return { content: null, rejected: true };
  }
  const bytes = await readExpectedBytes(handle, Number(openedBefore.size), maxBytes, signal);
  signal.throwIfAborted();
  const [openedAfter, pathAfter] = await Promise.all([
    handle.stat({ bigint: true }),
    stablePathState(target).catch(() => null)
  ]);
  if (!bytes || !pathAfter || !acceptableStableFile(pathAfter, maxBytes)
    || !sameStableFileState(openedBefore, openedAfter)
    || !sameStableFileState(openedAfter, pathAfter)) {
    return { content: null, rejected: true };
  }
  try {
    return {
      content: fatalUtf8Decoder.decode(bytes),
      rejected: false
    };
  } catch {
    return { content: null, rejected: true };
  }
}

export async function readStableBoundedText(
  target: string,
  maxBytes: number,
  signal: AbortSignal,
  expectedState?: BigIntStats
): Promise<StableTextRead> {
  let pathBefore: BigIntStats | null;
  try {
    pathBefore = await stablePathState(target);
  } catch {
    return { content: null, rejected: true };
  }
  if (!pathBefore) return { content: null, rejected: false };
  if (!acceptableStableFile(pathBefore, maxBytes)) return { content: null, rejected: true };
  if (expectedState && !sameStableFileState(expectedState, pathBefore)) {
    return { content: null, rejected: true };
  }
  let handle;
  try {
    handle = await open(target, stableReadFlags());
  } catch {
    return { content: null, rejected: true };
  }
  try {
    return await readVerifiedHandle(handle, target, pathBefore, maxBytes, signal);
  } finally {
    await handle.close();
  }
}

function orientationPriority(file: string): number {
  const normalized = file.split("/");
  const basename = normalized.at(-1)?.toLowerCase() ?? "";
  if (normalized.length === 1 && orientationFiles.has(basename)) return 3;
  if (normalized.length === 1) return 2;
  if (orientationFiles.has(basename)) return 1;
  return 0;
}

export function rankedFiles(
  files: string[],
  query: string,
  limit: number,
  budget: MetadataBudget
): RankedFilesResult {
  const queryTokens = lexicalTokens(query);
  const heap: Array<{ file: string; score: number; orientation: number }> = [];
  let budgetExceeded = false;
  const rankOrder = (left: typeof heap[number], right: typeof heap[number]): number =>
    right.score - left.score || right.orientation - left.orientation
      || left.file.localeCompare(right.file);
  const score = (file: string): number => {
    if (queryTokens.length === 0) return 0;
    const documentTokens = new Set(lexicalTokens(file));
    let matched = 0;
    for (const token of queryTokens) if (documentTokens.has(token)) matched += 1;
    return matched / queryTokens.length;
  };
  const bubbleUp = (start: number): void => {
    let index = start;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (rankOrder(heap[index]!, heap[parent]!) <= 0) break;
      [heap[index], heap[parent]] = [heap[parent]!, heap[index]!];
      index = parent;
    }
  };
  const bubbleDown = (): void => {
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let worst = index;
      if (left < heap.length && rankOrder(heap[left]!, heap[worst]!) > 0) worst = left;
      if (right < heap.length && rankOrder(heap[right]!, heap[worst]!) > 0) worst = right;
      if (worst === index) return;
      [heap[index], heap[worst]] = [heap[worst]!, heap[index]!];
      index = worst;
    }
  };
  for (let index = 0; index < files.length; index += 1) {
    if ((index & 63) === 0) {
      budget.signal.throwIfAborted();
      if (budget.deadline !== undefined && performance.now() >= budget.deadline) {
        budgetExceeded = true;
        break;
      }
    }
    const file = files[index]!;
    const candidate = { file, score: score(file), orientation: orientationPriority(file) };
    if (heap.length < limit) {
      heap.push(candidate);
      bubbleUp(heap.length - 1);
    } else if (limit > 0 && rankOrder(candidate, heap[0]!) < 0) {
      heap[0] = candidate;
      bubbleDown();
    }
  }
  budget.signal.throwIfAborted();
  return { values: heap.sort(rankOrder), budgetExceeded };
}

function incrementCount(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function sortedCounts(counts: Map<string, number>): Array<[string, number]> {
  return [...counts].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
}

function manifestPath(file: string): boolean {
  const basename = file.split("/").at(-1)?.toLowerCase() ?? "";
  return manifestFiles.has(basename) || /\.(?:csproj|fsproj|sln|vbproj)$/u.test(basename);
}

export function escaped(value: string): string {
  return JSON.stringify(value);
}

interface StructureData {
  topLevel: Map<string, number>;
  extensions: Map<string, number>;
  manifests: string[];
  manifestCount: number;
  budgetExceeded: boolean;
}

function retainManifest(manifests: string[], file: string): void {
  if (manifests.length < MAX_MANIFEST_PATHS) {
    manifests.push(file);
    return;
  }
  let largest = 0;
  for (let index = 1; index < manifests.length; index += 1) {
    if (manifests[index]!.localeCompare(manifests[largest]!) > 0) largest = index;
  }
  if (file.localeCompare(manifests[largest]!) < 0) manifests[largest] = file;
}

function collectStructure(files: string[], budget: MetadataBudget): StructureData {
  const topLevel = new Map<string, number>();
  const extensions = new Map<string, number>();
  const manifests: string[] = [];
  let manifestCount = 0;
  for (let index = 0; index < files.length; index += 1) {
    if ((index & 255) === 0) {
      budget.signal.throwIfAborted();
      if (budget.deadline !== undefined && performance.now() >= budget.deadline) {
        return { topLevel, extensions, manifests, manifestCount, budgetExceeded: true };
      }
    }
    const file = files[index]!;
    const segments = file.split("/");
    incrementCount(topLevel, segments.length === 1 ? "(root)" : segments[0]!);
    incrementCount(extensions, path.posix.extname(file).toLowerCase() || "(none)");
    if (manifestPath(file)) {
      manifestCount += 1;
      retainManifest(manifests, file);
    }
  }
  budget.signal.throwIfAborted();
  return { topLevel, extensions, manifests, manifestCount, budgetExceeded: false };
}

function countLines(counts: Map<string, number>): string[] {
  const groups = sortedCounts(counts).slice(0, MAX_STRUCTURE_GROUPS);
  if (groups.length === 0) return ["- (empty)"];
  return groups.map(([name, count]) => `- ${escaped(name)}: ${count} files`);
}

function extensionLines(counts: Map<string, number>): string[] {
  const groups = sortedCounts(counts).slice(0, MAX_STRUCTURE_GROUPS);
  if (groups.length === 0) return ["- (empty)"];
  return groups.map(([extension, count]) => {
    const language = languageByExtension.get(extension);
    return `- ${escaped(extension)}${language ? ` (${language})` : ""}: ${count} files`;
  });
}

export function structureSummary(files: string[], budget: MetadataBudget): StructureSummaryResult {
  const data = collectStructure(files, budget);
  data.manifests.sort((left, right) => left.localeCompare(right));
  const lines = [
    data.budgetExceeded
      ? "Repository structure (partial; host context budget exhausted):"
      : "Repository structure (derived only from escaped path metadata):",
    "Top-level distribution:"
  ];
  lines.push(...countLines(data.topLevel));
  lines.push("Extension/language distribution:");
  lines.push(...extensionLines(data.extensions));
  const cutoff = data.budgetExceeded ? " observed before cutoff" : "";
  lines.push(`Detected manifests (${data.manifestCount}${cutoff}):`);
  lines.push(...(data.manifests.length > 0
    ? data.manifests.map((file) => `- ${escaped(file)}`) : ["- (none)"]));
  if (data.manifestCount > MAX_MANIFEST_PATHS) {
    lines.push(`- (${data.manifestCount - MAX_MANIFEST_PATHS} more manifest paths omitted)`);
  }
  return { lines, budgetExceeded: data.budgetExceeded };
}
