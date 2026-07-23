import type {
  CheckpointRef,
  ModelToolCall,
  ToolCallPlan,
  ToolDescriptor,
  ToolReceipt
} from "agent-protocol";
import type { ToolNoChangeProbeExecutor } from "agent-tools";
import type { EffectRunnerOptions } from "./effect-runner.js";
import { mutatingPlan, turnPayload, type ToolAttempt } from "./effect-runner-helpers.js";
import type { RuntimeSession } from "./types.js";
import { assertToolReceiptIdentity, normalizeReceiptEvidence } from "./tool-evidence.js";
import { assertReceiptWithinPlan } from "./tool-plan-enforcement.js";
import { toolRuntimeContext } from "./repository-recovery-context.js";

interface NoChangePreparedTool {
  call: ModelToolCall;
  descriptor: ToolDescriptor;
  plan: ToolCallPlan;
  modelTurn: ToolAttempt["modelTurn"];
}

export function delegatesWorkspaceMutation(plan: ToolCallPlan): boolean {
  return plan.exactEffects.includes("agent.spawn") && plan.processMode === "background";
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
    ...toolRuntimeContext(session),
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
    , repositoryScope: {
      goalEpoch: session.durable.state.messages.filter((message) => message.role === "user").length,
      frontier: session.durable.state.mutationFrontier,
      mutationEvidence: [...session.durable.state.mutationEvidence]
    }
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
  if (plan.checkpointAction || plan.mutationAuthority === "broker_repository_transaction_v2") {
    return undefined;
  }
  if (!mutatingPlan(plan) || delegatesWorkspaceMutation(plan)) return undefined;
  const scope = plan.checkpointScope.length > 0 ? plan.checkpointScope : ["."];
  return await options.control.createCheckpoint(session, scope);
}
