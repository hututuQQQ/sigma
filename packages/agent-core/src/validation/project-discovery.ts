import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { DiscoveredProjectRoot, ProjectDiscoveryResult } from "./validation-types.js";

const SKIP_DIRS = new Set([
  ".git",
  ".agent",
  ".artifacts",
  "node_modules",
  "dist",
  "build",
  "coverage",
  "__pycache__",
  ".venv",
  "venv",
  "target"
]);

const MARKERS = new Set([
  "package.json",
  "pyproject.toml",
  "requirements.txt",
  "setup.py",
  "pytest.ini",
  "uv.lock",
  "go.mod",
  "Cargo.toml",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "gradlew",
  "Makefile",
  "makefile"
]);

interface DirectorySnapshot {
  absolute: string;
  relative: string;
  files: Set<string>;
}

function normalizeRelative(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/^\.\/+/, "");
}

function packageManagerFromPackageJson(packageJson: string): "npm" | "pnpm" | "yarn" | "bun" | undefined {
  try {
    const parsed = JSON.parse(packageJson) as { packageManager?: unknown };
    if (typeof parsed.packageManager !== "string") return undefined;
    const name = parsed.packageManager.split("@")[0];
    return name === "npm" || name === "pnpm" || name === "yarn" || name === "bun" ? name : undefined;
  } catch {
    return undefined;
  }
}

function parsePackageScripts(packageJson: string): Record<string, string> {
  try {
    const parsed = JSON.parse(packageJson) as { scripts?: unknown };
    if (!parsed.scripts || typeof parsed.scripts !== "object") return {};
    const scripts: Record<string, string> = {};
    for (const [name, value] of Object.entries(parsed.scripts as Record<string, unknown>)) {
      if (typeof value === "string") scripts[name] = value;
    }
    return scripts;
  } catch {
    return {};
  }
}

function parseMakeTargets(makefile: string): string[] {
  const targets = new Set<string>();
  for (const line of makefile.split(/\r?\n/)) {
    if (/^\s/.test(line)) continue;
    const match = line.match(/^([A-Za-z0-9_.-]+)\s*:(?!=)/);
    if (match) targets.add(match[1]);
  }
  return [...targets];
}

async function readOptional(filePath: string, maxBytes = 128000): Promise<string> {
  try {
    const buffer = await readFile(filePath);
    return buffer.subarray(0, maxBytes).toString("utf8");
  } catch {
    return "";
  }
}

async function walkDirectories(workspacePath: string, maxDepth = 5): Promise<DirectorySnapshot[]> {
  const snapshots: DirectorySnapshot[] = [];

  async function visit(absolute: string, relative: string, depth: number): Promise<void> {
    let entries;
    try {
      entries = await readdir(absolute, { withFileTypes: true });
    } catch {
      return;
    }

    const files = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));
    if ([...files].some((file) => MARKERS.has(file))) {
      snapshots.push({ absolute, relative, files });
    }
    if (depth >= maxDepth) return;

    await Promise.all(entries
      .filter((entry) => entry.isDirectory() && !SKIP_DIRS.has(entry.name))
      .map((entry) => visit(path.join(absolute, entry.name), normalizeRelative(path.posix.join(relative, entry.name)), depth + 1)));
  }

  await visit(workspacePath, "", 0);
  return snapshots;
}

function packageManagerForRoot(snapshot: DirectorySnapshot, workspaceFiles: Set<string>, packageJson: string): "npm" | "pnpm" | "yarn" | "bun" {
  if (snapshot.files.has("pnpm-lock.yaml") || workspaceFiles.has("pnpm-lock.yaml")) return "pnpm";
  if (snapshot.files.has("yarn.lock") || workspaceFiles.has("yarn.lock")) return "yarn";
  if (snapshot.files.has("bun.lock") || snapshot.files.has("bun.lockb") || workspaceFiles.has("bun.lock") || workspaceFiles.has("bun.lockb")) return "bun";
  return packageManagerFromPackageJson(packageJson) ?? "npm";
}

async function rootsForSnapshot(snapshot: DirectorySnapshot, workspaceFiles: Set<string>): Promise<DiscoveredProjectRoot[]> {
  const markerFiles = [...snapshot.files].filter((file) => MARKERS.has(file));
  const roots: DiscoveredProjectRoot[] = [];
  const base = {
    root: snapshot.absolute,
    relativeRoot: snapshot.relative,
    markerFiles
  };

  if (snapshot.files.has("package.json")) {
    const packageJson = await readOptional(path.join(snapshot.absolute, "package.json"));
    roots.push({
      ...base,
      type: "node",
      packageManager: packageManagerForRoot(snapshot, workspaceFiles, packageJson),
      scripts: parsePackageScripts(packageJson)
    });
  }
  if (snapshot.files.has("pyproject.toml") || snapshot.files.has("requirements.txt") || snapshot.files.has("setup.py") || snapshot.files.has("pytest.ini")) {
    roots.push({ ...base, type: "python" });
  }
  if (snapshot.files.has("go.mod")) roots.push({ ...base, type: "go" });
  if (snapshot.files.has("Cargo.toml")) roots.push({ ...base, type: "rust" });
  if (snapshot.files.has("pom.xml")) roots.push({ ...base, type: "maven" });
  if (snapshot.files.has("build.gradle") || snapshot.files.has("build.gradle.kts")) roots.push({ ...base, type: "gradle" });
  if (snapshot.files.has("Makefile") || snapshot.files.has("makefile")) {
    const makefile = await readOptional(path.join(snapshot.absolute, snapshot.files.has("Makefile") ? "Makefile" : "makefile"));
    roots.push({ ...base, type: "make", makeTargets: parseMakeTargets(makefile) });
  }
  return roots;
}

function rootContainsFile(root: DiscoveredProjectRoot, filePath: string): boolean {
  const file = normalizeRelative(filePath);
  if (!root.relativeRoot) return true;
  return file === root.relativeRoot || file.startsWith(`${root.relativeRoot}/`);
}

function mostSpecificRoots(roots: DiscoveredProjectRoot[], filePath: string): DiscoveredProjectRoot[] {
  const containing = roots.filter((root) => rootContainsFile(root, filePath));
  if (containing.length === 0) return [];
  const maxLength = Math.max(...containing.map((root) => root.relativeRoot.length));
  return containing.filter((root) => root.relativeRoot.length === maxLength);
}

export async function discoverProjects(options: {
  workspacePath: string;
  changedFiles?: string[];
}): Promise<ProjectDiscoveryResult> {
  const workspacePath = path.resolve(options.workspacePath);
  const changedFiles = (options.changedFiles ?? []).map(normalizeRelative);
  const snapshots = await walkDirectories(workspacePath);
  const workspaceFiles = snapshots.find((snapshot) => snapshot.relative === "")?.files ?? new Set<string>();
  const roots = (await Promise.all(snapshots.map((snapshot) => rootsForSnapshot(snapshot, workspaceFiles)))).flat()
    .sort((a, b) => a.relativeRoot.localeCompare(b.relativeRoot, "en") || a.type.localeCompare(b.type, "en"));
  const changedFileRoots: Record<string, string[]> = {};
  const skipped: ProjectDiscoveryResult["skipped"] = [];

  for (const file of changedFiles) {
    const matches = mostSpecificRoots(roots, file);
    changedFileRoots[file] = matches.map((root) => root.relativeRoot);
    if (matches.length === 0) {
      skipped.push({ reason: "No discovered project root contains this changed file.", relatedFiles: [file] });
    }
  }

  if (roots.length === 0) {
    skipped.push({ reason: "No project metadata discovered; only changed-file syntax checks are available.", relatedFiles: changedFiles });
  }

  return {
    workspacePath,
    roots,
    changedFiles,
    changedFileRoots,
    skipped
  };
}
