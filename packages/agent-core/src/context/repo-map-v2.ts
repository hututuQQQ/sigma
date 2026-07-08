import path from "node:path";
import { spawn } from "node:child_process";
import { truncateMiddle } from "../compaction.js";
import { discoverProjects } from "../validation/project-discovery.js";
import { buildCodeGraphIndex, type CodeGraphIndex } from "./code-graph-index.js";

const DEFAULT_REPO_MAP_MAX_CHARS = 20000;

export interface RepoMapV2Options {
  workspacePath: string;
  maxChars?: number;
  maxFiles?: number;
  maxFileBytes?: number;
  maxIndexDurationMs?: number;
}

export interface GeneratedRepoMapV2 {
  content: string;
  chars: number;
  graph: Pick<CodeGraphIndex, "files" | "dependencyEdges" | "exports" | "testToSource" | "configFiles" | "truncated">;
}

function runGit(args: string[], cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd, windowsHide: true });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(code === 0 ? stdout.trim() : null));
  });
}

async function gitSummary(workspacePath: string): Promise<string[]> {
  const branch = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], workspacePath);
  const status = await runGit(["status", "--short"], workspacePath);
  if (branch === null && status === null) return ["- not a git workspace"];
  return [
    `- branch: ${branch ?? "unknown"}`,
    `- working tree: ${status && status.length > 0 ? "dirty" : "clean"}`
  ];
}

function rankSourceFiles(graph: CodeGraphIndex): string[] {
  return graph.files
    .filter((file) => !file.isConfig)
    .map((file) => ({
      file,
      score: file.exports.length * 8 + file.definitions.length * 3 + file.dependencyEdges.length * 2 + (file.isTest ? -2 : 0)
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.file.path.localeCompare(b.file.path, "en"))
    .slice(0, 30)
    .map((entry) => {
      const exported = entry.file.exports.slice(0, 8).join(", ");
      return `- ${entry.file.path}${exported ? ` exports ${exported}` : ""}`;
    });
}

function dependencySummary(graph: CodeGraphIndex): string[] {
  const importEdges = graph.dependencyEdges.filter((edge) => edge.kind === "import").slice(0, 40);
  const testEdges = graph.testToSource.slice(0, 20);
  return [
    ...(importEdges.length > 0
      ? importEdges.map((edge) => `- ${edge.from} -> ${edge.to}${edge.label ? ` (${edge.label})` : ""}`)
      : ["- no resolved import edges found"]),
    ...(testEdges.length > 0
      ? ["", "Test to source:", ...testEdges.map((edge) => `- ${edge.from} -> ${edge.to}`)]
      : [])
  ];
}

function sourceSymbolLines(graph: CodeGraphIndex): string[] {
  const byPath = new Map<string, string[]>();
  for (const definition of graph.definitions) {
    if (!definition.exported && definition.kind !== "test") continue;
    const current = byPath.get(definition.path) ?? [];
    current.push(definition.symbol);
    byPath.set(definition.path, current);
  }
  return [...byPath.entries()]
    .sort(([a], [b]) => a.localeCompare(b, "en"))
    .slice(0, 60)
    .map(([file, symbols]) => `- ${file}: ${[...new Set(symbols)].slice(0, 12).join(", ")}`);
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number | undefined): Promise<T> {
  if (!timeoutMs || timeoutMs <= 0) return await operation;
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`RepoMap v2 timed out after ${timeoutMs}ms.`)), timeoutMs);
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function generateRepoMapV2(options: RepoMapV2Options): Promise<GeneratedRepoMapV2> {
  const workspacePath = path.resolve(options.workspacePath);
  const maxChars = Math.max(1, Math.floor(options.maxChars ?? DEFAULT_REPO_MAP_MAX_CHARS));
  const [graph, discovery, git] = await Promise.all([
    withTimeout(
      buildCodeGraphIndex({
        workspacePath,
        maxFiles: options.maxFiles ?? 20000,
        maxFileBytes: options.maxFileBytes ?? 256000
      }),
      options.maxIndexDurationMs
    ),
    discoverProjects({ workspacePath }),
    gitSummary(workspacePath)
  ]);
  const packageMetadata = discovery.roots
    .filter((root) => root.type === "node" && root.scripts)
    .map((root) => {
      const scripts = Object.keys(root.scripts ?? {}).sort((a, b) => a.localeCompare(b, "en"));
      return `- ${root.relativeRoot || "root"} scripts: ${scripts.join(", ") || "(none)"}`;
    });
  const legacySourceSymbols = sourceSymbolLines(graph);
  const tests = graph.files.filter((file) => file.isTest).map((file) => file.path).sort((a, b) => a.localeCompare(b, "en")).slice(0, 60);
  const exportedSymbols = graph.exports
    .sort((a, b) => a.path.localeCompare(b.path, "en") || a.line - b.line)
    .slice(0, 80)
    .map((definition) => `- ${definition.path}:${definition.line} ${definition.kind} ${definition.symbol}`);
  const lines = [
    "Repository map generated by Sigma (v2)",
    "This map is deterministic and may be incomplete; use tools to verify before editing.",
    "",
    "Project roots:",
    ...(discovery.roots.length > 0
      ? discovery.roots.map((root) => `- ${root.relativeRoot || "."} (${root.type}) markers: ${root.markerFiles.join(", ")}`)
      : ["- no project roots found"]),
    "",
    "Important config files:",
    ...(graph.configFiles.length > 0 ? graph.configFiles.slice(0, 60).map((file) => `- ${file}`) : ["- none found"]),
    "",
    "Package metadata:",
    ...(packageMetadata.length > 0 ? packageMetadata : ["- no package metadata found"]),
    "",
    "High-rank source files:",
    ...(rankSourceFiles(graph).length > 0 ? rankSourceFiles(graph) : ["- no high-rank source files found"]),
    "",
    "Key source symbols:",
    ...(legacySourceSymbols.length > 0 ? legacySourceSymbols : ["- no exported symbols found"]),
    "",
    "Tests:",
    ...(tests.length > 0 ? tests.map((file) => `- ${file}`) : ["- no test files found"]),
    "",
    "Exported symbols:",
    ...(exportedSymbols.length > 0 ? exportedSymbols : ["- no exported symbols found"]),
    "",
    "Dependency graph summary:",
    ...dependencySummary(graph),
    ...(graph.truncated ? ["", "- [graph truncated]"] : []),
    "",
    "Git state:",
    ...git
  ];
  const raw = lines.join("\n");
  const truncated = truncateMiddle(raw, maxChars);
  return {
    content: truncated.text,
    chars: truncated.text.length,
    graph: {
      files: graph.files,
      dependencyEdges: graph.dependencyEdges,
      exports: graph.exports,
      testToSource: graph.testToSource,
      configFiles: graph.configFiles,
      truncated: graph.truncated
    }
  };
}

export function formatRepoMapV2Block(repoMap: GeneratedRepoMapV2): string {
  return repoMap.content;
}
