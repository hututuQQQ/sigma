import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { truncateMiddle } from "../compaction.js";
import { redactSecretText } from "../redaction.js";
import { comparePath, walkFiles } from "../tools/workspace-utils.js";
import { generateRepoMapV2 } from "./repo-map-v2.js";
import type { CodeIndexSummary } from "../types.js";

const DEFAULT_REPO_MAP_MAX_CHARS = 20000;
const DEGRADED_TREE_MAX_FILES = 250;
const CONFIG_BASE_NAMES = new Set([
  "package.json",
  "pnpm-workspace.yaml",
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

export interface RepoMapOptions {
  workspacePath: string;
  maxChars?: number;
  maxFiles?: number;
  maxFileBytes?: number;
  maxIndexDurationMs?: number;
}

export interface GeneratedRepoMap {
  content: string;
  chars: number;
  codeIndex?: CodeIndexSummary;
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

async function safe<T>(operation: Promise<T>, fallback: T): Promise<T> {
  try {
    return await operation;
  } catch {
    return fallback;
  }
}

async function fileTree(workspacePath: string, maxDepth = 3, maxFiles = DEGRADED_TREE_MAX_FILES): Promise<{ lines: string[]; truncated: boolean; fileCount: number }> {
  const walked = await walkFiles({ workspacePath, rootPath: workspacePath, maxFiles });
  const entries = new Set<string>();
  for (const file of walked.files) {
    const parts = file.relativePath.split("/");
    for (let index = 0; index < parts.length; index += 1) {
      if (index + 1 > maxDepth) break;
      const item = parts.slice(0, index + 1).join("/");
      entries.add(index === parts.length - 1 ? item : `${item}/`);
    }
  }
  const lines = [...entries]
    .sort(comparePath)
    .slice(0, maxFiles)
    .map((entry) => `${"  ".repeat(Math.max(0, entry.split("/").length - 1))}- ${entry}`);
  return { lines, truncated: walked.truncated || entries.size > lines.length, fileCount: walked.files.length };
}

async function readJson(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function packageMetadata(workspacePath: string): Promise<string[]> {
  const lines: string[] = [];
  const rootPackage = await readJson(path.join(workspacePath, "package.json"));
  if (rootPackage) {
    lines.push("- package.json present");
    if (rootPackage.scripts && typeof rootPackage.scripts === "object") {
      const scripts = Object.keys(rootPackage.scripts).sort((a, b) => a.localeCompare(b, "en"));
      lines.push(`- root scripts: ${scripts.join(", ") || "(none)"}`);
    }
  }
  try {
    const workspaceYaml = await readFile(path.join(workspacePath, "pnpm-workspace.yaml"), "utf8");
    const packages = workspaceYaml
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("- "))
      .map((line) => line.slice(2).replace(/^["']|["']$/g, ""));
    if (packages.length > 0) lines.push(`- pnpm workspace packages: ${packages.join(", ")}`);
  } catch {
    // pnpm workspaces are optional.
  }
  return lines;
}

function isConfigFile(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  const base = normalized.split("/").pop() ?? normalized;
  return CONFIG_BASE_NAMES.has(base) ||
    /(^|\/)\.(github|agent|vscode|config)(\/|$)/.test(normalized) ||
    /(^|\/)(eslint|prettier|vitest|vite|webpack|rollup|babel|jest|mocha|pytest|ruff|mypy|tsup|turbo|nx)\.config\./i.test(normalized);
}

async function configFiles(workspacePath: string, maxFiles = DEGRADED_TREE_MAX_FILES): Promise<string[]> {
  const walked = await walkFiles({ workspacePath, rootPath: workspacePath, maxFiles });
  return walked.files
    .map((file) => file.relativePath)
    .filter(isConfigFile)
    .sort(comparePath)
    .slice(0, 80);
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

function repoMapErrorSummary(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return truncateMiddle(redactSecretText(message.replace(/\s+/g, " ").trim()), 600).text;
}

async function generateDegradedRepoMap(options: RepoMapOptions, error: unknown): Promise<GeneratedRepoMap> {
  const workspacePath = path.resolve(options.workspacePath);
  const maxChars = Math.max(1, Math.floor(options.maxChars ?? DEFAULT_REPO_MAP_MAX_CHARS));
  const errorSummary = repoMapErrorSummary(error);
  const [tree, packages, configs, git] = await Promise.all([
    safe(fileTree(workspacePath), { lines: [], truncated: true, fileCount: 0 }),
    safe(packageMetadata(workspacePath), []),
    safe(configFiles(workspacePath), []),
    safe(gitSummary(workspacePath), ["- unavailable"])
  ]);
  const lines = [
    "Repository map generated by Sigma (v2 degraded)",
    "RepoMap v2 failed; this emergency map is intentionally minimal and may omit source graph details.",
    `Error summary: ${errorSummary || "unknown error"}`,
    "",
    "File tree:",
    ...(tree.lines.length > 0 ? tree.lines : ["- (unavailable)"]),
    ...(tree.truncated ? ["- [tree truncated]"] : []),
    "",
    "Important config files:",
    ...(configs.length > 0 ? configs.map((file) => `- ${file}`) : ["- none found"]),
    "",
    "Package metadata:",
    ...(packages.length > 0 ? packages : ["- no package metadata found"]),
    "",
    "Git state:",
    ...git
  ];
  const truncated = truncateMiddle(lines.join("\n"), maxChars);
  return {
    content: truncated.text,
    chars: truncated.text.length,
    codeIndex: {
      file_count: tree.fileCount,
      symbol_count: 0,
      definition_count: 0,
      dependency_edge_count: 0,
      test_to_source_count: 0,
      config_files: configs,
      truncated: true,
      degraded: true,
      error: errorSummary
    }
  };
}

export async function generateRepoMap(options: RepoMapOptions): Promise<GeneratedRepoMap> {
  try {
    const v2 = await generateRepoMapV2(options);
    return {
      content: v2.content,
      chars: v2.chars,
      codeIndex: {
        file_count: v2.graph.files.length,
        symbol_count: v2.graph.files.reduce((total, file) => total + file.symbols.length, 0),
        definition_count: v2.graph.files.reduce((total, file) => total + file.definitions.length, 0),
        dependency_edge_count: v2.graph.dependencyEdges.length,
        test_to_source_count: v2.graph.testToSource.length,
        config_files: v2.graph.configFiles.slice(0, 50),
        truncated: v2.graph.truncated
      }
    };
  } catch (error) {
    return await generateDegradedRepoMap(options, error);
  }
}

export function formatRepoMapBlock(repoMap: GeneratedRepoMap): string {
  return repoMap.content;
}
