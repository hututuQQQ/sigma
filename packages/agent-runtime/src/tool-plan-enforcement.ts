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

function requestedExecutable(call: ModelToolCall): string | undefined {
  const input = argumentObject(call.arguments);
  return typeof input.executable === "string" ? input.executable : undefined;
}

/** Bind a capability-recovery action to the runtime-issued opportunity. The
 * model may choose one package set, but cannot change the missing executable,
 * substitute another probe, or reuse the obligation for unrelated execution. */
export function assertTaskControlCallAllowed(
  session: RuntimeSession,
  call: ModelToolCall
): void {
  const obligation = session.durable.state.taskControl.obligation;
  if (obligation?.kind !== "capability_recovery") return;
  const executable = requestedExecutable(call);
  const allowed = obligation.stage === "prepare"
    ? call.name === "environment_prepare" && (() => {
        const input = argumentObject(call.arguments);
        return input.requestedExecutable === obligation.requestedExecutable;
      })()
    : call.name === obligation.probeToolName
      && executable === obligation.requestedExecutable;
  if (allowed) return;
  throw Object.assign(new Error(
    "The active capability recovery is bound to one broker-observed executable and probe."
  ), { code: "tool_unavailable_for_repair" });
}

function shellWords(command: string): string[] {
  const words: string[] = [];
  const pattern = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'|([^\s]+)/gu;
  for (const match of command.matchAll(pattern)) words.push(match[1] ?? match[2] ?? match[3] ?? "");
  return words.filter(Boolean);
}

function invocation(call: ModelToolCall): { executable: string; args: string[]; display: string } {
  const input = argumentObject(call.arguments);
  if (typeof input.executable === "string") {
    const args = Array.isArray(input.args)
      ? input.args.filter((item): item is string => typeof item === "string") : [];
    return { executable: input.executable, args, display: [input.executable, ...args].join(" ") };
  }
  const command = typeof input.command === "string" ? input.command : "";
  const words = shellWords(command);
  return { executable: words[0] ?? "", args: words.slice(1), display: command };
}

function executableName(value: string): string {
  return path.basename(value).toLowerCase().replace(/\.(?:exe|cmd|bat|ps1)$/u, "");
}

function scriptName(executable: string, args: string[]): string | undefined {
  if (!["pnpm", "npm", "yarn", "bun"].includes(executable)) return undefined;
  const candidate = args[0] === "run" ? args[1] : args[0];
  return candidate?.toLowerCase();
}

function cargoSubcommand(args: string[]): string | undefined {
  const optionsWithValues = new Set(["--color", "--config", "-C", "-Z"]);
  let skipValue = false;
  for (const argument of args) {
    if (skipValue) {
      skipValue = false;
      continue;
    }
    if (argument.startsWith("+")) continue;
    const option = argument.split("=", 1)[0] ?? argument;
    if (optionsWithValues.has(option)) {
      skipValue = !argument.includes("=");
      continue;
    }
    if (argument.startsWith("-")) continue;
    return argument.toLowerCase();
  }
  return undefined;
}

function cargoClaimKind(args: string[]): ValidationClaimKindV1 | undefined {
  const subcommand = cargoSubcommand(args);
  if (subcommand === "test") return "unit";
  if (subcommand === "clippy" || subcommand === "fmt") return "lint";
  if (["build", "check", "bench"].includes(subcommand ?? "")) return "acceptance";
  return undefined;
}

function claimKind(executable: string, args: string[]): ValidationClaimKindV1 {
  if (executable === "node" && args[0] === "--check") return "syntax";
  if (executable === "tsc" || args.some((item) => executableName(item) === "tsc")) return "typecheck";
  if (["eslint", "biome", "stylelint", "ruff"].includes(executable)) return "lint";
  if (["vitest", "jest", "mocha", "pytest", "cargo-test"].includes(executable)) return "unit";
  if (executable === "cargo") return cargoClaimKind(args) ?? "probe";
  const script = scriptName(executable, args);
  if (!script) return "probe";
  if (/integration|e2e/u.test(script)) return "integration";
  if (/test|spec/u.test(script)) return "unit";
  if (/typecheck|check-types|tsc/u.test(script)) return "typecheck";
  if (/lint|format-check/u.test(script)) return "lint";
  if (/build|verify|validate|check/u.test(script)) return "acceptance";
  return "probe";
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
  const executable = executableName(command.executable);
  // Registered non-process validators are trusted semantic adapters. Process
  // tools still derive their exact strength from the executable and args.
  const kind = !executable && call.name !== "validate"
    ? "acceptance" as const : claimKind(executable, command.args);
  const project = projectRootForCall(workspaceRoot, call);
  const exactFiles = kind === "syntax"
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

/** Keep a review-directed mutation inside the runtime-authenticated finding
 * scope. The model may narrow the prepared write plan, but it cannot widen
 * the obligation by changing arguments, checkpoint roots, or call IDs. */
export async function assertTaskControlPlanAllowed(
  session: RuntimeSession,
  plan: ToolCallPlan
): Promise<void> {
  const obligation = session.durable.state.taskControl.obligation;
  if (obligation?.kind !== "review_repair" || obligation.stage !== "mutate") return;
  if (!plan.exactEffects.includes("filesystem.write")) {
    throw Object.assign(new Error(
      "The active review repair requires one scoped workspace mutation."
    ), { code: "tool_unavailable_for_repair" });
  }
  const requested = plan.writePaths.length > 0 ? plan.writePaths : plan.checkpointScope;
  if (requested.length === 0) {
    throw Object.assign(new Error(
      "The review repair mutation did not declare any exact write path."
    ), { code: "tool_unavailable_for_repair" });
  }
  const allowed = (await Promise.all(obligation.scopePaths.map(async (item) =>
    await canonicalWrittenObjectPath(session.identity.workspacePath, item))))
    .filter((item): item is string => Boolean(item));
  const targets = await Promise.all(requested.map(async (item) => ({
    item,
    canonical: await canonicalWrittenObjectPath(session.identity.workspacePath, item)
  })));
  const outside = targets.filter(({ canonical }) => !canonical
    || !allowed.some((scope) => isInside(scope, canonical))).map(({ item }) => item);
  if (allowed.length === obligation.scopePaths.length && outside.length === 0) return;
  throw Object.assign(new Error(
    `Review repair write plan is outside the authenticated finding scope: ${outside.join(", ") || "invalid scope"}.`
  ), { code: "tool_unavailable_for_repair" });
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
