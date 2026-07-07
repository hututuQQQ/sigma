import { spawn } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { truncateMiddle } from "../compaction.js";
import { workspaceRelativePath } from "../policy.js";
import { comparePath, DEFAULT_IGNORED_NAMES, shouldSkipName } from "../tools/workspace-utils.js";

const DEFAULT_REPO_MAP_MAX_CHARS = 20000;

export interface RepoMapOptions {
  workspacePath: string;
  maxChars?: number;
}

export interface GeneratedRepoMap {
  content: string;
  chars: number;
}

interface SourceSymbols {
  path: string;
  symbols: string[];
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

async function fileTree(workspacePath: string, maxDepth = 3, maxFiles = 250): Promise<{ lines: string[]; truncated: boolean }> {
  const lines: string[] = [];
  let visited = 0;
  let truncated = false;

  async function visit(dirPath: string, depth: number): Promise<void> {
    if (depth > maxDepth || visited >= maxFiles) {
      truncated = true;
      return;
    }
    const entries = (await readdir(dirPath, { withFileTypes: true })).sort((a, b) => comparePath(a.name, b.name));
    for (const entry of entries) {
      if (visited >= maxFiles) {
        truncated = true;
        return;
      }
      if (shouldSkipName(entry.name, false, false)) continue;
      const absolutePath = path.join(dirPath, entry.name);
      const relative = workspaceRelativePath(workspacePath, absolutePath);
      lines.push(`${"  ".repeat(depth)}- ${relative}${entry.isDirectory() ? "/" : ""}`);
      visited += 1;
      if (entry.isDirectory()) await visit(absolutePath, depth + 1);
    }
  }

  await visit(workspacePath, 0);
  return { lines, truncated };
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
  try {
    const tsconfig = await readJson(path.join(workspacePath, "tsconfig.json"));
    const references = Array.isArray(tsconfig?.references)
      ? tsconfig.references
          .map((ref) => (ref && typeof ref === "object" ? (ref as { path?: unknown }).path : undefined))
          .filter((value): value is string => typeof value === "string")
      : [];
    if (references.length > 0) lines.push(`- TypeScript references: ${references.join(", ")}`);
  } catch {
    // Optional.
  }
  return lines;
}

function tsSymbols(content: string): string[] {
  const symbols = new Set<string>();
  const regex = /\bexport\s+(?:declare\s+)?(?:async\s+)?(?:function|class|interface|type|const|let|var|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g;
  for (let match = regex.exec(content); match !== null; match = regex.exec(content)) {
    symbols.add(match[1]);
  }
  const namedExport = /\bexport\s*\{([^}]+)\}/g;
  for (let match = namedExport.exec(content); match !== null; match = namedExport.exec(content)) {
    for (const piece of match[1].split(",")) {
      const name = piece.trim().split(/\s+as\s+/i)[0]?.trim();
      if (name) symbols.add(name);
    }
  }
  return [...symbols].sort((a, b) => a.localeCompare(b, "en")).slice(0, 30);
}

function pythonSymbols(content: string): string[] {
  const symbols = new Set<string>();
  const regex = /^(?:async\s+def|def|class)\s+([A-Za-z_][A-Za-z0-9_]*)/gm;
  for (let match = regex.exec(content); match !== null; match = regex.exec(content)) {
    symbols.add(match[1]);
  }
  return [...symbols].sort((a, b) => a.localeCompare(b, "en")).slice(0, 30);
}

function shellSymbols(content: string): string[] {
  const symbols = new Set<string>();
  const regex = /^(?:function\s+([A-Za-z_][A-Za-z0-9_]*)|([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*\))/gm;
  for (let match = regex.exec(content); match !== null; match = regex.exec(content)) {
    symbols.add(match[1] ?? match[2]);
  }
  return [...symbols].sort((a, b) => a.localeCompare(b, "en")).slice(0, 30);
}

async function collectSourceSymbols(workspacePath: string, maxFiles = 120): Promise<SourceSymbols[]> {
  const files: string[] = [];
  async function visit(dirPath: string): Promise<void> {
    if (files.length >= maxFiles) return;
    const entries = (await readdir(dirPath, { withFileTypes: true })).sort((a, b) => comparePath(a.name, b.name));
    for (const entry of entries) {
      if (files.length >= maxFiles) return;
      if (shouldSkipName(entry.name, false, false)) continue;
      const absolutePath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      if (/\.(ts|tsx|js|jsx|mjs|cjs|py|sh|bash)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
        files.push(absolutePath);
      }
    }
  }
  await visit(workspacePath);

  const result: SourceSymbols[] = [];
  for (const file of files) {
    const info = await stat(file);
    if (info.size > 200000) continue;
    const content = await readFile(file, "utf8");
    const symbols = /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(file)
      ? tsSymbols(content)
      : /\.py$/.test(file)
        ? pythonSymbols(content)
        : shellSymbols(content);
    if (symbols.length > 0) {
      result.push({ path: workspaceRelativePath(workspacePath, file), symbols });
    }
  }
  return result;
}

async function testFiles(workspacePath: string, maxFiles = 120): Promise<string[]> {
  const files: string[] = [];
  async function visit(dirPath: string): Promise<void> {
    if (files.length >= maxFiles) return;
    const entries = (await readdir(dirPath, { withFileTypes: true })).sort((a, b) => comparePath(a.name, b.name));
    for (const entry of entries) {
      if (files.length >= maxFiles) return;
      if (shouldSkipName(entry.name, false, false)) continue;
      const absolutePath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath);
      } else {
        const relative = workspaceRelativePath(workspacePath, absolutePath);
        if (/(\.test\.|\.spec\.|__tests__|^tests\/)/.test(relative)) files.push(relative);
      }
    }
  }
  await visit(workspacePath);
  return files.sort((a, b) => a.localeCompare(b, "en"));
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

export async function generateRepoMap(options: RepoMapOptions): Promise<GeneratedRepoMap> {
  const workspacePath = path.resolve(options.workspacePath);
  const maxChars = Math.max(1, Math.floor(options.maxChars ?? DEFAULT_REPO_MAP_MAX_CHARS));
  const tree = await fileTree(workspacePath);
  const packageLines = await packageMetadata(workspacePath);
  const symbols = await collectSourceSymbols(workspacePath);
  const tests = await testFiles(workspacePath);
  const git = await gitSummary(workspacePath);

  const lines = [
    "Repository map generated by Sigma",
    "This map is deterministic and may be incomplete; use tools to verify before editing.",
    "",
    "File tree:",
    ...(tree.lines.length > 0 ? tree.lines : ["- (empty workspace)"]),
    ...(tree.truncated ? ["- [tree truncated]"] : []),
    "",
    "Package metadata:",
    ...(packageLines.length > 0 ? packageLines : ["- no package metadata found"]),
    "",
    "Key source symbols:",
    ...(symbols.length > 0 ? symbols.map((entry) => `- ${entry.path}: ${entry.symbols.join(", ")}`) : ["- no exported symbols found"]),
    "",
    "Test files:",
    ...(tests.length > 0 ? tests.map((file) => `- ${file}`) : ["- no test files found"]),
    "",
    "Agent config:",
    DEFAULT_IGNORED_NAMES.has(".agent") ? "- .agent/config.toml presence not checked" : "- .agent/config.toml checked",
    "",
    "Git state:",
    ...git
  ];

  try {
    await stat(path.join(workspacePath, ".agent", "config.toml"));
    const index = lines.indexOf("- .agent/config.toml checked");
    if (index !== -1) lines[index] = "- .agent/config.toml present";
  } catch {
    const index = lines.indexOf("- .agent/config.toml checked");
    if (index !== -1) lines[index] = "- .agent/config.toml absent";
  }

  const raw = lines.join("\n");
  const truncated = truncateMiddle(raw, maxChars);
  return { content: truncated.text, chars: truncated.text.length };
}

export function formatRepoMapBlock(repoMap: GeneratedRepoMap): string {
  return repoMap.content;
}

