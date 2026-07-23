import { createHash } from "node:crypto";
import type { ProcessExecutionPort } from "agent-platform";
import {
  runLeasedRepositoryGit,
  type RepositoryWorktreeTopology
} from "agent-tools";

const CAPTURE_BYTES = 2 * 1024 * 1024;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function checkedGit(
  execution: ProcessExecutionPort,
  topology: RepositoryWorktreeTopology,
  args: string[],
  signal: AbortSignal,
  allowMissing = false
): Promise<string> {
  const result = await runLeasedRepositoryGit(
    execution, topology, args, signal, CAPTURE_BYTES
  );
  if (result.outputTruncated || (result.exitCode !== 0 && !(allowMissing && result.exitCode === 1))) {
    throw Object.assign(new Error(`Repository probe failed: git ${args[0] ?? "probe"}.`), {
      code: "repository_state_unavailable"
    });
  }
  return result.exitCode === 0 ? result.stdout : "";
}

export interface RepositoryEvidenceState {
  head: string | null;
  refsDigest: string;
  indexDigest: string;
  reachabilityDigest: string;
  reachableObjects: number;
  stateDigest: string;
}

export async function collectRepositoryEvidenceState(
  execution: ProcessExecutionPort,
  topology: RepositoryWorktreeTopology,
  signal: AbortSignal
): Promise<RepositoryEvidenceState> {
  const [headOutput, refs, index, reachable] = await Promise.all([
    checkedGit(execution, topology, ["rev-parse", "--verify", "--quiet", "HEAD"], signal, true),
    checkedGit(execution, topology, ["show-ref", "--head"], signal, true),
    checkedGit(execution, topology, ["ls-files", "--stage", "-z"], signal),
    checkedGit(execution, topology, ["rev-list", "--objects", "--all"], signal)
  ]);
  const head = headOutput.trim().toLowerCase() || null;
  const value = {
    head,
    refsDigest: sha256(refs),
    indexDigest: sha256(index),
    reachabilityDigest: sha256(reachable),
    reachableObjects: reachable.split(/\r?\n/u).filter(Boolean).length
  };
  return { ...value, stateDigest: sha256(JSON.stringify(value)) };
}

export async function repositoryObjectIsAncestor(
  execution: ProcessExecutionPort,
  topology: RepositoryWorktreeTopology,
  ancestor: string,
  descendant: string,
  signal: AbortSignal
): Promise<boolean> {
  const result = await runLeasedRepositoryGit(execution, topology, [
    "merge-base", "--is-ancestor", ancestor, descendant
  ], signal, 64 * 1024);
  if (result.outputTruncated || (result.exitCode !== 0 && result.exitCode !== 1)) {
    throw Object.assign(new Error("Repository ancestry postcondition could not be verified."), {
      code: "repository_postcondition_failed"
    });
  }
  return result.exitCode === 0;
}

/** Return only bounded, repository-relative unmerged paths. The broker-owned
 * transaction remains the mutation authority; this probe merely gives the
 * repair state machine an exact workspace scope. */
export async function repositoryConflictPaths(
  execution: ProcessExecutionPort,
  topology: RepositoryWorktreeTopology,
  signal: AbortSignal
): Promise<string[]> {
  const output = await checkedGit(execution, topology, [
    "diff", "--name-only", "--diff-filter=U", "-z", "--"
  ], signal);
  const paths = output.split("\0").filter(Boolean).map((item) => item.replaceAll("\\", "/"));
  if (paths.length === 0 || paths.length > 4_096
    || paths.some((item) => item.startsWith("/") || item.startsWith(":")
      || item.split("/").some((part) => part === ".." || part.toLowerCase() === ".git"))) {
    throw Object.assign(new Error(
      "Repository conflict paths were missing, excessive, or outside the worktree policy."
    ), { code: "repository_state_uncertain" });
  }
  return [...new Set(paths)].sort();
}

export interface RepositoryRevisionDelta {
  added: string[];
  modified: string[];
  deleted: string[];
  reviewDiff?: string;
  reviewDiffPaths: string[];
}

function parseNameStatus(value: string): Omit<RepositoryRevisionDelta, "reviewDiff" | "reviewDiffPaths"> {
  const fields = value.split("\0").filter(Boolean);
  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const status = fields[index]!;
    const file = fields[index + 1]!.replaceAll("\\", "/");
    if (status === "A") added.push(file);
    else if (status === "D") deleted.push(file);
    else modified.push(file);
  }
  return {
    added: [...new Set(added)].sort(),
    modified: [...new Set(modified)].sort(),
    deleted: [...new Set(deleted)].sort()
  };
}

export async function repositoryRevisionDelta(
  execution: ProcessExecutionPort,
  topology: RepositoryWorktreeTopology,
  beforeHead: string | null,
  afterHead: string | null,
  signal: AbortSignal
): Promise<RepositoryRevisionDelta> {
  if (!beforeHead || !afterHead || beforeHead === afterHead) {
    return { added: [], modified: [], deleted: [], reviewDiffPaths: [] };
  }
  const names = await checkedGit(execution, topology, [
    "diff", "--no-ext-diff", "--no-renames", "--name-status", "-z", beforeHead, afterHead, "--"
  ], signal);
  const delta = parseNameStatus(names);
  const reviewDiffPaths = [...new Set([
    ...delta.added, ...delta.modified, ...delta.deleted
  ])].sort();
  const patch = await runLeasedRepositoryGit(execution, topology, [
    "diff", "--no-ext-diff", "--no-renames", "--binary", beforeHead, afterHead, "--"
  ], signal, CAPTURE_BYTES);
  return {
    ...delta,
    reviewDiffPaths,
    ...(!patch.outputTruncated && patch.exitCode === 0 && patch.stdout
      ? { reviewDiff: patch.stdout } : {})
  };
}
