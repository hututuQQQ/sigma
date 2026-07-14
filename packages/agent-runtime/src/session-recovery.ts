import { randomUUID } from "node:crypto";
import type {
  BudgetAmounts,
  ToolDescriptor,
  UsageRecord
} from "agent-protocol";
import { recoveryDenialPayload, recoveryResultLostPayload } from "./run-transitions.js";
import type { RuntimeSession } from "./types.js";
import type { BoundRuntimeEventEmitter } from "./runtime-event-emitter.js";

interface RecoveryOptions {
  descriptors: readonly ToolDescriptor[];
  emit: BoundRuntimeEventEmitter;
  settleToolBudget(callId: string, disposition: "commit" | "release", checkpointId?: string): Promise<void>;
  settleEligibleToolBudgets(): Promise<void>;
  settleModelBudget(requestId: string): Promise<BudgetAmounts | undefined>;
  start(): void;
}

function mutating(descriptor: ToolDescriptor | undefined): boolean {
  return Boolean(descriptor?.possibleEffects.some((effect) =>
    ["filesystem.write", "process.spawn", "destructive", "open_world"].includes(effect)));
}

function mustNotReplay(session: RuntimeSession, descriptor: ToolDescriptor | undefined): boolean {
  if (!descriptor?.idempotent) return true;
  const checkpointStatus = session.durable.state.checkpointHead?.status;
  return mutating(descriptor) && (checkpointStatus === "sealed" || checkpointStatus === "restored");
}

function interruptedModelUsage(
  session: RuntimeSession,
  requestId: string,
  charged: BudgetAmounts
): UsageRecord {
  const routed = session.services.gateway as typeof session.services.gateway & {
    routingIdentity?(): { role: UsageRecord["role"]; routeId: string };
  };
  const identity = routed.routingIdentity?.();
  return {
    usageId: randomUUID(),
    requestId,
    sessionId: session.identity.sessionId,
    runId: session.durable.runId,
    role: identity?.role ?? session.services.modelRole,
    routeId: identity?.routeId ?? "recovery/default",
    providerId: session.services.gateway.provider,
    modelId: session.services.gateway.model,
    tokenizerId: "recovery/conservative",
    tokenizerAccuracy: "approximate",
    providerReported: false,
    inputTokens: charged.inputTokens,
    outputTokens: charged.outputTokens,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costMicroUsd: charged.costMicroUsd,
    latencyMs: 0,
    attempt: Math.max(1, charged.modelTurns),
    occurredAt: new Date().toISOString()
  };
}

async function recoverInterruptedModel(session: RuntimeSession, options: RecoveryOptions): Promise<void> {
  const active = session.durable.state.activeModelTurn;
  if (!active) throw new Error("Interrupted model state is missing its active turn.");
  const requestId = `${session.durable.runId}:${active.turnId}`;
  const charged = await options.settleModelBudget(requestId);
  if (charged && !session.durable.state.usage.some((item) => item.requestId === requestId)) {
    await options.emit("usage.recorded", "runtime", interruptedModelUsage(session, requestId, charged));
  }
  if (session.durable.state.activeModelSemanticDelta) {
    await options.emit("run.suspended", "runtime", {
      requestId: `model-recovery:${requestId}`,
      message: "The interrupted model attempt produced durable content or reasoning. It will not be replayed automatically; send a follow-up to continue.",
      ...active
    });
    return;
  }
  await options.emit("diagnostic", "runtime", {
    kind: "recovery.retry_model",
    message: "Retrying an interrupted model attempt with no durable semantic delta from the last durable boundary."
  });
}

async function recoverUnstartedTool(
  pending: RuntimeSession["durable"]["state"]["pendingTools"][number],
  descriptor: ToolDescriptor | undefined,
  options: RecoveryOptions
): Promise<void> {
  await options.settleToolBudget(pending.request.callId, "release");
  if (pending.approval === "denied") {
    await options.emit(
      "tool.failed",
      "runtime",
      recoveryDenialPayload(pending.request.callId, pending.modelTurn)
    );
    return;
  }
  if (pending.approval !== "allowed" || !mutating(descriptor)) return;
  await options.emit("diagnostic", "runtime", {
    kind: "recovery.reset_tool",
    callId: pending.request.callId,
    approval: "not_required"
  });
}

export async function recoverInterruptedSession(session: RuntimeSession, options: RecoveryOptions): Promise<void> {
  if (session.durable.state.phase === "terminal") return;
  const lostProcessIds = [...session.durable.state.activeProcessIds];
  for (const processId of lostProcessIds) {
    await options.emit("process.lost", "runtime", {
      processId,
      reason: "The runtime restarted; background process handles are valid only for the runtime lifecycle that created them."
    });
  }
  if (session.durable.state.phase === "model_in_flight") {
    await recoverInterruptedModel(session, options);
  }
  for (const pending of [...session.durable.state.pendingTools]) {
    const descriptor = options.descriptors.find((item) => item.name === pending.request.name);
    if (pending.approval === "pending") {
      if (!session.interaction.approvals.has(pending.request.callId)) {
        session.interaction.approvals.set(pending.request.callId, {
          effects: descriptor?.possibleEffects ?? [], recovered: true, resolve: () => undefined
        });
      }
      continue;
    }
    if (!pending.started) {
      await recoverUnstartedTool(pending, descriptor, options);
      continue;
    }
    if (!mustNotReplay(session, descriptor)) {
      await options.settleToolBudget(pending.request.callId, "release");
      await options.emit("diagnostic", "runtime", {
        kind: "recovery.reset_tool", callId: pending.request.callId, approval: "not_required"
      });
      continue;
    }
    await options.settleToolBudget(
      pending.request.callId,
      "commit",
      mutating(descriptor) ? session.durable.state.checkpointHead?.checkpointId : undefined
    );
    await options.emit(
      "tool.failed",
      "runtime",
      recoveryResultLostPayload(pending.request.callId, pending.modelTurn)
    );
  }
  if (lostProcessIds.length > 0) {
    await options.emit("run.suspended", "runtime", {
      requestId: `process-recovery:${lostProcessIds[0]}`,
      processIds: lostProcessIds,
      message: "Background processes were lost across runtime restart and were not replayed. Send a follow-up after reviewing their last durable output."
    });
    return;
  }
  await options.settleEligibleToolBudgets();
  if (["ready_model", "tool_pending", "outcome_pending"].includes(session.durable.state.phase)) options.start();
}
