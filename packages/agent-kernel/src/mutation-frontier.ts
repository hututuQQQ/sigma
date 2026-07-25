import { createHash } from "node:crypto";
import type {
  CheckpointRef,
  DiagnosticEvidence,
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
    environmentChangedPaths: [],
    sourceCheckpointIds: []
  };
}

export function acceptMutationFrontier(frontier: MutationFrontier): MutationFrontier {
  return {
    revision: frontier.revision,
    baselineManifestDigest: frontier.currentStateDigest,
    currentStateDigest: frontier.currentStateDigest,
    changedPaths: [],
    environmentChangedPaths: [],
    sourceCheckpointIds: []
  };
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function isEnclosingContainerMutationEvidence(
  evidence: EvidenceRecord
): evidence is DiagnosticEvidence {
  if (evidence.kind !== "diagnostic"
    || evidence.data.source !== "enclosing_container_mutation") return false;
  const diagnostic = record(evidence.data.diagnostic);
  return diagnostic?.schemaVersion === 1
    && diagnostic.scope === "enclosing_container"
    && Array.isArray(diagnostic.declaredPaths)
    && diagnostic.declaredPaths.length > 0
    && diagnostic.declaredPaths.every((item) =>
      typeof item === "string" && item.length > 0);
}

export function mutationFrontierHasChanges(frontier: MutationFrontier): boolean {
  return frontier.changedPaths.length > 0
    || (frontier.environmentChangedPaths?.length ?? 0) > 0;
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
  if (checkpoint.status === "sealed" && checkpoint.delta) {
    const emptyDelta = checkpoint.delta.added.length === 0
      && checkpoint.delta.modified.length === 0
      && checkpoint.delta.deleted.length === 0;
    if (emptyDelta) {
      if (checkpoint.postManifestDigest !== checkpoint.preManifestDigest) {
        throw Object.assign(new Error(
          `Checkpoint '${checkpoint.checkpointId}' has an empty delta but different pre/post manifests.`
        ), { code: "checkpoint_integrity_error" });
      }
      return frontier;
    }
  }
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
  if (isEnclosingContainerMutationEvidence(evidence)) {
    const diagnostic = record(evidence.data.diagnostic)!;
    const declaredPaths = diagnostic.declaredPaths as string[];
    const environmentChangedPaths = [...new Set([
      ...(frontier.environmentChangedPaths ?? []),
      ...declaredPaths
    ])].sort();
    return {
      ...frontier,
      revision: frontier.revision + 1,
      environmentChangedPaths,
      currentStateDigest: digest({
        priorStateDigest: frontier.currentStateDigest,
        environmentMutationEvidenceId: evidence.evidenceId,
        environmentChangedPaths,
        resultDigest: diagnostic.resultDigest ?? null,
        ok: diagnostic.ok ?? null
      })
    };
  }
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
  const worktreePaths = repository.data.worktreeDelta ? [
    ...repository.data.worktreeDelta.added,
    ...repository.data.worktreeDelta.modified,
    ...repository.data.worktreeDelta.deleted
  ] : [];
  return {
    ...frontier,
    revision: frontier.revision + 1,
    repositoryStateDigest: repository.data.afterStateDigest,
    changedPaths: [...new Set([...frontier.changedPaths, ...worktreePaths, ".git"])].sort(),
    currentStateDigest: digest({
      workspaceStateDigest: frontier.currentStateDigest,
      repositoryStateDigest: repository.data.afterStateDigest
    })
  };
}
