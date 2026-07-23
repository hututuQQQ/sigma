import { lstat } from "node:fs/promises";
import path from "node:path";
import type { ToolCallPlan } from "agent-protocol";
import { canonicalWorkspacePath, isInside } from "agent-platform";
import type { RuntimeSession } from "./types.js";

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
  const readTargets = await Promise.all(plan.readPaths.map(async (item) => ({
    item,
    canonical: await canonicalPlannedPath(session.identity.workspacePath, item)
  })));
  const writeTargets = await Promise.all(
    [...plan.writePaths, ...plan.checkpointScope].map(async (item) => ({
      item,
      canonical: await canonicalPlannedPath(session.identity.workspacePath, item)
    }))
  );
  const outsideReads = readTargets.filter(({ canonical }) => !canonical).map(({ item }) => item);
  const outsideWrites = writeTargets.filter(({ canonical }) => !canonical
    || !allowed.some((scope) => isInside(scope, canonical))).map(({ item }) => item);
  const outside = [...new Set([...outsideReads, ...outsideWrites])];
  if (allowed.length === scopePaths.length && outside.length === 0) return;
  throw Object.assign(new Error(
    "Repository conflict repair is outside the workspace read boundary or "
      + `broker-observed conflict write paths: ${outside.join(", ") || "invalid scope"}.`
  ), { code: "tool_unavailable_for_repair" });
}
