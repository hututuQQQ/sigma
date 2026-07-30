import path from "node:path";
import type { RepositoryMetadataLease } from "agent-execution";
import { runProcess, type ProcessExecutionPort, type ProcessResult } from "./process.js";
import type { RepositoryTopology } from "./workspace.js";

const GIT_NULL_DEVICE = process.platform === "win32" ? "NUL" : "/dev/null";

export type RepositoryWorktreeTopology = RepositoryTopology & { worktreeRoot: string };

function gitReadEnvironment(): Record<string, string> {
  return {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: GIT_NULL_DEVICE,
    GIT_TERMINAL_PROMPT: "0",
    GIT_ALLOW_PROTOCOL: "",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_EDITOR: "true",
    GIT_SEQUENCE_EDITOR: "true"
  };
}

async function repositoryMetadataLease(
  execution: ProcessExecutionPort,
  topology: RepositoryWorktreeTopology,
  signal: AbortSignal
): Promise<RepositoryMetadataLease> {
  if (!execution.acquireRepositoryMetadataLease) {
    throw Object.assign(new Error("The execution broker does not expose repository metadata leases."), {
      code: "repository_metadata_lease_unavailable"
    });
  }
  return await execution.acquireRepositoryMetadataLease({
    protocolVersion: 1,
    repositoryRoot: topology.worktreeRoot,
    gitDir: topology.gitDir,
    commonDir: topology.commonDir,
    executable: "git",
    network: "none"
  }, { signal });
}

/**
 * Run one read-only Git command under a single-use broker capability that
 * binds the resolved Git executable and repository metadata roots together.
 */
export async function runLeasedRepositoryGit(
  execution: ProcessExecutionPort,
  topology: RepositoryWorktreeTopology,
  args: string[],
  signal: AbortSignal,
  maxOutputBytes: number
): Promise<ProcessResult> {
  signal.throwIfAborted();
  const lease = await repositoryMetadataLease(execution, topology, signal);
  return await runProcess({
    execution,
    executable: "git",
    args: [
      "-c", `core.hooksPath=${GIT_NULL_DEVICE}`,
      "-c", "core.fsmonitor=false",
      `--git-dir=${topology.gitDir}`,
      `--work-tree=${topology.worktreeRoot}`,
      ...args
    ],
    cwd: topology.worktreeRoot,
    env: gitReadEnvironment(),
    timeoutMs: 30_000,
    maxOutputBytes,
    signal,
    readRoots: [...new Set([
      topology.worktreeRoot,
      topology.gitDir,
      topology.commonDir,
      ...topology.objectDirs
    ])],
    writeRoots: [],
    protectedPaths: [path.join(topology.worktreeRoot, ".agent")],
    network: "none",
    repositoryMetadataLease: lease
  });
}
