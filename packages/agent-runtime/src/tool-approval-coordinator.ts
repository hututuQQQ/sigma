import type {
  ModelToolCall,
  ToolCallApproval,
  ToolCallPlan,
  ToolDescriptor
} from "agent-protocol";
import type { ActiveModelTurn } from "agent-kernel";
import { abortable, steeringRestart } from "./effect-helpers.js";
import { turnPayload } from "./effect-runner-helpers.js";
import type { EffectRunnerOptions } from "./effect-runner.js";
import { profilePermissionMode } from "./profile-policy.js";
import type { ApprovalWaiter, CallApprovalGrant, RuntimeSession } from "./types.js";
import { armRunDeadline, pauseRunDeadline, resumedDeadlineAt } from "./run-deadline.js";
import {
  approvalEffectsForPlan,
  createApprovalBinding,
  sameApprovalBinding
} from "./approval-binding.js";

export interface ApprovalRequest {
  call: ModelToolCall;
  modelTurn: ActiveModelTurn;
  descriptor: ToolDescriptor;
  plan: ToolCallPlan;
}

function requiresPerCallApproval(plan: ToolCallPlan): boolean {
  return plan.network === "full"
    || plan.exactEffects.includes("network")
    || plan.exactEffects.includes("open_world");
}

function requiresFreshRecoveredApproval(plan: ToolCallPlan): boolean {
  return plan.exactEffects.some((effect) =>
    ["filesystem.write", "destructive", "checkpoint.restore", "open_world"].includes(effect));
}

function immediateApprovalDecision(
  session: RuntimeSession,
  descriptor: ToolDescriptor,
  effects: ToolDescriptor["possibleEffects"],
  permissionMode: ReturnType<typeof profilePermissionMode>
): "allow" | "deny" | undefined {
  if (descriptor.approval === "deny" || permissionMode === "deny") return "deny";
  const perCall = effects.some((effect) => effect === "network" || effect === "open_world");
  const effectGrant = effects.slice().sort().join("\0");
  return !perCall && (descriptor.approval === "auto" || permissionMode === "auto"
    || session.alwaysAllowedEffects.has(effectGrant)) ? "allow" : undefined;
}

function validApprovalGrant(
  grant: CallApprovalGrant | undefined,
  expectedBinding: ReturnType<typeof createApprovalBinding>,
  plan: ToolCallPlan
): grant is CallApprovalGrant {
  const networkApproved = plan.network !== "full" || grant?.networkApproved === true;
  const unsafeApproved = !plan.exactEffects.includes("open_world")
    || grant?.unsafeHostExecApproved === true;
  return Boolean(grant
    && sameApprovalBinding(grant, expectedBinding)
    && grant.callId === expectedBinding.callId
    && grant.authority === "user"
    && networkApproved
    && unsafeApproved);
}

async function cleanUpFailedApprovalRequest(
  options: Pick<EffectRunnerOptions, "emit">,
  session: RuntimeSession,
  requestId: string,
  modelTurn: ActiveModelTurn,
  waiter: ApprovalWaiter,
  requestWasDurable: boolean,
  signal: AbortSignal
): Promise<void> {
  if (session.approvals.get(requestId) !== waiter) return;
  session.approvals.delete(requestId);
  const restartDeadline = session.approvals.size === 0;
  const deadlineAt = restartDeadline ? resumedDeadlineAt(session) : undefined;
  try {
    if (requestWasDurable) {
      await options.emit(session, "tool.approval_resolved", "runtime", {
        requestId, callId: requestId,
        decision: steeringRestart(signal) ? "superseded" : "cancelled",
        ...(deadlineAt ? { deadlineAt } : {}),
        ...turnPayload(modelTurn)
      });
    }
  } catch (error) {
    if (restartDeadline && session.state.deadlineRemainingMs !== undefined) {
      session.controller?.abort(Object.assign(
        new Error("Failed to durably resume the run deadline after approval cleanup.", { cause: error }),
        { code: "approval_cleanup_failed" }
      ));
    }
    throw error;
  } finally {
    if (restartDeadline) armRunDeadline(session);
  }
}

export class ToolApprovalCoordinator {
  constructor(private readonly options: Pick<EffectRunnerOptions, "runtime" | "emit">) {}

  async decision(
    session: RuntimeSession,
    prepared: ApprovalRequest,
    signal: AbortSignal
  ): Promise<"allow" | "deny" | "always_allow"> {
    const { call, modelTurn, descriptor, plan } = prepared;
    const permissionMode = profilePermissionMode(this.options.runtime, session);
    if (descriptor.approval === "deny" || permissionMode === "deny") return "deny";
    const restored = session.state.pendingTools.find((item) => item.request.callId === call.id)?.approval;
    const effects = approvalEffectsForPlan(plan);
    const expectedBinding = createApprovalBinding(
      session.sessionId, session.runId, call, plan, effects
    );
    const existingGrant = session.callApprovals.get(call.id);
    const hadCallGrant = Boolean(existingGrant);
    const freshCallGrant = sameApprovalBinding(existingGrant, expectedBinding);
    if (existingGrant && !freshCallGrant) session.callApprovals.delete(call.id);
    const requiresMatchingGrant = hadCallGrant
      || requiresFreshRecoveredApproval(plan)
      || requiresPerCallApproval(plan);
    if (restored === "allowed" && (!requiresMatchingGrant || freshCallGrant)) return "allow";
    return await this.request(
      session, descriptor, effects, call, modelTurn, plan, signal,
      restored === "allowed" && requiresMatchingGrant
    );
  }

  consume(session: RuntimeSession, prepared: ApprovalRequest): ToolCallApproval | undefined {
    const effects = approvalEffectsForPlan(prepared.plan);
    const expectedBinding = createApprovalBinding(
      session.sessionId, session.runId, prepared.call, prepared.plan, effects
    );
    const restored = session.state.pendingTools
      .find((item) => item.request.callId === prepared.call.id)?.approval;
    const perCall = requiresPerCallApproval(prepared.plan);
    const grant = session.callApprovals.get(prepared.call.id);
    const requiresGrant = Boolean(grant) || perCall
      || (restored === "allowed" && requiresFreshRecoveredApproval(prepared.plan));
    session.callApprovals.delete(prepared.call.id);
    if (!requiresGrant) return undefined;
    if (!validApprovalGrant(grant, expectedBinding, prepared.plan)) {
      throw Object.assign(new Error("Sensitive execution requires a fresh per-call human approval."), {
        code: "per_call_approval_required"
      });
    }
    if (grant.alwaysAllowEffectGrant) {
      const expectedEffectGrant = effects.slice().sort().join("\0");
      if (grant.alwaysAllowEffectGrant !== expectedEffectGrant) {
        throw Object.assign(new Error("The persistent effect grant does not match the approved call."), {
          code: "per_call_approval_required"
        });
      }
      session.alwaysAllowedEffects.add(grant.alwaysAllowEffectGrant);
    }
    return perCall ? grant : undefined;
  }

  private async request(
    session: RuntimeSession,
    descriptor: ToolDescriptor,
    effects: ToolDescriptor["possibleEffects"],
    request: ModelToolCall,
    modelTurn: ActiveModelTurn,
    plan: ToolCallPlan,
    signal: AbortSignal,
    forcePrompt: boolean
  ): Promise<"allow" | "deny" | "always_allow"> {
    const requestId = request.id;
    const permissionMode = profilePermissionMode(this.options.runtime, session);
    const immediate = forcePrompt
      ? undefined
      : immediateApprovalDecision(session, descriptor, effects, permissionMode);
    if (immediate) return immediate;
    let resolve!: (value: "allow" | "deny" | "always_allow") => void;
    const pending = new Promise<"allow" | "deny" | "always_allow">((accept) => { resolve = accept; });
    if (session.approvals.has(requestId)) throw new Error(`Duplicate approval '${requestId}'.`);
    const waiter: ApprovalWaiter = {
      effects,
      binding: createApprovalBinding(session.sessionId, session.runId, request, plan, effects),
      resolve
    };
    session.approvals.set(requestId, waiter);
    const remainingDeadlineMs = pauseRunDeadline(session);
    let completed = false;
    let requestWasDurable = false;
    try {
      await this.options.emit(session, "tool.approval_requested", "runtime", {
        requestId, callId: requestId, toolName: descriptor.name, arguments: request.arguments,
        effects,
        plan,
        reason: `Effects: ${effects.join(", ")}; writes: ${plan.writePaths.join(", ") || "none"}; rollback scope: ${plan.checkpointScope.join(", ") || "none"}${plan.checkpointAction ? `; checkpoint: ${plan.checkpointAction.checkpointId}` : ""}`,
        ...turnPayload(modelTurn)
      });
      requestWasDurable = true;
      await this.options.emit(session, "run.suspended", "runtime", {
        requestId, callId: requestId, message: `Approval required for ${descriptor.name}.`,
        remainingDeadlineMs,
        ...turnPayload(modelTurn)
      });
      const decision = await abortable(pending, signal);
      completed = true;
      return decision;
    } finally {
      if (!completed) {
        await cleanUpFailedApprovalRequest(
          this.options, session, requestId, modelTurn, waiter, requestWasDurable, signal
        );
      }
    }
  }
}
