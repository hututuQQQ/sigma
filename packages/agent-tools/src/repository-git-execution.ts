import type { ToolExecutionContext } from "agent-protocol";
import {
  repositoryMetadataTopologyCandidate,
  runLeasedRepositoryGit as runPlatformLeasedRepositoryGit,
  type ProcessExecutionPort,
  type RepositoryTopology
} from "agent-platform";

export type RepositoryWorktreeTopology = RepositoryTopology & { worktreeRoot: string };

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

export async function runLeasedRepositoryGit(
  execution: ProcessExecutionPort,
  topology: RepositoryWorktreeTopology,
  args: string[],
  signal: AbortSignal,
  maxOutputBytes: number
) {
  return await runPlatformLeasedRepositoryGit(
    execution, topology, args, signal, maxOutputBytes
  );
}
