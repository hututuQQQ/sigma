import { createHash } from "node:crypto";
import {
  isPlanGraph,
  type ModelPlanNormalizationWarningV3,
  type ModelPlanProjectionV3,
  type ModelPlanUpdateV2,
  type ModelPlanUpdateV3,
  type PlanGraph
} from "agent-protocol";

function trimmed(value: string | undefined): string {
  return value?.trim() ?? "";
}

function uniqueText(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function normalizedStep(value: string): string {
  return value.trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
}

export function modelPlanProjection(plan: PlanGraph): ModelPlanProjectionV3 {
  const roots = plan.nodes.filter((node) => node.owner.kind === "root"
    && node.status !== "cancelled");
  return {
    revision: plan.revision,
    goal: plan.goal,
    acceptanceCriteria: uniqueText(roots.flatMap((node) => node.acceptanceCriteria)),
    ...(plan.activeNodeId ? { activeStepId: plan.activeNodeId } : {}),
    plan: roots.map((node) => ({
      id: node.id,
      step: node.title,
      status: node.status === "cancelled" ? "pending" : node.status,
      ...(node.blockedReason ? { blockedReason: node.blockedReason } : {})
    }))
  };
}

function stableStepId(title: string, used: ReadonlySet<string>): string {
  const base = `step-${createHash("sha256")
    .update(normalizedStep(title)).digest("hex").slice(0, 12)}`;
  if (!used.has(base)) return base;
  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
  throw new Error("Unable to allocate a unique plan step identifier.");
}

export function isLegacyPlanUpdate(
  input: ModelPlanUpdateV3 | ModelPlanUpdateV2
): input is ModelPlanUpdateV2 {
  return Object.hasOwn(input, "nodes");
}

type PlanNode = PlanGraph["nodes"][number];

interface RootChecklistNormalization {
  roots: PlanNode[];
  currentRoots: PlanNode[];
  currentById: Map<string, PlanNode>;
  requestedIds: Set<string>;
  usedIds: Set<string>;
}

function planSchemaError(message: string): Error {
  return Object.assign(new Error(message), { code: "plan_schema_invalid" });
}

function validateRequestedStep(
  requested: ModelPlanUpdateV3["plan"][number],
  index: number
): string {
  const title = trimmed(requested.step);
  if (!title
    || !["pending", "in_progress", "blocked", "completed"].includes(requested.status)) {
    throw planSchemaError(`Plan step ${index + 1} is invalid.`);
  }
  return title;
}

function resolvedStepIdentity(
  requested: ModelPlanUpdateV3["plan"][number],
  title: string,
  currentById: ReadonlyMap<string, PlanNode>,
  currentByTitle: ReadonlyMap<string, PlanNode>,
  usedIds: Set<string>,
  requestedIds: Set<string>,
  warnings: ModelPlanNormalizationWarningV3[]
): { id: string; previous?: PlanNode } {
  const previous = (requested.id ? currentById.get(requested.id) : undefined)
    ?? currentByTitle.get(normalizedStep(title));
  let id = previous?.id ?? trimmed(requested.id);
  if (!id || usedIds.has(id) || requestedIds.has(id)) {
    id = stableStepId(title, new Set([...usedIds, ...requestedIds]));
    warnings.push({
      code: "step_id_regenerated",
      stepId: id,
      message: `Allocated stable identifier '${id}' for '${title}'.`
    });
  }
  requestedIds.add(id);
  usedIds.add(id);
  return { id, ...(previous ? { previous } : {}) };
}

function normalizedBlockedReason(
  requested: ModelPlanUpdateV3["plan"][number],
  id: string,
  warnings: ModelPlanNormalizationWarningV3[]
): string {
  const supplied = trimmed(requested.blockedReason);
  if (requested.status !== "blocked" || supplied) return supplied;
  warnings.push({
    code: "blocked_reason_defaulted",
    stepId: id,
    message: `Added a durable blocked reason for '${id}'.`
  });
  return "Blocked in the model work plan.";
}

function normalizedRequestedRoot(
  input: ModelPlanUpdateV3,
  requested: ModelPlanUpdateV3["plan"][number],
  index: number,
  maps: {
    currentById: ReadonlyMap<string, PlanNode>;
    currentByTitle: ReadonlyMap<string, PlanNode>;
  },
  identifiers: { usedIds: Set<string>; requestedIds: Set<string> },
  warnings: ModelPlanNormalizationWarningV3[]
): PlanNode {
  const title = validateRequestedStep(requested, index);
  const { id, previous } = resolvedStepIdentity(
    requested,
    title,
    maps.currentById,
    maps.currentByTitle,
    identifiers.usedIds,
    identifiers.requestedIds,
    warnings
  );
  if (previous?.status === "completed" && requested.status === "completed") {
    if (previous.title !== title) {
      warnings.push({
        code: "completed_step_preserved",
        stepId: id,
        message: `Preserved completed step '${id}' without rewriting its durable history.`
      });
    }
    return previous;
  }
  const reopened = previous?.status === "completed";
  if (reopened) {
    warnings.push({
      code: "completed_step_reopened",
      stepId: id,
      message: `Reopened completed step '${id}' using runtime-owned transition metadata.`
    });
  }
  const blockedReason = normalizedBlockedReason(requested, id, warnings);
  return {
    id,
    title,
    dependencies: [],
    status: requested.status,
    owner: { kind: "root" },
    acceptanceCriteria: previous?.acceptanceCriteria ?? [],
    evidence: previous?.evidence ?? [],
    ...(blockedReason ? { blockedReason } : {}),
    ...(reopened
      ? { reopenReason: trimmed(input.explanation) || "Reopened by a model checklist update." }
      : {})
  };
}

function normalizeRootChecklist(
  current: PlanGraph,
  input: ModelPlanUpdateV3,
  warnings: ModelPlanNormalizationWarningV3[]
): RootChecklistNormalization {
  const currentRoots = current.nodes.filter((node) => node.owner.kind === "root");
  const currentById = new Map(currentRoots.map((node) => [node.id, node] as const));
  const currentByTitle = new Map(currentRoots.map((node) =>
    [normalizedStep(node.title), node] as const));
  const usedIds = new Set(current.nodes.filter((node) => node.owner.kind === "child")
    .map((node) => node.id));
  const requestedIds = new Set<string>();
  const identifiers = { usedIds, requestedIds };
  const maps = { currentById, currentByTitle };
  const roots = input.plan.map((requested, index) =>
    normalizedRequestedRoot(input, requested, index, maps, identifiers, warnings));
  return { roots, currentRoots, currentById, requestedIds, usedIds };
}

function preserveCompletedRoots(
  normalization: RootChecklistNormalization,
  warnings: ModelPlanNormalizationWarningV3[]
): void {
  for (const completed of normalization.currentRoots.filter((node) =>
    node.status === "completed" && !normalization.requestedIds.has(node.id))) {
    normalization.roots.push(completed);
    warnings.push({
      code: "completed_step_preserved",
      stepId: completed.id,
      message: `Preserved omitted completed step '${completed.id}' as durable plan history.`
    });
  }
}

function runtimeDependencyRootIds(
  children: readonly PlanNode[],
  currentById: ReadonlyMap<string, PlanNode>
): Set<string> {
  const queue = children.flatMap((node) => node.dependencies);
  const result = new Set<string>();
  while (queue.length > 0) {
    const dependencyId = queue.shift()!;
    if (result.has(dependencyId)) continue;
    const dependency = currentById.get(dependencyId);
    if (!dependency) continue;
    result.add(dependencyId);
    queue.push(...dependency.dependencies);
  }
  return result;
}

function preserveRuntimeDependencies(
  normalization: RootChecklistNormalization,
  children: readonly PlanNode[],
  warnings: ModelPlanNormalizationWarningV3[]
): void {
  const dependencyIds = runtimeDependencyRootIds(children, normalization.currentById);
  for (const dependency of normalization.currentRoots.filter((node) =>
    dependencyIds.has(node.id)
    && !normalization.roots.some((root) => root.id === node.id))) {
    normalization.roots.push(dependency);
    warnings.push({
      code: "runtime_dependency_preserved",
      stepId: dependency.id,
      message: `Preserved '${dependency.id}' because a runtime-owned child node depends on it.`
    });
  }
}

function acceptanceChangedAfterCompletion(
  input: ModelPlanUpdateV3,
  acceptanceCriteria: readonly string[],
  current: PlanGraph
): boolean {
  return input.acceptanceCriteria !== undefined
    && JSON.stringify(acceptanceCriteria)
      !== JSON.stringify(modelPlanProjection(current).acceptanceCriteria);
}

function attachAcceptanceCriteria(
  current: PlanGraph,
  input: ModelPlanUpdateV3,
  normalization: RootChecklistNormalization,
  warnings: ModelPlanNormalizationWarningV3[]
): void {
  const acceptanceCriteria = input.acceptanceCriteria
    ? uniqueText(input.acceptanceCriteria)
    : modelPlanProjection(current).acceptanceCriteria;
  let target = [...normalization.roots].reverse().find((node) => node.status !== "completed")
    ?? [...normalization.roots].reverse().find((node) =>
      normalization.currentById.get(node.id)?.status !== "completed");
  if (!target && acceptanceChangedAfterCompletion(input, acceptanceCriteria, current)) {
    const title = "Reconcile updated acceptance criteria";
    const id = stableStepId(title, new Set([
      ...normalization.usedIds,
      ...normalization.requestedIds
    ]));
    target = {
      id,
      title,
      dependencies: [],
      status: "in_progress",
      owner: { kind: "root" },
      acceptanceCriteria: [],
      evidence: []
    };
    normalization.roots.push(target);
    warnings.push({
      code: "active_step_selected",
      stepId: id,
      message: "Added an active checklist step because acceptance criteria changed after all prior steps completed."
    });
  }
  if (target) target.acceptanceCriteria = acceptanceCriteria;
}

function normalizeActiveRoot(
  current: PlanGraph,
  roots: PlanNode[],
  warnings: ModelPlanNormalizationWarningV3[]
): PlanNode | undefined {
  const requestedActive = roots.filter((node) => node.status === "in_progress");
  let active = requestedActive.find((node) => node.id === current.activeNodeId)
    ?? requestedActive.at(0);
  if (requestedActive.length > 1) {
    for (const extra of requestedActive) {
      if (extra.id !== active?.id) extra.status = "pending";
    }
    warnings.push({
      code: "multiple_active_steps",
      ...(active ? { stepId: active.id } : {}),
      message: `Normalized ${requestedActive.length} in-progress steps to one active step.`
    });
  }
  if (active) return active;
  active = roots.find((node) => node.status === "pending");
  if (!active) return undefined;
  active.status = "in_progress";
  warnings.push({
    code: "active_step_selected",
    stepId: active.id,
    message: `Selected '${active.id}' as the active executable step.`
  });
  return active;
}

function comparablePlan(plan: PlanGraph): string {
  return JSON.stringify({
    goal: plan.goal,
    activeNodeId: plan.activeNodeId,
    nodes: plan.nodes
  });
}

export function normalizedWorkPlan(
  current: PlanGraph,
  input: ModelPlanUpdateV3
): {
  proposed: PlanGraph;
  warnings: ModelPlanNormalizationWarningV3[];
  changed: boolean;
} {
  if (!Array.isArray(input.plan) || input.plan.length > 32) {
    throw planSchemaError("plan must be an array with at most 32 steps.");
  }
  const warnings: ModelPlanNormalizationWarningV3[] = [];
  const normalization = normalizeRootChecklist(current, input, warnings);
  preserveCompletedRoots(normalization, warnings);
  const children = current.nodes.filter((node) => node.owner.kind === "child");
  preserveRuntimeDependencies(normalization, children, warnings);
  attachAcceptanceCriteria(current, input, normalization, warnings);
  const active = normalizeActiveRoot(current, normalization.roots, warnings);
  const proposed: PlanGraph = {
    revision: current.revision + 1,
    goal: trimmed(input.goal) || current.goal,
    ...(active ? { activeNodeId: active.id } : {}),
    nodes: [...normalization.roots, ...children]
  };
  if (!isPlanGraph(proposed)) {
    throw Object.assign(new Error("The normalized work plan is invalid."), {
      code: "plan_normalization_failed"
    });
  }
  return {
    proposed,
    warnings,
    changed: comparablePlan(current) !== comparablePlan(proposed)
  };
}
