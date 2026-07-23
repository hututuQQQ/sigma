import { lstat } from "node:fs/promises";
import path from "node:path";
import type { ModelToolCall, ToolCallPlan } from "agent-protocol";
import { canonicalWorkspacePath, isInside } from "agent-platform";
import type { RuntimeSession } from "./types.js";

const REPOSITORY_CONFLICT_CALLS = new Set([
  "read", "write", "edit", "apply_patch", "delete_file"
]);
type RepositoryObligation = Extract<
  NonNullable<RuntimeSession["durable"]["state"]["taskControl"]["obligation"]>,
  { kind: "repository_recovery" }
>;

function argumentsObject(call: ModelToolCall): Record<string, unknown> {
  return call.arguments && typeof call.arguments === "object" && !Array.isArray(call.arguments)
    ? call.arguments as Record<string, unknown> : {};
}

function repositoryTransactCallAllowed(
  obligation: RepositoryObligation,
  call: ModelToolCall
): boolean {
  const input = argumentsObject(call);
  if (call.name !== "git_transaction") {
    return Boolean(obligation.transactionId && obligation.scopePaths?.length)
      && REPOSITORY_CONFLICT_CALLS.has(call.name);
  }
  if (obligation.transactionId) {
    return (input.action === "continue" || input.action === "abort")
      && input.transactionHandle === obligation.transactionId;
  }
  return input.action === "recover" && input.candidateId === obligation.candidateId
    && input.selectionEvidenceId === obligation.selectionEvidenceId;
}

function repositoryCallAllowed(
  obligation: RepositoryObligation,
  call: ModelToolCall
): boolean {
  if (obligation.stage === "inspect" || obligation.stage === "select") {
    return call.name === "repository_inspect";
  }
  if (obligation.stage === "validate") {
    return call.name === "repository_inspect" || call.name === "validate";
  }
  return repositoryTransactCallAllowed(obligation, call);
}

export function assertRepositoryRecoveryCallAllowed(
  session: RuntimeSession,
  call: ModelToolCall
): void {
  const obligation = session.durable.state.taskControl.obligation;
  if (obligation?.kind !== "repository_recovery" || repositoryCallAllowed(obligation, call)) return;
  throw Object.assign(new Error(
    "The active repository recovery call is outside its runtime-issued stage or transaction binding."
  ), { code: "tool_unavailable_for_repair" });
}

async function canonicalPlannedPath(
  workspacePath: string,
  requested: string
): Promise<string | null> {
  const workspace = path.resolve(workspacePath);
  const lexical = path.resolve(workspace, requested);
  if (!isInside(workspace, lexical)) return null;
  if (lexical === workspace) return workspace;
  const parent = await canonicalWorkspacePath(workspacePath, path.dirname(lexical)).catch(() => null);
  if (!parent) return null;
  const target = path.join(parent, path.basename(lexical));
  const info = await lstat(target).catch(() => null);
  return info?.isSymbolicLink() ? null : target;
}

export async function assertRepositoryConflictPlanAllowed(
  session: RuntimeSession,
  plan: ToolCallPlan,
  scopePaths: string[]
): Promise<void> {
  const requested = [...plan.readPaths, ...plan.writePaths, ...plan.checkpointScope];
  if (requested.length === 0 || !plan.exactEffects.some((effect) =>
    effect === "filesystem.read" || effect === "filesystem.write")) {
    throw Object.assign(new Error(
      "Repository conflict repair requires an exact read or write path."
    ), { code: "tool_unavailable_for_repair" });
  }
  const allowed = (await Promise.all(scopePaths.map(async (item) =>
    await canonicalPlannedPath(session.identity.workspacePath, item))))
    .filter((item): item is string => Boolean(item));
  const targets = await Promise.all(requested.map(async (item) => ({
    item,
    canonical: await canonicalPlannedPath(session.identity.workspacePath, item)
  })));
  const outside = targets.filter(({ canonical }) => !canonical
    || !allowed.some((scope) => isInside(scope, canonical))).map(({ item }) => item);
  if (allowed.length === scopePaths.length && outside.length === 0) return;
  throw Object.assign(new Error(
    `Repository conflict repair is outside the broker-observed conflict paths: ${outside.join(", ") || "invalid scope"}.`
  ), { code: "tool_unavailable_for_repair" });
}
