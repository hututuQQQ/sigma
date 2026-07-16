import { createHash } from "node:crypto";
import type {
  CheckpointRef,
  EvidenceRecord,
  MutationFrontier,
  RepositoryDeltaEvidence,
  WorkspaceDeltaEvidence
} from "agent-protocol";

export const EMPTY_FRONTIER_DIGEST = "0".repeat(64);

export function emptyMutationFrontier(): MutationFrontier {
  return {
    revision: 0,
    baselineManifestDigest: EMPTY_FRONTIER_DIGEST,
    currentStateDigest: EMPTY_FRONTIER_DIGEST,
    changedPaths: [],
    sourceCheckpointIds: []
  };
}

export function acceptMutationFrontier(frontier: MutationFrontier): MutationFrontier {
  return {
    revision: frontier.revision,
    baselineManifestDigest: frontier.currentStateDigest,
    currentStateDigest: frontier.currentStateDigest,
    changedPaths: [],
    sourceCheckpointIds: []
  };
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function activeDeltas(evidence: readonly EvidenceRecord[]): WorkspaceDeltaEvidence[] {
  return evidence.filter((item): item is WorkspaceDeltaEvidence =>
    item.kind === "workspace_delta" && item.status === "passed");
}

function frontierNetChangedPaths(
  evidence: readonly EvidenceRecord[],
  sourceCheckpointIds: readonly string[]
): string[] {
  const active = new Set(sourceCheckpointIds);
  return netChangedPaths(evidence.filter((item) =>
    item.kind !== "workspace_delta" || active.has(item.data.checkpointId)));
}

/** Collapse sequential checkpoint deltas into a conservative baseline-to-now
 * path set. Added-then-deleted paths disappear; delete-then-add paths become
 * modified. Reverting bytes through a later edit may remain conservatively
 * modified, which is safe because it only asks for validation. */
export function netChangedPaths(evidence: readonly EvidenceRecord[]): string[] {
  const states = new Map<string, "added" | "modified" | "deleted">();
  for (const item of activeDeltas(evidence)) {
    for (const path of item.data.delta.added) {
      const before = states.get(path);
      states.set(path, before === "deleted" || before === "modified" ? "modified" : "added");
    }
    for (const path of item.data.delta.modified) {
      if (states.get(path) !== "added") states.set(path, "modified");
    }
    for (const path of item.data.delta.deleted) {
      if (states.get(path) === "added") states.delete(path);
      else states.set(path, "deleted");
    }
  }
  return [...states.keys()].sort();
}

export function frontierAfterCheckpoint(
  frontier: MutationFrontier,
  checkpoint: CheckpointRef,
  mutationEvidence: readonly EvidenceRecord[]
): MutationFrontier {
  const sourceCheckpointIds = checkpoint.status === "restored"
    ? frontier.sourceCheckpointIds.filter((id) => id !== checkpoint.checkpointId)
    : [...new Set([...frontier.sourceCheckpointIds, checkpoint.checkpointId])];
  const baselineManifestDigest = frontier.revision === 0
    ? checkpoint.preManifestDigest : frontier.baselineManifestDigest;
  const imageDigest = checkpoint.status === "restored"
    ? checkpoint.preManifestDigest
    : checkpoint.postManifestDigest ?? checkpoint.preManifestDigest;
  const currentStateDigest = digest({
    baselineManifestDigest,
    priorStateDigest: frontier.currentStateDigest,
    checkpointId: checkpoint.checkpointId,
    checkpointStatus: checkpoint.status,
    imageDigest,
    repositoryStateDigest: frontier.repositoryStateDigest ?? null
  });
  return {
    ...frontier,
    revision: frontier.revision + 1,
    baselineManifestDigest,
    currentStateDigest,
    changedPaths: [...new Set([
      ...frontierNetChangedPaths(mutationEvidence, sourceCheckpointIds),
      ...(frontier.repositoryStateDigest ? [".git"] : [])
    ])].sort(),
    sourceCheckpointIds
  };
}

export function frontierAfterEvidence(
  frontier: MutationFrontier,
  mutationEvidence: readonly EvidenceRecord[],
  evidence: EvidenceRecord
): MutationFrontier {
  if (evidence.kind === "checkpoint" && evidence.data.sourceSessionId) {
    const baselineManifestDigest = frontier.revision === 0
      ? evidence.data.preManifestDigest : frontier.baselineManifestDigest;
    const imageDigest = evidence.data.postManifestDigest ?? evidence.data.preManifestDigest;
    return {
      ...frontier,
      revision: frontier.revision + 1,
      baselineManifestDigest,
      currentStateDigest: digest({
        priorStateDigest: frontier.currentStateDigest,
        checkpointId: evidence.data.checkpointId,
        imageDigest,
        repositoryStateDigest: frontier.repositoryStateDigest ?? null
      }),
      sourceCheckpointIds: [...new Set([...frontier.sourceCheckpointIds, evidence.data.checkpointId])]
    };
  }
  if (evidence.kind === "workspace_delta") {
    return { ...frontier, changedPaths: [...new Set([
      ...frontierNetChangedPaths(mutationEvidence, frontier.sourceCheckpointIds),
      ...(frontier.repositoryStateDigest ? [".git"] : [])
    ])].sort() };
  }
  if (evidence.kind !== "repository_delta") return frontier;
  const repository = evidence as RepositoryDeltaEvidence;
  return {
    ...frontier,
    revision: frontier.revision + 1,
    repositoryStateDigest: repository.data.afterStateDigest,
    changedPaths: [...new Set([...frontier.changedPaths, ".git"])].sort(),
    currentStateDigest: digest({
      workspaceStateDigest: frontier.currentStateDigest,
      repositoryStateDigest: repository.data.afterStateDigest
    })
  };
}
