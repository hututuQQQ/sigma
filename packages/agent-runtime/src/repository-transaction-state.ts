import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runProcess, type ProcessExecutionPort } from "agent-platform";

export interface RepositoryGitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
}

export const GIT_NULL_DEVICE = process.platform === "win32" ? "NUL" : os.devNull;

function gitEnvironment(): Record<string, string> {
  return {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: GIT_NULL_DEVICE,
    GIT_TERMINAL_PROMPT: "0",
    GIT_ALLOW_PROTOCOL: "",
    GIT_EDITOR: "true",
    GIT_SEQUENCE_EDITOR: "true"
  };
}

export async function runGit(
  execution: ProcessExecutionPort,
  root: string,
  metadataRoots: string[],
  args: string[],
  hooks: string,
  signal: AbortSignal,
  sessionId?: string
): Promise<RepositoryGitResult> {
  const gitDir = metadataRoots[0]!;
  const bare = path.relative(root, gitDir) === "";
  const repositoryMetadataLease = execution.acquireRepositoryMetadataLease
    ? await execution.acquireRepositoryMetadataLease({
      protocolVersion: 1,
      repositoryRoot: root,
      gitDir,
      commonDir: metadataRoots[1] ?? gitDir,
      executable: "git",
      network: "none"
    }, { signal })
    : undefined;
  const result = await runProcess({
    execution,
    executable: "git",
    args: [
      "-c", `core.hooksPath=${hooks}`,
      "-c", "core.fsmonitor=false",
      `--git-dir=${gitDir}`,
      ...(bare ? [] : [`--work-tree=${root}`]),
      ...args
    ],
    cwd: root,
    env: gitEnvironment(),
    timeoutMs: 600_000,
    maxOutputBytes: 16 * 1024 * 1024,
    signal,
    readRoots: [...new Set([root, ...metadataRoots])],
    writeRoots: [...new Set([root, ...metadataRoots])],
    protectedPaths: [path.join(root, ".agent")],
    ...(repositoryMetadataLease ? { repositoryMetadataLease } : {}),
    network: "none",
    ...(sessionId ? { scratchSessionId: sessionId } : {})
  });
  return {
    exitCode: result.exitCode ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
    outputTruncated: result.outputTruncated
  };
}

function sha(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function conflictPathCount(value: string): number {
  const paths = new Set<string>();
  for (const entry of value.split("\0")) {
    if (!entry) continue;
    const separator = entry.indexOf("\t");
    if (separator >= 0 && separator + 1 < entry.length) paths.add(entry.slice(separator + 1));
  }
  return paths.size;
}

function repositoryStateUnavailable(component: string, cause?: unknown): Error {
  return Object.assign(new Error(`Repository ${component} state could not be inspected.`, {
    ...(cause === undefined ? {} : { cause })
  }), { code: "repository_state_unavailable" });
}

function checkedHead(result: RepositoryGitResult): string | null {
  const missing = result.exitCode === 1 && result.stdout.length === 0 && result.stderr.length === 0;
  if (result.outputTruncated
    || (result.exitCode !== 0 && !missing)
    || (result.exitCode === 0 && result.stdout.trim().length === 0)) {
    throw repositoryStateUnavailable("HEAD");
  }
  return missing ? null : result.stdout.trim();
}

function assertRepositoryStateResult(
  component: string,
  result: RepositoryGitResult,
  allowedMissing = false
): void {
  const missing = allowedMissing
    && result.exitCode === 1
    && result.stdout.length === 0
    && result.stderr.length === 0;
  if (result.outputTruncated || (result.exitCode !== 0 && !missing)) {
    throw repositoryStateUnavailable(component);
  }
}

async function repositoryIndex(gitDir: string): Promise<Buffer> {
  return await readFile(path.join(gitDir, "index")).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return Buffer.alloc(0);
    throw repositoryStateUnavailable("index", error);
  });
}

export async function repositoryState(
  execution: ProcessExecutionPort,
  root: string,
  gitDir: string,
  metadataRoots: string[],
  hooks: string,
  signal: AbortSignal,
  sessionId?: string
) {
  const command = async (args: string[]): Promise<RepositoryGitResult> =>
    await runGit(execution, root, metadataRoots, args, hooks, signal, sessionId);
  const headResult = await command(["rev-parse", "--verify", "--quiet", "HEAD"]);
  const refs = await command(["show-ref", "--head"]);
  const objects = await command(["rev-list", "--objects", "--all"]);
  const conflicts = await command(["ls-files", "--unmerged", "-z"]);
  const head = checkedHead(headResult);
  assertRepositoryStateResult("refs", refs, true);
  assertRepositoryStateResult("reachability", objects);
  assertRepositoryStateResult("conflict", conflicts);
  const index = await repositoryIndex(gitDir);
  const state = {
    head,
    refsDigest: sha(refs.stdout),
    indexDigest: sha(index),
    reachableObjects: objects.stdout.split(/\r?\n/u).filter(Boolean).length,
    conflictsDigest: sha(conflicts.stdout),
    conflictCount: conflictPathCount(conflicts.stdout)
  };
  return { ...state, stateDigest: sha(JSON.stringify(state)) };
}

export async function assertNoExternalDrivers(
  execution: ProcessExecutionPort,
  root: string,
  metadataRoots: string[],
  hooks: string,
  signal: AbortSignal,
  sessionId?: string
): Promise<void> {
  const config = await runGit(execution, root, metadataRoots, ["config", "--local", "--includes", "--get-regexp",
    "^(include(if)?\\..*\\.path|merge\\..*\\.driver|diff\\..*\\.command|filter\\..*\\.(clean|smudge|process)|core\\.(fsmonitor|sshcommand)|commit\\.gpgsign|tag\\.gpgsign|gpg\\..*\\.program)$"], hooks, signal, sessionId);
  if (config.outputTruncated || (config.exitCode !== 0 && config.exitCode !== 1)) {
    throw repositoryStateUnavailable("configuration");
  }
  if (config.exitCode === 0 && config.stdout.trim()) {
    throw Object.assign(new Error("Repository config contains an external driver or helper."), {
      code: "repository_external_helper_denied"
    });
  }
}
