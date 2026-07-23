import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import path from "node:path";
import type {
  JsonValue,
  ModelToolCall,
  ToolCallPlan,
  ToolReceipt,
  ValidationClaimV1
} from "agent-protocol";
import { canonicalWorkspacePath, isInside } from "agent-platform";
import { effectsOutsidePlan } from "./tool-evidence.js";
import type { RuntimeSession } from "./types.js";
import { assurancePathsForClaim } from "./assurance-engine.js";
import {
  assertRepositoryConflictPlanAllowed
} from "./repository-conflict-policy.js";
import { semanticValidationCommand } from "./semantic-validation-command.js";

export interface FrozenValidationScope {
  frontierRevision: number;
  stateDigest: string;
  coveredPaths: string[];
  claim: Omit<ValidationClaimV1, "status">;
}

function portable(value: string): string {
  return value.split(path.sep).join("/").replace(/^\.\//u, "") || ".";
}

function coveredByProject(changedPath: string, root: string): boolean {
  const normalizedRoot = portable(root).replace(/\/$/u, "");
  const normalizedPath = portable(changedPath);
  return normalizedRoot === "." || normalizedPath === normalizedRoot
    || normalizedPath.startsWith(`${normalizedRoot}/`);
}

function argumentObject(value: JsonValue): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, JsonValue> : {};
}

function shellWords(command: string): string[] {
  const words: string[] = [];
  const pattern = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'|([^\s]+)/gu;
  for (const match of command.matchAll(pattern)) words.push(match[1] ?? match[2] ?? match[3] ?? "");
  return words.filter(Boolean);
}

function shellExecutableIndex(words: readonly string[]): number {
  let executableIndex = 0;
  while (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(words[executableIndex] ?? "")) executableIndex += 1;
  if (path.basename(words[executableIndex] ?? "").toLowerCase() === "env") {
    executableIndex += 1;
    while ((words[executableIndex] ?? "").startsWith("-")
      || /^[A-Za-z_][A-Za-z0-9_]*=/u.test(words[executableIndex] ?? "")) executableIndex += 1;
  } else if ((words[executableIndex] ?? "") === "command") {
    executableIndex += 1;
    while ((words[executableIndex] ?? "").startsWith("-")) executableIndex += 1;
  }
  return executableIndex;
}

function invocation(call: ModelToolCall): {
  executable: string;
  args: string[];
  display: string;
  shellScript?: string;
} {
  const input = argumentObject(call.arguments);
  if (typeof input.executable === "string") {
    const args = Array.isArray(input.args)
      ? input.args.filter((item): item is string => typeof item === "string") : [];
    return { executable: input.executable, args, display: [input.executable, ...args].join(" ") };
  }
  const command = typeof input.command === "string" ? input.command : "";
  const words = shellWords(command);
  const executableIndex = shellExecutableIndex(words);
  return {
    executable: words[executableIndex] ?? "",
    args: words.slice(executableIndex + 1),
    display: command,
    shellScript: command
  };
}

function exactCandidateFiles(
  workspaceRoot: string,
  projectRoot: string,
  candidates: readonly string[]
): string[] {
  return [...new Set(candidates.flatMap((value) =>
    workspaceSubjectPath(workspaceRoot, projectRoot, value) ?? []))].sort();
}

function workspaceSubjectPath(workspaceRoot: string, projectRoot: string, requested: string): string | undefined {
  if (!requested || requested.startsWith("-")) return undefined;
  const resolved = path.resolve(projectRoot, requested);
  return isInside(workspaceRoot, resolved) ? portable(path.relative(workspaceRoot, resolved)) : undefined;
}

function projectRootForCall(workspaceRoot: string, call: ModelToolCall): { absolute: string; portable: string } {
  const input = argumentObject(call.arguments);
  const requested = typeof input.cwd === "string" ? input.cwd : ".";
  const absolute = path.resolve(workspaceRoot, requested);
  if (!isInside(workspaceRoot, absolute)) return { absolute: workspaceRoot, portable: "." };
  return { absolute, portable: portable(path.relative(workspaceRoot, absolute)) };
}

function validationClaim(
  workspaceRoot: string,
  call: ModelToolCall
): Omit<ValidationClaimV1, "status"> {
  const command = invocation(call);
  const semantic = semanticValidationCommand(command.executable, command.args, command.shellScript);
  const executable = semantic.executable;
  // Registered non-process validators are trusted semantic adapters. Process
  // tools still derive their exact strength from the executable and args.
  const adaptedKind = !executable && call.name !== "validate"
    ? "acceptance" as const : semantic.kind;
  const project = projectRootForCall(workspaceRoot, call);
  const exactFiles = exactCandidateFiles(
    workspaceRoot,
    project.absolute,
    semantic.exactPathCandidates
  );
  const kind = adaptedKind === "probe" && exactFiles.length > 0
    ? exactFiles.some((item) => assurancePathsForClaim([item], "unit").includes(item))
      ? "unit" as const : "acceptance" as const
    : adaptedKind;
  const scopedExactFiles = exactFiles.length > 0
    ? exactFiles
    : kind === "syntax"
    ? command.args.slice(1, 2).flatMap((item) => workspaceSubjectPath(workspaceRoot, project.absolute, item) ?? [])
    : [];
  const projectFlag = command.args.findIndex((item) => item === "-p" || item === "--project");
  const configPaths = projectFlag >= 0 && command.args[projectFlag + 1]
    ? [workspaceSubjectPath(workspaceRoot, project.absolute, command.args[projectFlag + 1]!)].filter(
        (item): item is string => Boolean(item)
      )
    : [];
  const selectedTests = ["unit", "integration"].includes(kind)
    ? command.args.flatMap((item) => workspaceSubjectPath(workspaceRoot, project.absolute, item) ?? [])
    : [];
  return {
    kind,
    commandDigest: createHash("sha256").update(JSON.stringify({
      executable, args: command.args, cwd: project.portable
    })).digest("hex"),
    subject: {
      projectId: project.portable,
      configPaths,
      selectedTests,
      exactFiles: scopedExactFiles
    }
  };
}

/** Resolve the workspace object that was changed without following a final
 * symlink. Parent links are still canonicalized and must remain contained. */
async function canonicalWrittenObjectPath(
  workspacePath: string,
  requested: string
): Promise<string | null> {
  const workspace = path.resolve(workspacePath);
  const lexical = path.resolve(workspace, requested);
  if (!isInside(workspace, lexical)) return null;
  if (lexical === workspace) return workspace;
  const parent = await canonicalWorkspacePath(workspacePath, path.dirname(lexical)).catch(() => null);
  return parent ? path.join(parent, path.basename(lexical)) : null;
}

function activeConflictScope(session: RuntimeSession): string[] | undefined {
  const open = new Map<string, string[]>();
  for (const receipt of session.durable.state.receipts) {
    const result = receipt.result && typeof receipt.result === "object" && !Array.isArray(receipt.result)
      ? receipt.result as Record<string, JsonValue>
      : undefined;
    const handle = typeof result?.transactionHandle === "string" ? result.transactionHandle : "";
    if (!handle) continue;
    if (result?.status === "conflicts_pending") {
      const paths = Array.isArray(result.conflictPaths)
        ? result.conflictPaths.filter((item): item is string => typeof item === "string")
        : [];
      open.set(handle, paths);
    } else if (["completed", "aborted", "restored"].includes(String(result?.status))) {
      open.delete(handle);
    }
  }
  return [...open.values()].at(-1);
}

/** Preserve broker transaction path isolation without inferring semantic
 * recovery state or narrowing the model-visible tool set. */
export async function assertTransactionIsolationPlanAllowed(
  session: RuntimeSession,
  plan: ToolCallPlan
): Promise<void> {
  const scope = activeConflictScope(session);
  if (scope?.length && plan.exactEffects.includes("filesystem.write")
    && !plan.exactEffects.includes("repository.write")) {
    await assertRepositoryConflictPlanAllowed(session, plan, scope);
  }
}

/** Freeze validation telemetry at preparation time. Command classification
 * describes coverage to the model and evaluator; completion authority only
 * checks the structurally bound validation record and its actual status. */
export function validationScope(
  session: RuntimeSession,
  call: ModelToolCall,
  plan: ToolCallPlan
): FrozenValidationScope | undefined {
  if (!plan.exactEffects.includes("validation")) return undefined;
  const frontier = session.durable.state.mutationFrontier;
  const workspaceRoot = path.resolve(session.identity.workspacePath);
  const claim = validationClaim(workspaceRoot, call);
  const exact = new Set(claim.subject.exactFiles);
  const project = claim.subject.projectId ?? ".";
  const coveredPaths = claim.kind === "probe"
    ? []
    : exact.size > 0
      ? frontier.changedPaths.filter((item) => exact.has(portable(item)))
      : assurancePathsForClaim(
          frontier.changedPaths.filter((item) => coveredByProject(item, project)),
          claim.kind
        );
  return {
    frontierRevision: frontier.revision,
    stateDigest: frontier.currentStateDigest,
    coveredPaths,
    claim
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
    await canonicalWrittenObjectPath(session.identity.workspacePath, item)));
  const invalidAllowed = plannedWritePaths.filter((_item, index) => !allowedResults[index]);
  const allowed = allowedResults.filter((item): item is string => Boolean(item));
  const outsidePaths: string[] = [];
  for (const item of changedPaths) {
    const canonical = await canonicalWrittenObjectPath(session.identity.workspacePath, item.path);
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
