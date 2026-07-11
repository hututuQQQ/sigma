import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import type { Stats } from "node:fs";
import path from "node:path";
import { parseHookToml } from "./hook-catalog.js";

export const WORKSPACE_CUSTOMIZATION_ROOTS = [
  ".agent/profiles",
  ".agent/hooks",
  ".agent/skills",
  ".agents/skills"
] as const;

export interface WorkspaceCustomizationFile {
  relativePath: string;
  mode: number;
  size: number;
  digest: string;
}

export interface WorkspaceCustomizationManifest {
  canonicalWorkspacePath: string;
  customizationDigest: string;
  files: readonly WorkspaceCustomizationFile[];
  hasWorkspaceHooks: boolean;
}

const MAX_FILES = 25_000;
const MAX_BYTES = 256 * 1024 * 1024;

/** Computes one digest over every workspace profile, hook, and skill file.
 * Symlinks are rejected so executable content cannot change behind an attested
 * path without changing this manifest. */
export function workspaceCustomizationManifest(workspacePath: string): WorkspaceCustomizationManifest {
  const canonicalWorkspacePath = realpathSync.native(path.resolve(workspacePath));
  const files: WorkspaceCustomizationFile[] = [];
  const hookAssets = trustedHookAssets(canonicalWorkspacePath);
  let totalBytes = 0;
  for (const relativeRoot of WORKSPACE_CUSTOMIZATION_ROOTS) {
    const root = path.join(canonicalWorkspacePath, ...relativeRoot.split("/"));
    if (!existsSync(root)) continue;
    walk(root, canonicalWorkspacePath, files, (size) => {
      totalBytes += size;
      if (files.length > MAX_FILES || totalBytes > MAX_BYTES) {
        throw new Error("Workspace customization exceeds the 25,000 file or 256 MiB trust-manifest limit.");
      }
    });
  }
  for (const asset of hookAssets.paths) {
    capture(asset, canonicalWorkspacePath, files, (size) => {
      totalBytes += size;
      if (files.length > MAX_FILES || totalBytes > MAX_BYTES) {
        throw new Error("Workspace customization exceeds the 25,000 file or 256 MiB trust-manifest limit.");
      }
    });
  }
  const uniqueFiles = [...new Map(files.map((file) => [file.relativePath, file])).values()]
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const canonical = JSON.stringify(uniqueFiles);
  return {
    canonicalWorkspacePath,
    customizationDigest: createHash("sha256").update(canonical, "utf8").digest("hex"),
    files: uniqueFiles,
    hasWorkspaceHooks: hookAssets.hasExecutableHooks
  };
}

function walk(
  directory: string,
  workspace: string,
  files: WorkspaceCustomizationFile[],
  added: (size: number) => void
): void {
  const directoryInfo = lstatSync(directory);
  if (directoryInfo.isSymbolicLink()) throw new Error(`Workspace customization path '${directory}' cannot be a symlink.`);
  if (!directoryInfo.isDirectory()) throw new Error(`Workspace customization root '${directory}' must be a directory.`);
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    const candidate = path.join(directory, entry.name);
    const info = lstatSync(candidate);
    if (info.isSymbolicLink()) throw new Error(`Workspace customization path '${candidate}' cannot be a symlink.`);
    if (info.isDirectory()) {
      walk(candidate, workspace, files, added);
      continue;
    }
    addFile(candidate, workspace, info, files, added);
  }
}

function capture(
  candidate: string,
  workspace: string,
  files: WorkspaceCustomizationFile[],
  added: (size: number) => void
): void {
  const info = lstatSync(candidate);
  if (info.isSymbolicLink()) throw new Error(`Workspace customization path '${candidate}' cannot be a symlink.`);
  if (info.isDirectory()) return walk(candidate, workspace, files, added);
  addFile(candidate, workspace, info, files, added);
}

function addFile(
  candidate: string,
  workspace: string,
  info: Stats,
  files: WorkspaceCustomizationFile[],
  added: (size: number) => void
): void {
  if (!info.isFile()) throw new Error(`Workspace customization path '${candidate}' must be a regular file.`);
  const content = readFileSync(candidate);
  const relativePath = path.relative(workspace, candidate).split(path.sep).join("/");
  if (relativePath === ".." || relativePath.startsWith("../")) {
    throw new Error(`Workspace customization path '${candidate}' escapes the canonical workspace.`);
  }
  files.push({
    relativePath,
    mode: info.mode & 0o777,
    size: info.size,
    digest: createHash("sha256").update(content).digest("hex")
  });
  added(info.size);
}

function trustedHookAssets(workspace: string): { paths: string[]; hasExecutableHooks: boolean } {
  const hookDirectory = path.join(workspace, ".agent", "hooks");
  if (!existsSync(hookDirectory)) return { paths: [], hasExecutableHooks: false };
  const assets: string[] = [];
  let hasExecutableHooks = false;
  for (const entry of readdirSync(hookDirectory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".toml")) continue;
    const definition = parseHookToml(readFileSync(path.join(hookDirectory, entry.name), "utf8"), entry.name);
    if (definition.kind !== "command") continue;
    hasExecutableHooks = true;
    for (const relativePath of definition.trustPaths ?? []) {
      if (!relativePath.trim() || path.normalize(relativePath) === ".") {
        throw new Error("Hook trust paths must identify a file or contained subdirectory, not the workspace root.");
      }
      if (path.isAbsolute(relativePath)) throw new Error(`Hook trust path '${relativePath}' must be workspace-relative.`);
      const candidate = path.resolve(workspace, relativePath);
      const relative = path.relative(workspace, candidate);
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error(`Hook trust path '${relativePath}' escapes the canonical workspace.`);
      }
      if (!existsSync(candidate)) throw new Error(`Hook trust path '${relativePath}' does not exist.`);
      assets.push(candidate);
    }
  }
  return { paths: assets, hasExecutableHooks };
}
