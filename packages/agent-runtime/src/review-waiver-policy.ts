import type { EvidenceRecord, WorkspaceDeltaEvidence } from "agent-protocol";

/** Assign each user waiver to at most one non-documentation delta. An explicit
 * checkpoint target wins; otherwise event order deterministically consumes the
 * waiver on the first still-unassigned reviewable delta in the run. */
export function reviewerWaivedDeltaIds(evidence: readonly EvidenceRecord[]): ReadonlySet<string> {
  const deltas = evidence.filter((item): item is WorkspaceDeltaEvidence =>
    item.kind === "workspace_delta" && item.status === "passed");
  const assigned = new Set<string>();
  for (const waiver of evidence.filter((item): item is Extract<EvidenceRecord, { kind: "user_waiver" }> =>
    item.kind === "user_waiver" && item.data.scope === "review")) {
    const selected = waiver.data.checkpointId
      ? deltas.find((delta) => delta.data.checkpointId === waiver.data.checkpointId && !assigned.has(delta.evidenceId))
      : deltas.find((delta) => delta.runId === waiver.runId && !assigned.has(delta.evidenceId));
    if (selected) assigned.add(selected.evidenceId);
  }
  return assigned;
}
