import type { PlanGraph } from "agent-protocol";

export interface ChildPlanOutcome {
  childId: string;
  planNodeIds: readonly string[];
  outcome: "completed" | "failed" | "cancelled" | "blocked";
  evidence: { evidenceId: string; kind: "child_outcome" };
}

function returnedNode(
  node: PlanGraph["nodes"][number],
  input: ChildPlanOutcome
): PlanGraph["nodes"][number] {
  const returned: PlanGraph["nodes"][number] = {
    ...node,
    owner: { kind: "root" },
    evidence: node.evidence.some((item) => item.evidenceId === input.evidence.evidenceId)
      ? [...node.evidence]
      : [...node.evidence, input.evidence]
  };
  if (input.outcome === "completed") {
    returned.status = "in_progress";
    delete returned.blockedReason;
    return returned;
  }
  returned.status = "blocked";
  returned.blockedReason = `Child ${input.childId} ${input.outcome}.`;
  return returned;
}

export function planAfterChildOutcome(current: PlanGraph, input: ChildPlanOutcome): PlanGraph | null {
  const selected = new Set(input.planNodeIds);
  const ownedIds = new Set(current.nodes.flatMap((node) => selected.has(node.id)
    && node.owner.kind === "child" && node.owner.childId === input.childId ? [node.id] : []));
  if (ownedIds.size === 0) return null;
  return {
    ...current,
    revision: current.revision + 1,
    nodes: current.nodes.map((node) => ownedIds.has(node.id) ? returnedNode(node, input) : node)
  };
}

export function planAfterChildRollback(
  current: PlanGraph,
  childId: string,
  nodeIds: readonly string[],
  previous: PlanGraph
): PlanGraph | null {
  const selected = new Set(nodeIds);
  const previousById = new Map(previous.nodes.map((node) => [node.id, node]));
  const assignedIds = new Set(current.nodes.flatMap((node) => selected.has(node.id)
    && node.owner.kind === "child" && node.owner.childId === childId ? [node.id] : []));
  if (assignedIds.size === 0) return null;
  return {
    ...current,
    revision: current.revision + 1,
    ...(previous.activeNodeId && assignedIds.has(previous.activeNodeId)
      ? { activeNodeId: previous.activeNodeId } : {}),
    nodes: current.nodes.map((node) => assignedIds.has(node.id)
      ? structuredClone(previousById.get(node.id) ?? node)
      : node)
  };
}
