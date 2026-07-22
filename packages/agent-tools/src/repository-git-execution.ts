import path from "node:path";
import type { ToolExecutionContext } from "agent-protocol";
import type { RepositoryMetadataLeaseV1 } from "agent-execution";
import {
  repositoryMetadataTopologyCandidate,
  runProcess,
  type ProcessExecutionPort,
  type RepositoryTopologyV1
} from "agent-platform";

const GIT_NULL_DEVICE = process.platform === "win32" ? "NUL" : "/dev/null";

export type RepositoryWorktreeTopology = RepositoryTopologyV1 & { worktreeRoot: string };

export async function repositoryInspectionTopologyCandidate(
  context: Pick<ToolExecutionContext, "workspacePath" | "signal">
): Promise<RepositoryWorktreeTopology> {
  context.signal.throwIfAborted();
  const topology = await repositoryMetadataTopologyCandidate(context.workspacePath);
  if (!topology?.worktreeRoot) {
    throw Object.assign(new Error("Workspace is not a Git worktree."), {
      code: topology?.kind === "bare" ? "repository_bare" : "workspace_not_git_root"
    });
  }
  return { ...topology, worktreeRoot: topology.worktreeRoot };
}

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
): Promise<RepositoryMetadataLeaseV1> {
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

export async function runLeasedRepositoryGit(
  execution: ProcessExecutionPort,
  topology: RepositoryWorktreeTopology,
  args: string[],
  signal: AbortSignal,
  maxOutputBytes: number
) {
  // RepositoryMetadataLeaseV1 is consumed before broker validation/launch.
  // Every subprocess therefore needs a fresh capability.
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
      topology.worktreeRoot, topology.gitDir, topology.commonDir
    ])],
    writeRoots: [],
    protectedPaths: [path.join(topology.worktreeRoot, ".agent")],
    network: "none",
    repositoryMetadataLease: lease
  });
}
