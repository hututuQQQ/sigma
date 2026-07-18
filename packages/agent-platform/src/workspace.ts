import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { runProcess, type ProcessExecutionPort, type ProcessResult } from "./process.js";

export interface RepositoryTopologyV1 {
  kind: "worktree" | "linked_worktree" | "submodule" | "bare";
  worktreeRoot: string | null;
  gitDir: string;
  commonDir: string;
  objectDirs: string[];
  trust: "workspace" | "external_trusted" | "external_untrusted";
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
  execution: ProcessExecutionPort
): Promise<string | null> {
  signal?.throwIfAborted();
  const root = await realpath(path.resolve(workspace));
  const marker = await lstat(path.join(root, ".git")).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!marker || marker.isSymbolicLink()) return null;
  const processSignal = signal ?? new AbortController().signal;
  const result = await runProcess({
    execution,
    executable: "git", args: ["rev-parse", "--show-toplevel"], cwd: root,
    timeoutMs: 10_000, maxOutputBytes: 16_384, signal: processSignal
  }).catch((error) => {
    processSignal.throwIfAborted();
    throw Object.assign(new Error(
      `Git root probe could not execute: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    ), { code: "git_probe_failed" });
  });
  processSignal.throwIfAborted();
  if (result.failure) {
    throw Object.assign(new Error(
      `Git root probe failed before process start [${result.failure.code}]: ${result.failure.message}`
    ), {
      code: "git_probe_failed",
      cause: result.failure,
      sandboxFailure: result.failure
    });
  }
  if (result.exitCode !== 0) {
    throw Object.assign(new Error(
      `Git root probe exited with ${String(result.exitCode)}: ${result.stderr.trim() || "no stderr"}`
    ), {
      code: "git_probe_failed",
      exitCode: result.exitCode,
      stderr: result.stderr
    });
  }
  const reported = result.stdout.trim();
  if (!reported) return null;
  const canonical = await realpath(path.resolve(root, reported)).catch(() => path.resolve(root, reported));
  return path.relative(root, canonical) === "" ? root : null;
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
  const commondir = await readFile(path.join(gitDir, "commondir"), "utf8").catch(() => "");
  if (!commondir.trim()) return gitDir;
  return await realpath(path.resolve(gitDir, commondir.trim())).catch(() =>
    path.resolve(gitDir, commondir.trim()));
}

async function bareRepositoryTopology(root: string): Promise<RepositoryTopologyV1 | null> {
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
  markerPath: string,
  signal: AbortSignal | undefined,
  execution: ProcessExecutionPort
): Promise<RepositoryTopologyV1 | null> {
  const worktreeRoot = await selfContainedGitRoot(root, signal, execution);
  if (!worktreeRoot) return null;
  return {
    kind: "worktree", worktreeRoot, gitDir: markerPath, commonDir: markerPath,
    objectDirs: [path.join(markerPath, "objects")], trust: "workspace"
  };
}

function indirectionKind(gitDir: string): "submodule" | "linked_worktree" {
  return /(?:^|[\\/])modules(?:[\\/]|$)/iu.test(gitDir) ? "submodule" : "linked_worktree";
}

async function indirectRepositoryTopology(
  root: string,
  markerPath: string,
  allowExternalMetadata: boolean
): Promise<RepositoryTopologyV1> {
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
  execution: ProcessExecutionPort,
  options: { allowExternalMetadata?: boolean } = {}
): Promise<RepositoryTopologyV1 | null> {
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
  if (marker.isDirectory()) return await directoryRepositoryTopology(root, markerPath, signal, execution);
  return await indirectRepositoryTopology(root, markerPath, options.allowExternalMetadata === true);
}

export async function gitPorcelain(
  workspace: string,
  signal: AbortSignal,
  execution: ProcessExecutionPort
): Promise<ProcessResult> {
  const root = await selfContainedGitRoot(workspace, signal, execution);
  if (!root) return {
    exitCode: 128,
    stdout: "",
    stderr: "Workspace is not a self-contained Git repository.",
    timedOut: false,
    cancelled: false,
    durationMs: 0,
    stdoutLimitReached: false,
    outputTruncated: false
  };
  return await runProcess({
    execution,
    executable: "git",
    args: ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    cwd: root,
    timeoutMs: 30_000,
    signal
  });
}
