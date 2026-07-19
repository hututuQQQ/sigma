import type {
  CheckpointCreatePolicyV1,
  CheckpointRef,
  ModelToolCall,
  ToolCallPlan,
  ToolDescriptor,
  ToolReceipt
} from "agent-protocol";
import path from "node:path";
import type { ToolNoChangeProbeExecutor } from "agent-tools";
import type { EffectRunnerOptions } from "./effect-runner.js";
import { mutatingPlan, turnPayload, type ToolAttempt } from "./effect-runner-helpers.js";
import type { RuntimeSession } from "./types.js";
import { assertToolReceiptIdentity, normalizeReceiptEvidence } from "./tool-evidence.js";
import { assertReceiptWithinPlan } from "./tool-plan-enforcement.js";

interface NoChangePreparedTool {
  call: ModelToolCall;
  descriptor: ToolDescriptor;
  plan: ToolCallPlan;
  modelTurn: ToolAttempt["modelTurn"];
}

export function delegatesWorkspaceMutation(plan: ToolCallPlan): boolean {
  return plan.exactEffects.includes("agent.spawn") && plan.processMode === "background";
}

export function checkpointCreatePolicy(
  workspacePath: string,
  plan: ToolCallPlan
): CheckpointCreatePolicyV1 {
  const workspace = path.resolve(workspacePath);
  const cwd = path.resolve(workspace, plan.executionIntent?.invocation.cwd ?? ".");
  const reproducibleRootPaths = (plan.executionCapability?.dependencyRoots ?? []).flatMap((root) => {
    const absolute = path.isAbsolute(root) ? path.resolve(root) : path.resolve(cwd, root);
    const relative = path.relative(workspace, absolute);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return [];
    return [relative.split(path.sep).join("/") || "."];
  });
  const compactRoots = [...new Set(reproducibleRootPaths)].sort();
  const explicitDeliverablePaths = plan.writePaths.filter((item) => {
    const absolute = path.resolve(workspace, item);
    const relative = path.relative(workspace, absolute);
    const portable = relative.split(path.sep).join("/") || ".";
    // Declaring the capability's dependency root itself is the write
    // contract needed by the broker, not evidence that generated dependency
    // contents are a deliverable. A more specific child path remains exact.
    return !compactRoots.includes(portable);
  });
  return {
    reproducibleRootPaths: compactRoots,
    explicitDeliverablePaths
  };
}

export function isToolReceipt(value: object): value is ToolReceipt {
  return "ok" in value;
}

export function failureCode(error: unknown, signal: AbortSignal): string {
  const code = (error as { code?: unknown })?.code;
  if (code === "approval_needs_input") throw error;
  if (typeof code === "string") return code;
  return signal.aborted ? "tool_cancelled" : "tool_exception";
}

export function executionFailureCode(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string" ? code : "tool_exception";
}

async function probeNoChange(
  options: Pick<EffectRunnerOptions, "runtime" | "control">,
  session: RuntimeSession,
  prepared: NoChangePreparedTool,
  signal: AbortSignal
): Promise<ToolReceipt | undefined> {
  const executor = options.runtime.tools as typeof options.runtime.tools
    & Partial<ToolNoChangeProbeExecutor>;
  if (typeof executor.probeNoChange !== "function") return undefined;
  const { call, plan } = prepared;
  const receipt = await executor.probeNoChange({
    callId: call.id,
    name: call.name,
    arguments: call.arguments
  }, {
    sessionId: session.identity.sessionId,
    runId: session.durable.runId,
    workspacePath: session.identity.workspacePath,
    runMode: session.durable.mode,
    runtimeControl: options.control.forSession(session),
    signal,
    callPlan: plan
  });
  if (!receipt) return undefined;
  assertToolReceiptIdentity(receipt, call.id);
  const result = receipt.result;
  const noChange = result && typeof result === "object" && !Array.isArray(result)
    && result.status === "no_change";
  const actualEffects = receipt.actualEffects;
  const mutating = actualEffects?.some((effect) =>
    ["filesystem.write", "repository.write", "process.spawn", "agent.spawn", "destructive", "open_world", "checkpoint.restore"]
      .includes(effect));
  if (!receipt.ok || !noChange || !actualEffects || mutating || receipt.workspaceDelta !== undefined) {
    throw Object.assign(new Error(
      `Tool '${call.name}' returned an invalid no-change probe receipt.`
    ), { code: "no_change_probe_invalid" });
  }
  await assertReceiptWithinPlan(session, receipt, plan);
  return receipt;
}

export async function settleNoChangeProbe(
  options: Pick<EffectRunnerOptions, "runtime" | "control" | "emit">,
  session: RuntimeSession,
  prepared: NoChangePreparedTool,
  signal: AbortSignal,
  markExecutionStarted: () => void
): Promise<ToolReceipt | undefined> {
  const receipt = await probeNoChange(options, session, prepared, signal);
  if (!receipt) return undefined;
  markExecutionStarted();
  const { call, descriptor, plan } = prepared;
  await options.emit(session, "execution.started", "runtime", { executionId: call.id });
  await options.emit(session, "tool.started", "runtime", {
    callId: call.id,
    name: call.name,
    ...turnPayload(prepared.modelTurn)
  });
  const normalizedReceipt = normalizeReceiptEvidence(receipt, descriptor.name, plan, {
    sessionId: session.identity.sessionId,
    runId: session.durable.runId,
    workspaceDeltas: []
  });
  await options.emit(session, "execution.completed", "runtime", {
    executionId: call.id,
    evidenceIds: (normalizedReceipt.evidence ?? []).map((item) => item.evidenceId)
  });
  return normalizedReceipt;
}

export async function createMutationCheckpoint(
  options: Pick<EffectRunnerOptions, "control">,
  session: RuntimeSession,
  plan: ToolCallPlan
): Promise<CheckpointRef | undefined> {
  if (plan.checkpointAction) return undefined;
  if (!mutatingPlan(plan) || delegatesWorkspaceMutation(plan)) return undefined;
  const scope = plan.checkpointScope.length > 0 ? plan.checkpointScope : ["."];
  return await options.control.createCheckpoint(
    session,
    scope,
    checkpointCreatePolicy(session.identity.workspacePath, plan)
  );
}
