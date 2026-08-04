import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { runLeasedRepositoryGit } from "./repository-git.js";
import type { ProcessExecutionPort, ProcessResult } from "./process.js";

export interface RepositoryTopology {
  kind: "worktree" | "linked_worktree" | "submodule" | "bare";
  worktreeRoot: string | null;
  gitDir: string;
  commonDir: string;
  objectDirs: string[];
  trust: "workspace" | "external_trusted" | "external_untrusted";
}

/**
 * Resolve only filesystem-declared Git topology. This is a capability request,
 * not authorization: callers must bind every returned path into a broker-issued
 * metadata lease before starting Git.
 */
export async function repositoryMetadataTopologyCandidate(
  workspace: string
): Promise<RepositoryTopology | null> {
  const root = await realpath(path.resolve(workspace));
  const markerPath = path.join(root, ".git");
  const marker = await lstat(markerPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!marker) return await bareRepositoryTopology(root);
  if (marker.isSymbolicLink() || (!marker.isDirectory() && !marker.isFile())) {
    throw Object.assign(new Error("Git metadata marker must be a stable directory or gitdir file."), {
      code: "git_probe_failed"
    });
  }
  if (marker.isDirectory()) {
    const gitDir = await realpath(markerPath);
    const commonDir = await commonGitDirectory(gitDir);
    return {
      kind: "worktree",
      worktreeRoot: root,
      gitDir,
      commonDir,
      objectDirs: [path.join(commonDir, "objects")],
      trust: isInside(root, gitDir) && isInside(root, commonDir)
        ? "workspace" : "external_untrusted"
    };
  }
  return await indirectRepositoryTopology(root, markerPath, true);
}

export function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function pathEscape(message: string): Error {
  return Object.assign(new Error(message), { code: "path_escape" });
}

export async function canonicalWorkspacePath(workspace: string, requested: string): Promise<string> {
  const root = await realpath(path.resolve(workspace));
  const candidate = path.resolve(root, requested);
  if (!isInside(root, candidate)) throw pathEscape(`Path escapes workspace: ${requested}`);
  let ancestor = candidate;
  while (true) {
    try {
      const resolvedAncestor = await realpath(ancestor);
      const canonical = path.resolve(resolvedAncestor, path.relative(ancestor, candidate));
      if (!isInside(root, canonical)) {
        throw pathEscape(`Path resolves outside workspace through a link: ${requested}`);
      }
      return canonical;
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code !== "ENOENT") throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
}

export async function resolveWorkspacePath(workspace: string, requested: string): Promise<string> {
  return await canonicalWorkspacePath(workspace, requested);
}

export async function selfContainedGitRoot(
  workspace: string,
  signal: AbortSignal | undefined,
  _execution: ProcessExecutionPort
): Promise<string | null> {
  signal?.throwIfAborted();
  const root = await realpath(path.resolve(workspace));
  const marker = await lstat(path.join(root, ".git")).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!marker || marker.isSymbolicLink()) return null;
  if (marker.isDirectory()) {
    return await directoryRepositoryTopology(root, path.join(root, ".git")) ? root : null;
  }
  if (!marker.isFile()) return null;
  const topology = await indirectRepositoryTopology(root, path.join(root, ".git"), false);
  signal?.throwIfAborted();
  return topology?.trust === "workspace" ? root : null;
}

async function gitFileTarget(root: string, marker: string): Promise<string> {
  const content = await readFile(marker, "utf8");
  if (content.length > 4096) {
    throw Object.assign(new Error("Git indirection file exceeds 4096 bytes."), { code: "git_probe_failed" });
  }
  const match = /^gitdir:\s*(.+?)\s*$/iu.exec(content);
  if (!match?.[1]) {
    throw Object.assign(new Error("Git indirection file is malformed."), { code: "git_probe_failed" });
  }
  return path.resolve(root, match[1]);
}

async function commonGitDirectory(gitDir: string): Promise<string> {
  const commondir = await readFile(path.join(gitDir, "commondir"), "utf8")
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw Object.assign(new Error(`Git common-directory indirection cannot be read: ${error.message}`), {
        code: "git_probe_failed",
        cause: error
      });
    });
  if (!commondir.trim()) return gitDir;
  return await realpath(path.resolve(gitDir, commondir.trim())).catch(() =>
    path.resolve(gitDir, commondir.trim()));
}

async function validGitDirectory(gitDir: string, commonDir: string): Promise<boolean> {
  const [head, objects] = await Promise.all([
    lstat(path.join(gitDir, "HEAD")).catch(() => null),
    lstat(path.join(commonDir, "objects")).catch(() => null)
  ]);
  return head?.isFile() === true && objects?.isDirectory() === true;
}

async function bareRepositoryTopology(root: string): Promise<RepositoryTopology | null> {
  const [head, objects] = await Promise.all([
    lstat(path.join(root, "HEAD")).catch(() => null),
    lstat(path.join(root, "objects")).catch(() => null)
  ]);
  if (!head?.isFile() || !objects?.isDirectory()) return null;
  return {
    kind: "bare", worktreeRoot: null, gitDir: root, commonDir: root,
    objectDirs: [path.join(root, "objects")], trust: "workspace"
  };
}

async function directoryRepositoryTopology(
  root: string,
  markerPath: string
): Promise<RepositoryTopology | null> {
  const gitDir = await realpath(markerPath);
  const commonDir = await commonGitDirectory(gitDir);
  if (!await validGitDirectory(gitDir, commonDir)) return null;
  return {
    kind: "worktree",
    worktreeRoot: root,
    gitDir,
    commonDir,
    objectDirs: [path.join(commonDir, "objects")],
    trust: isInside(root, gitDir) && isInside(root, commonDir)
      ? "workspace" : "external_untrusted"
  };
}

function indirectionKind(gitDir: string): "submodule" | "linked_worktree" {
  return /(?:^|[\\/])modules(?:[\\/]|$)/iu.test(gitDir) ? "submodule" : "linked_worktree";
}

async function indirectRepositoryTopology(
  root: string,
  markerPath: string,
  allowExternalMetadata: boolean
): Promise<RepositoryTopology | null> {
  const lexicalGitDir = await gitFileTarget(root, markerPath);
  if (!isInside(root, lexicalGitDir) && !allowExternalMetadata) {
    return {
      kind: indirectionKind(lexicalGitDir), worktreeRoot: root,
      gitDir: lexicalGitDir, commonDir: lexicalGitDir,
      objectDirs: [path.join(lexicalGitDir, "objects")], trust: "external_untrusted"
    };
  }
  const gitDir = await realpath(lexicalGitDir).catch(() => lexicalGitDir);
  const commonDir = await commonGitDirectory(gitDir);
  if (!await validGitDirectory(gitDir, commonDir)) return null;
  const trust = isInside(root, gitDir) && isInside(root, commonDir)
    ? "workspace" as const : "external_untrusted" as const;
  return {
    kind: indirectionKind(gitDir), worktreeRoot: root, gitDir, commonDir,
    objectDirs: [path.join(commonDir, "objects")], trust
  };
}

/** Inspect repository layout without folding process or sandbox failures into
 * a false "not a repository" result. External metadata is reported as an
 * explicit trust requirement and is never silently authorized. */
export async function repositoryTopology(
  workspace: string,
  signal: AbortSignal | undefined,
  _execution?: ProcessExecutionPort,
  options: { allowExternalMetadata?: boolean } = {}
): Promise<RepositoryTopology | null> {
  signal?.throwIfAborted();
  const root = await realpath(path.resolve(workspace));
  const markerPath = path.join(root, ".git");
  const marker = await lstat(markerPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!marker) return await bareRepositoryTopology(root);
  if (marker.isSymbolicLink() || (!marker.isDirectory() && !marker.isFile())) {
    throw Object.assign(new Error("Git metadata marker must be a stable directory or gitdir file."), {
      code: "git_probe_failed"
    });
  }
  if (marker.isDirectory()) return await directoryRepositoryTopology(root, markerPath);
  return await indirectRepositoryTopology(root, markerPath, options.allowExternalMetadata === true);
}

export async function gitPorcelain(
  workspace: string,
  signal: AbortSignal,
  execution: ProcessExecutionPort
): Promise<ProcessResult> {
  const topology = await repositoryTopology(workspace, signal, execution);
  if (!topology?.worktreeRoot || topology.trust === "external_untrusted") return {
    exitCode: 128,
    stdout: "",
    stderr: topology?.trust === "external_untrusted"
      ? "Git metadata is outside the trusted workspace."
      : "Workspace is not a self-contained Git repository.",
    timedOut: false,
    cancelled: false,
    durationMs: 0,
    stdoutLimitReached: false,
    outputTruncated: false
  };
  return await runLeasedRepositoryGit(
    execution,
    { ...topology, worktreeRoot: topology.worktreeRoot },
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    signal,
    2_000_000
  );
}
