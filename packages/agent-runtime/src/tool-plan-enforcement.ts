import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import path from "node:path";
import type {
  JsonValue,
  ModelToolCall,
  ToolCallPlan,
  ToolReceipt,
  ValidationClaimKindV1,
  ValidationClaimV1
} from "agent-protocol";
import { canonicalWorkspacePath, isInside } from "agent-platform";
import { executionCommandSemantics } from "agent-tools";
import { effectsOutsidePlan } from "./tool-evidence.js";
import type { RuntimeSession } from "./types.js";
import { assurancePathsForClaim } from "./assurance-engine.js";

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

function invocation(call: ModelToolCall): {
  executable: string; args: string[]; display: string; shellCommand?: string
} {
  const input = argumentObject(call.arguments);
  if (typeof input.executable === "string") {
    const args = Array.isArray(input.args)
      ? input.args.filter((item): item is string => typeof item === "string") : [];
    return { executable: input.executable, args, display: [input.executable, ...args].join(" ") };
  }
  const command = typeof input.command === "string" ? input.command : "";
  const shell = typeof input.shell === "string" ? input.shell : "";
  return { executable: shell, args: [], display: command, shellCommand: command };
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

function syntaxSubjectArguments(executable: string, args: readonly string[]): string[] {
  const name = path.basename(executable).toLowerCase().replace(/\.(?:exe|cmd|bat|ps1)$/u, "");
  if (name === "node") {
    const index = args.indexOf("--check");
    return index >= 0 && args[index + 1] ? [args[index + 1]!] : [];
  }
  if (["python", "python3", "py"].includes(name)) {
    const moduleIndex = args.indexOf("-m");
    return moduleIndex >= 0 ? args.slice(moduleIndex + 2).filter((item) => !item.startsWith("-")) : [];
  }
  return [];
}

function validationClaim(
  workspaceRoot: string,
  call: ModelToolCall
): Omit<ValidationClaimV1, "status"> {
  const command = invocation(call);
  const semantics = executionCommandSemantics({
    executable: command.executable,
    args: command.args,
    validation: call.name === "validate",
    ...(command.shellCommand === undefined ? {} : { shellCommand: command.shellCommand })
  });
  const project = projectRootForCall(workspaceRoot, call);
  const selectedTargets = semantics.args.filter((item) =>
    /(?:^|\/)(?:tests?|specs?|__tests__)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$|\.[cm]?[jt]sx?$/iu.test(portable(item)))
    .flatMap((item) => workspaceSubjectPath(workspaceRoot, project.absolute, item) ?? []);
  const nodeTestTargetsProductionOnly = path.basename(semantics.executable).toLowerCase()
    .replace(/\.(?:exe|cmd|bat|ps1)$/u, "") === "node"
    && semantics.claimKind === "unit"
    && selectedTargets.length > 0
    && selectedTargets.every((item) => !/(?:^|\/)(?:tests?|specs?|__tests__)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/iu.test(item));
  // Registered non-process validators are trusted semantic adapters. Process
  // tools still derive their exact strength from the executable and args.
  const kind: ValidationClaimKindV1 = !semantics.executable && call.name !== "validate"
    ? "acceptance" : nodeTestTargetsProductionOnly ? "acceptance" : semantics.claimKind;
  const exactFiles = kind === "syntax"
    ? syntaxSubjectArguments(semantics.executable, semantics.args)
      .flatMap((item) => workspaceSubjectPath(workspaceRoot, project.absolute, item) ?? [])
    : [];
  const projectFlag = semantics.args.findIndex((item) => item === "-p" || item === "--project");
  const configPaths = projectFlag >= 0 && semantics.args[projectFlag + 1]
    ? [workspaceSubjectPath(workspaceRoot, project.absolute, semantics.args[projectFlag + 1]!)].filter(
        (item): item is string => Boolean(item)
      )
    : [];
  const selectedTests = ["unit", "integration"].includes(kind)
    ? selectedTargets
    : [];
  return {
    kind,
    commandDigest: createHash("sha256").update(JSON.stringify({
      executable: semantics.executable, args: semantics.args, command: command.display, cwd: project.portable
    })).digest("hex"),
    subject: {
      projectId: project.portable,
      configPaths,
      selectedTests,
      exactFiles
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

/** Freeze validation authority at preparation time. Coverage comes only from
 * a semantic command adapter and its selected project/files. Filesystem grants
 * and cwd traversal authority are deliberately irrelevant. */
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
    : claim.kind === "syntax"
      ? frontier.changedPaths.filter((item) => exact.has(portable(item)))
        : assurancePathsForClaim(
          frontier.changedPaths.filter((item) => coveredByProject(item, project)),
          claim.kind,
          session
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
