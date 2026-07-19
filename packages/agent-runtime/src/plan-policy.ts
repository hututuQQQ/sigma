import { isPlanGraph, type EvidenceRecord, type PlanGraph } from "agent-protocol";

function assertNewlyCompletedEvidence(
  previous: PlanGraph,
  next: PlanGraph,
  currentRunEvidence: ReadonlyMap<string, EvidenceRecord>
): void {
  const previousById = new Map(previous.nodes.map((node) => [node.id, node]));
  for (const node of next.nodes.filter((item) => item.status === "completed")) {
    if (previousById.get(node.id)?.status === "completed") continue;
    const unknown = node.evidence.filter((reference) => {
      const evidence = currentRunEvidence.get(reference.evidenceId);
      return !evidence || evidence.kind !== reference.kind || evidence.status === "failed";
    });
    if (unknown.length > 0) {
      throw new Error(`Completed plan node '${node.id}' cites unavailable, failed, or mismatched evidence: ${unknown
        .map((item) => `${item.evidenceId}:${item.kind}`).join(", ")}.`);
    }
  }
}

export function assertPlanTransition(
  previous: PlanGraph,
  next: PlanGraph,
  currentRunEvidence: ReadonlyMap<string, EvidenceRecord>,
  allowChildOwnedChanges: boolean
): void {
  if (!isPlanGraph(next)) throw new Error("Plan graph is invalid, too large, or cyclic.");
  if (next.revision !== previous.revision + 1) throw new Error(`Plan revision must be ${previous.revision + 1}.`);
  if (next.goal !== previous.goal) {
    throw new Error("The durable plan goal is user-owned and cannot be rewritten by update_plan.");
  }
  const nextById = new Map(next.nodes.map((node) => [node.id, node]));
  assertCompletedNodesStable(previous, nextById);
  assertChildNodesStable(previous, nextById, allowChildOwnedChanges);
  assertDependenciesComplete(next, nextById);
  assertNewlyCompletedEvidence(previous, next, currentRunEvidence);
  assertActiveNode(next, nextById);
}

function assertCompletedNodesStable(previous: PlanGraph, nextById: Map<string, PlanGraph["nodes"][number]>): void {
  for (const node of previous.nodes.filter((item) => item.status === "completed")) {
    const replacement = nextById.get(node.id);
    if (!replacement) throw new Error(`Completed plan node '${node.id}' cannot be deleted.`);
    if (replacement.status === "completed" && JSON.stringify(replacement) !== JSON.stringify(node)) {
      throw new Error(`Completed plan node '${node.id}' cannot be modified without reopening it.`);
    }
    if (replacement.status !== "completed" && !replacement.reopenReason?.trim()) {
      throw new Error(`Reopening completed plan node '${node.id}' requires reopenReason.`);
    }
  }
}

function assertChildNodesStable(
  previous: PlanGraph,
  nextById: Map<string, PlanGraph["nodes"][number]>,
  allowChildOwnedChanges: boolean
): void {
  for (const node of previous.nodes.filter((item) => item.owner.kind === "child"
    && item.status !== "completed" && item.status !== "cancelled")) {
    const replacement = nextById.get(node.id);
    if (!replacement) throw new Error(`Active child-owned plan node '${node.id}' cannot be deleted.`);
    if (!allowChildOwnedChanges && JSON.stringify(replacement) !== JSON.stringify(node)) {
      throw new Error(`Active child-owned plan node '${node.id}' can only be changed by the runtime.`);
    }
  }
}

function assertDependenciesComplete(next: PlanGraph, nextById: Map<string, PlanGraph["nodes"][number]>): void {
  for (const node of next.nodes.filter((item) => item.status === "in_progress" || item.status === "completed")) {
    const incomplete = node.dependencies.filter((id) => nextById.get(id)?.status !== "completed");
    if (incomplete.length > 0) {
      throw new Error(`Plan node '${node.id}' cannot be ${node.status} before dependencies complete: ${incomplete.join(", ")}.`);
    }
  }
}

function assertActiveNode(next: PlanGraph, nextById: Map<string, PlanGraph["nodes"][number]>): void {
  if (next.activeNodeId) {
    const active = nextById.get(next.activeNodeId);
    if (!active || active.owner.kind !== "root" || active.status !== "in_progress") {
      throw new Error("activeNodeId must identify a root-owned in-progress node.");
    }
  }
}
