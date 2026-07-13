import { lstat } from "node:fs/promises";
import path from "node:path";
import type { ModelToolCall, ToolCallPlan, ToolReceipt, WorkspaceDeltaEvidence } from "agent-protocol";
import { canonicalWorkspacePath, isInside } from "agent-platform";
import { sessionMutationEvidence, unresolvedWorkspaceDeltas } from "./mutation-evidence.js";
import { effectsOutsidePlan } from "./tool-evidence.js";
import type { RuntimeSession } from "./types.js";

export function validationTargetIds(
  session: RuntimeSession,
  call: ModelToolCall,
  plan: ToolCallPlan
): string[] | undefined {
  if (!plan.exactEffects.includes("validation")) return undefined;
  const argumentsValue = call.arguments;
  const input = argumentsValue && typeof argumentsValue === "object" && !Array.isArray(argumentsValue)
    ? argumentsValue as Record<string, unknown> : {};
  const requested = input.workspaceDeltaEvidenceIds;
  if (requested === undefined) return undefined;
  if (!Array.isArray(requested) || requested.length === 0
    || requested.some((item) => typeof item !== "string" || item.length === 0)) {
    throw Object.assign(new Error(
      "workspaceDeltaEvidenceIds must be a non-empty array of unresolved workspace delta evidence IDs."
    ), { code: "validation_scope_invalid" });
  }
  const unresolved = new Set(unresolvedWorkspaceDeltas(session).map((item) => item.evidenceId));
  const ids = [...new Set(requested as string[])];
  const invalid = ids.filter((id) => !unresolved.has(id));
  if (invalid.length > 0) {
    throw Object.assign(new Error(
      `Validation targets are missing, foreign, or already covered: ${invalid.join(", ")}.`
    ), { code: "validation_scope_invalid" });
  }
  return ids;
}

export function workspaceDeltas(
  session: RuntimeSession,
  selectedIds: string[] | undefined
): WorkspaceDeltaEvidence[] {
  if (!selectedIds) return unresolvedWorkspaceDeltas(session);
  const byId = new Map(sessionMutationEvidence(session)
    .filter((item): item is WorkspaceDeltaEvidence => item.kind === "workspace_delta" && item.status === "passed")
    .map((item) => [item.evidenceId, item]));
  return selectedIds.map((id) => byId.get(id)).filter((item): item is WorkspaceDeltaEvidence => Boolean(item));
}

export async function assertCheckpointActionAllowed(
  session: RuntimeSession,
  plan: ToolCallPlan,
  hasActiveChildren: () => Promise<boolean | undefined>
): Promise<void> {
  if (!plan.checkpointAction) return;
  if (plan.checkpointAction.kind !== "restore"
    || !plan.exactEffects.includes("checkpoint.restore")) {
    throw Object.assign(new Error("Invalid checkpoint transaction-control plan."), {
      code: "checkpoint_action_invalid"
    });
  }
  if (session.state.activeProcessIds.length > 0) {
    throw Object.assign(new Error("Run changes cannot be restored while background processes are active."), {
      code: "checkpoint_processes_active"
    });
  }
  if (await hasActiveChildren()) {
    throw Object.assign(new Error("Run changes cannot be restored while child agents are active."), {
      code: "checkpoint_children_active"
    });
  }
}

async function implicitAddedParentDirectory(
  workspacePath: string,
  item: { path: string; kind: "added" | "modified" | "deleted" },
  canonical: string | null,
  allowed: string[]
): Promise<boolean> {
  if (item.kind !== "added" || !canonical || !allowed.some((target) => isInside(canonical, target))) return false;
  const lexical = path.resolve(workspacePath, item.path);
  if (!isInside(workspacePath, lexical)) return false;
  return await lstat(lexical).then(
    (info) => info.isDirectory() && !info.isSymbolicLink(),
    () => false
  );
}

export async function assertReceiptWithinPlan(
  session: RuntimeSession,
  receipt: ToolReceipt,
  plan: ToolCallPlan
): Promise<void> {
  const outside = effectsOutsidePlan(receipt, plan);
  const changedPaths = receipt.workspaceDelta
    ? [
      ...receipt.workspaceDelta.added.map((item) => ({ path: item, kind: "added" as const })),
      ...receipt.workspaceDelta.modified.map((item) => ({ path: item, kind: "modified" as const })),
      ...receipt.workspaceDelta.deleted.map((item) => ({ path: item, kind: "deleted" as const }))
    ]
    : [];
  const plannedWritePaths = plan.writePaths.length > 0
    ? plan.writePaths
    : plan.exactEffects.includes("filesystem.write") ? plan.checkpointScope : [];
  const allowedResults = await Promise.all(plannedWritePaths.map(async (item) =>
    await canonicalWorkspacePath(session.workspacePath, item).catch(() => null)));
  const invalidAllowed = plannedWritePaths.filter((_item, index) => !allowedResults[index]);
  const allowed = allowedResults.filter((item): item is string => Boolean(item));
  const outsidePaths: string[] = [];
  for (const item of changedPaths) {
    const canonical = await canonicalWorkspacePath(session.workspacePath, item.path).catch(() => null);
    if (canonical && allowed.some((root) => isInside(root, canonical))) continue;
    const addedParentDirectory = await implicitAddedParentDirectory(
      session.workspacePath, item, canonical, allowed
    );
    if (!addedParentDirectory) outsidePaths.push(item.path);
  }
  if (outside.length === 0 && outsidePaths.length === 0 && invalidAllowed.length === 0) return;
  const details = [
    ...(outside.length > 0 ? [`effects: ${outside.join(", ")}`] : []),
    ...(invalidAllowed.length > 0 ? [`invalid approved paths: ${invalidAllowed.join(", ")}`] : []),
    ...(outsidePaths.length > 0 ? [`paths: ${outsidePaths.join(", ")}`] : [])
  ];
  throw Object.assign(new Error(
    `Tool observed effects outside its approved plan (${details.join("; ")}).`
  ), { code: "effect_plan_violation" });
}
