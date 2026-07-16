import { lstat } from "node:fs/promises";
import path from "node:path";
import type { ModelToolCall, ToolCallPlan, ToolReceipt } from "agent-protocol";
import { canonicalWorkspacePath, isInside } from "agent-platform";
import { effectsOutsidePlan } from "./tool-evidence.js";
import type { RuntimeSession } from "./types.js";

export interface FrozenValidationScope {
  frontierRevision: number;
  stateDigest: string;
  coveredPaths: string[];
}

function portable(value: string): string {
  return value.split(path.sep).join("/").replace(/^\.\//u, "") || ".";
}

function coveredByRoot(changedPath: string, root: string): boolean {
  const normalizedRoot = portable(root).replace(/\/$/u, "");
  const normalizedPath = portable(changedPath);
  return normalizedRoot === "." || normalizedPath === normalizedRoot
    || normalizedPath.startsWith(`${normalizedRoot}/`);
}

/** Freeze validation authority at preparation time. Coverage is derived from
 * approved read roots, never from opaque identifiers supplied by the model. */
export function validationScope(
  session: RuntimeSession,
  _call: ModelToolCall,
  plan: ToolCallPlan
): FrozenValidationScope | undefined {
  if (!plan.exactEffects.includes("validation")) return undefined;
  const frontier = session.durable.state.mutationFrontier;
  const workspaceRoot = path.resolve(session.identity.workspacePath);
  const roots = plan.readPaths.flatMap((item) => {
    const resolved = path.resolve(workspaceRoot, item);
    return isInside(workspaceRoot, resolved) ? [portable(path.relative(workspaceRoot, resolved))] : [];
  });
  return {
    frontierRevision: frontier.revision,
    stateDigest: frontier.currentStateDigest,
    coveredPaths: frontier.changedPaths.filter((item) => roots.some((root) => coveredByRoot(item, root)))
  };
}

export async function assertCheckpointActionAllowed(
  session: RuntimeSession,
  plan: ToolCallPlan,
  hasActiveChildren: () => Promise<boolean | undefined>
): Promise<void> {
  if (!plan.checkpointAction) return;
  if (plan.checkpointAction.kind !== "restore" || !plan.exactEffects.includes("checkpoint.restore")) {
    throw Object.assign(new Error("Invalid checkpoint transaction-control plan."), { code: "checkpoint_action_invalid" });
  }
  if (session.durable.state.activeProcessIds.length > 0) {
    throw Object.assign(new Error("Run changes cannot be restored while background processes are active."), { code: "checkpoint_processes_active" });
  }
  if (await hasActiveChildren()) {
    throw Object.assign(new Error("Run changes cannot be restored while child agents are active."), { code: "checkpoint_children_active" });
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
  const changedPaths = receipt.workspaceDelta ? [
    ...receipt.workspaceDelta.added.map((item) => ({ path: item, kind: "added" as const })),
    ...receipt.workspaceDelta.modified.map((item) => ({ path: item, kind: "modified" as const })),
    ...receipt.workspaceDelta.deleted.map((item) => ({ path: item, kind: "deleted" as const }))
  ] : [];
  const plannedWritePaths = plan.writePaths.length > 0
    ? plan.writePaths : plan.exactEffects.includes("filesystem.write") ? plan.checkpointScope : [];
  const allowedResults = await Promise.all(plannedWritePaths.map(async (item) =>
    await canonicalWorkspacePath(session.identity.workspacePath, item).catch(() => null)));
  const invalidAllowed = plannedWritePaths.filter((_item, index) => !allowedResults[index]);
  const allowed = allowedResults.filter((item): item is string => Boolean(item));
  const outsidePaths: string[] = [];
  for (const item of changedPaths) {
    const canonical = await canonicalWorkspacePath(session.identity.workspacePath, item.path).catch(() => null);
    if (canonical && allowed.some((root) => isInside(root, canonical))) continue;
    if (!await implicitAddedParentDirectory(session.identity.workspacePath, item, canonical, allowed)) {
      outsidePaths.push(item.path);
    }
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
