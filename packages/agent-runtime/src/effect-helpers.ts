import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import type {
  EvidenceRecord, JsonValue, ModelGateway, ModelToolCall, ModelToolDefinition, ToolCallPlan, ToolDescriptor, ToolReceipt,
  ValidationEvidence, WorkspaceDelta, WorkspaceDeltaEvidence
} from "agent-protocol";
import { planContext, type ContextPlan, type PlanContextOptions } from "agent-context";
import { canonicalWorkspacePath, isInside, resolveWorkspacePath } from "agent-platform";
import { completionEvidenceError, parseCompletionProposal } from "agent-tools";
import { validationCoversDelta } from "./validation-policy.js";
import { reviewerWaivedDeltaIds } from "./review-waiver-policy.js";
import { sessionMutationEvidence } from "./mutation-evidence.js";
import type { RuntimeSession } from "./types.js";
import { documentationOnly } from "./reviewer.js";

export function modelTools(descriptors: readonly ToolDescriptor[]): ModelToolDefinition[] {
  return descriptors.map((item) => ({ name: item.name, description: item.description, inputSchema: item.inputSchema }));
}

export async function providerSizedPlan(
  gateway: ModelGateway,
  input: Omit<PlanContextOptions, "contextWindowTokens">
): Promise<ContextPlan> {
  const providerLimit = gateway.capabilities.contextWindowTokens;
  let planningLimit = providerLimit;
  while (planningLimit > input.outputReserveTokens) {
    const plan = planContext({ ...input, contextWindowTokens: planningLimit });
    const tokens = await gateway.countTokens(plan.messages, input.tools);
    if (tokens + input.outputReserveTokens <= providerLimit) return plan;
    const ratio = providerLimit / (tokens + input.outputReserveTokens);
    const next = Math.min(planningLimit - 1, Math.floor(planningLimit * ratio * 0.98));
    if (next <= input.outputReserveTokens) break;
    planningLimit = next;
  }
  throw Object.assign(new Error("Provider tokenizer could not fit mandatory context and the newest user turn."), {
    code: "context_overflow"
  });
}

export function requestTargets(call: ModelToolCall, descriptor: ToolDescriptor): string[] {
  if (!call.arguments || typeof call.arguments !== "object" || Array.isArray(call.arguments)) return [];
  const input = call.arguments as Record<string, JsonValue>;
  return (descriptor.contextPathArguments ?? []).flatMap((key) => typeof input[key] === "string" ? [input[key] as string] : []);
}

export function porcelainEntries(output: string): Map<string, string> {
  const entries = new Map<string, string>();
  const records = output.split("\0").filter(Boolean);
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const status = record.slice(0, 2);
    const file = record.slice(3).replaceAll("\\", "/");
    if (file && file !== ".agent" && !file.startsWith(".agent/")) entries.set(file, status);
    if (status.includes("R")) index += 1;
  }
  return entries;
}

export async function fileFingerprint(workspace: string, file: string): Promise<string> {
  try {
    const target = await resolveWorkspacePath(workspace, file);
    const info = await stat(target);
    if (!info.isFile() || info.size > 8 * 1024 * 1024) return `${info.size}:${info.mtimeMs}`;
    return createHash("sha256").update(await readFile(target)).digest("hex");
  } catch {
    return "missing";
  }
}

export function workspaceDelta(before: Map<string, string>, after: Map<string, string>): WorkspaceDelta {
  const result: WorkspaceDelta = { added: [], modified: [], deleted: [] };
  for (const file of new Set([...before.keys(), ...after.keys()])) {
    const beforeStatus = before.get(file);
    const afterStatus = after.get(file);
    if (beforeStatus === afterStatus) continue;
    if (afterStatus === undefined) {
      const priorCode = beforeStatus?.slice(0, 2) ?? "";
      if (priorCode === "??" || priorCode.includes("A")) result.deleted.push(file);
      else result.modified.push(file);
    } else if (afterStatus.slice(0, 2) === "??" || afterStatus.slice(0, 2).includes("A")) result.added.push(file);
    else if (afterStatus.slice(0, 2).includes("D")) result.deleted.push(file);
    else result.modified.push(file);
  }
  result.added.sort();
  result.modified.sort();
  result.deleted.sort();
  return result;
}

export function mergeDelta(left: WorkspaceDelta | undefined, right: WorkspaceDelta): WorkspaceDelta {
  const merge = (key: keyof WorkspaceDelta): string[] => [...new Set([...(left?.[key] ?? []), ...right[key]])].sort();
  return { added: merge("added"), modified: merge("modified"), deleted: merge("deleted") };
}

export function failed(call: ModelToolCall, startedAt: string, output: string, diagnostic: string): ToolReceipt {
  return { callId: call.id, ok: false, output, observedEffects: [], artifacts: [], diagnostics: [diagnostic], startedAt, completedAt: new Date().toISOString() };
}

export function currentRunEvidence(session: RuntimeSession): EvidenceRecord[] {
  return session.durable.state.evidence.filter((item) =>
    item.sessionId === session.identity.sessionId && item.runId === session.durable.runId);
}

function completionChangeEvidenceError(session: RuntimeSession): string | null {
  const evidence = sessionMutationEvidence(session);
  const deltas = evidence.filter((item): item is WorkspaceDeltaEvidence =>
    item.kind === "workspace_delta" && item.status === "passed");
  if (deltas.length === 0) return null;
  const validations = evidence.filter((item): item is ValidationEvidence =>
    item.kind === "validation" && item.status === "passed");
  const unvalidated = deltas.filter((delta) => !validations.some((validation) =>
    validationCoversDelta(validation, delta)));
  if (unvalidated.length > 0) {
    return `Workspace deltas require corresponding passed validation evidence: ${unvalidated.map((item) => item.evidenceId).join(", ")}.`;
  }
  const waivedIds = reviewerWaivedDeltaIds(evidence);
  const reviewedIds = new Set(evidence.flatMap((item) => item.kind === "review" && item.status === "passed"
    ? item.data.workspaceDeltaEvidenceIds : []));
  const unreviewed = deltas.filter((item) => !documentationOnly(item)
    && !reviewedIds.has(item.evidenceId) && !waivedIds.has(item.evidenceId));
  return unreviewed.length > 0
    ? `Non-documentation deltas require corresponding approved review evidence: ${unreviewed.map((item) => item.evidenceId).join(", ")}.`
    : null;
}

export function completionFailure(session: RuntimeSession, call: ModelToolCall, descriptor: ToolDescriptor, startedAt: string): ToolReceipt | null {
  if (!descriptor.possibleEffects.includes("outcome.propose")) return null;
  if (session.durable.state.activeProcessIds.length > 0) {
    return failed(
      call,
      startedAt,
      `Completion is blocked while background processes remain active: ${session.durable.state.activeProcessIds.join(", ")}. Poll or terminate them first.`,
      "active_processes"
    );
  }
  if (session.durable.state.checkpointHead?.status === "open" || session.recovery.openCheckpointRecovery) {
    return failed(
      call,
      startedAt,
      "Completion is blocked until the open mutation checkpoint is explicitly restored or kept by the user.",
      "checkpoint_recovery_required"
    );
  }
  const proposal = parseCompletionProposal(call.arguments);
  if (!proposal) return failed(call, startedAt, "Completion proposal does not match the required schema.", "invalid_completion_proposal");
  const availableEvidence = new Map(currentRunEvidence(session)
    .filter((item) => item.status !== "failed")
    .map((item) => [item.evidenceId, item.kind] as const));
  const evidenceError = completionEvidenceError(proposal, availableEvidence);
  if (!evidenceError) {
    const changeError = completionChangeEvidenceError(session);
    if (!changeError) return null;
    const diagnostic = changeError.startsWith("Workspace") ? "validation_evidence_required" : "review_evidence_required";
    return failed(call, startedAt, changeError, diagnostic);
  }
  const available = [...availableEvidence].slice(-20).map(([id, kind]) => `${id}:${kind}`);
  const guidance = available.length > 0
    ? `Copy exact evidenceId/kind pairs from this available durable evidence list: ${available.join(", ")}.`
    : "No successful durable evidence is available yet; run the required inspection, mutation, or validation tool first.";
  return failed(call, startedAt, `${evidenceError}\n${guidance}`, "invalid_completion_evidence");
}

export function completionPlan(session: RuntimeSession): import("agent-protocol").PlanGraph | null {
  const pending = session.durable.state.plan.nodes.filter((node) => node.status !== "completed" && node.status !== "cancelled");
  if (pending.length !== 1 || pending[0]?.id !== "root" || pending[0].status !== "in_progress") return null;
  const evidence = session.durable.state.evidence
    .filter((item) => item.sessionId === session.identity.sessionId && item.runId === session.durable.runId)
    .filter((item) => item.status !== "failed")
    .map((item) => ({ evidenceId: item.evidenceId, kind: item.kind }));
  if (evidence.length === 0) return null;
  return {
    ...session.durable.state.plan,
    revision: session.durable.state.plan.revision + 1,
    activeNodeId: undefined,
    nodes: session.durable.state.plan.nodes.map((node) => node.id === "root"
      ? { ...node, status: "completed" as const, evidence }
      : node)
  };
}

export function completionPlanError(session: RuntimeSession, call: ModelToolCall, startedAt: string): ToolReceipt | null {
  const incomplete = session.durable.state.plan.nodes.filter((node) => node.status !== "completed" && node.status !== "cancelled");
  return incomplete.length === 0 ? null : failed(
    call,
    startedAt,
    `Completion is blocked by unfinished plan nodes: ${incomplete.map((node) => `${node.id}:${node.status}`).join(", ")}.`,
    "plan_incomplete"
  );
}

const scopedMutationEffects = new Set(["filesystem.write", "process.spawn", "destructive", "open_world"]);

function needsWriteScope(plan: ToolCallPlan | undefined, descriptor: ToolDescriptor): boolean {
  return (plan?.exactEffects ?? descriptor.possibleEffects).some((effect) => scopedMutationEffects.has(effect));
}

function structuredArguments(call: ModelToolCall): Record<string, JsonValue> | null {
  const value = call.arguments;
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : null;
}

function scopedWriteTargets(
  plan: ToolCallPlan | undefined,
  descriptor: ToolDescriptor,
  input: Record<string, JsonValue>
): string[] {
  if (plan) return [...new Set([...plan.writePaths, ...plan.checkpointScope])];
  return (descriptor.writePathArguments ?? []).flatMap((key) =>
    typeof input[key] === "string" ? [input[key] as string] : []);
}

export async function writeScopeFailure(
  session: RuntimeSession,
  call: ModelToolCall,
  descriptor: ToolDescriptor,
  startedAt: string,
  plan?: ToolCallPlan
): Promise<ToolReceipt | null> {
  if (!session.identity.strictWriteScope || !needsWriteScope(plan, descriptor)) return null;
  const input = structuredArguments(call);
  if (!input) return failed(call, startedAt, "Scoped writer tools require structured path arguments.", "write_scope_denied");
  const targets = scopedWriteTargets(plan, descriptor, input);
  if (targets.length === 0) return failed(call, startedAt, `Tool '${call.name}' can write outside declared paths and is disabled in an exclusive shared workspace.`, "write_scope_denied");
  const scopes = await Promise.all(session.identity.writeScope.map(async (scope) =>
    await canonicalWorkspacePath(session.identity.workspacePath, scope)));
  const outside: string[] = [];
  for (const target of targets) {
    const canonical = await canonicalWorkspacePath(session.identity.workspacePath, target).catch(() => null);
    if (!canonical || !scopes.some((scope) => isInside(scope, canonical))) outside.push(target);
  }
  return outside.length > 0 ? failed(call, startedAt, `Write target is outside the delegated scope: ${outside.join(", ")}.`, "write_scope_denied") : null;
}

export function lockKeys(session: RuntimeSession, descriptor: ToolDescriptor, plan?: ToolCallPlan): string[] {
  const scope = workspaceLockScope(session);
  const declared = descriptor.resourceKeys.map((key) => `${scope}:${key}`);
  const effects = plan?.exactEffects ?? descriptor.possibleEffects;
  const writer = effects.some((effect) => effect === "filesystem.write" || effect === "destructive"
    || effect === "checkpoint.restore" || effect === "open_world")
    ? [`${scope}:workspace:write`] : [];
  const resources = [...new Set([...declared, ...writer])];
  return descriptor.executionMode === "parallel" ? resources : [...resources, `${scope}:runtime:serial`];
}

export function workspaceWriteLockKey(session: RuntimeSession): string {
  return `${workspaceLockScope(session)}:workspace:write`;
}

function workspaceLockScope(session: RuntimeSession): string {
  return process.platform === "win32" ? session.identity.workspacePath.toLowerCase() : session.identity.workspacePath;
}

export function requiresInstructionReplan(descriptor: ToolDescriptor): boolean {
  const risky = new Set(["filesystem.write", "process.spawn", "agent.spawn", "network", "validation", "outcome.propose", "outcome.request_input", "destructive", "open_world"]);
  return descriptor.possibleEffects.some((effect) => risky.has(effect));
}

export async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    const onAbort = (): void => { cleanup(); reject(signal.reason ?? new Error("Operation cancelled.")); };
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then((value) => { cleanup(); resolve(value); }, (error) => { cleanup(); reject(error); });
  });
}

export function steeringRestart(signal: AbortSignal): boolean {
  return signal.aborted && (signal.reason as { code?: unknown } | undefined)?.code === "steering_restart";
}
