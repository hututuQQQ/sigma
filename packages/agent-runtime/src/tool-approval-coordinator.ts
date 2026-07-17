import type {
  ModelToolCall,
  ToolCallApproval,
  ToolCallPlan,
  ToolDescriptor,
  ToolEffect
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

const internalTerminalEffects: ReadonlySet<ToolEffect> = new Set([
  "outcome.propose",
  "outcome.report_blocked",
  "outcome.request_input"
]);

export interface ApprovalRequest {
  call: ModelToolCall;
  modelTurn: ActiveModelTurn;
  descriptor: ToolDescriptor;
  plan: ToolCallPlan;
}

function requiresPerCallApproval(plan: ToolCallPlan): boolean {
  return plan.network === "full"
    || plan.exactEffects.includes("network")
    || plan.exactEffects.includes("filesystem.read.external")
    || plan.exactEffects.includes("process.handoff")
    || plan.exactEffects.includes("open_world");
}

function requiresFreshRecoveredApproval(plan: ToolCallPlan): boolean {
  return plan.exactEffects.some((effect) =>
    ["filesystem.write", "repository.write", "destructive", "checkpoint.restore", "open_world"].includes(effect));
}

function containsOnlyInternalTerminalEffects(
  effects: readonly ToolEffect[]
): boolean {
  return effects.length > 0 && effects.every((effect) => internalTerminalEffects.has(effect));
}

function mandatoryApprovalDecision(
  descriptor: ToolDescriptor,
  effects: ToolDescriptor["possibleEffects"],
  permissionMode: ReturnType<typeof profilePermissionMode>
): "allow" | "deny" | undefined {
  if (descriptor.approval === "deny") return "deny";
  if (permissionMode !== "deny") return undefined;
  const maximumEffects = descriptor.maximumEffects ?? descriptor.possibleEffects;
  return containsOnlyInternalTerminalEffects(descriptor.possibleEffects)
    && containsOnlyInternalTerminalEffects(maximumEffects)
    && containsOnlyInternalTerminalEffects(effects)
    ? "allow"
    : "deny";
}

function immediateApprovalDecision(
  session: RuntimeSession,
  descriptor: ToolDescriptor,
  effects: ToolDescriptor["possibleEffects"],
  permissionMode: ReturnType<typeof profilePermissionMode>
): "allow" | "deny" | undefined {
  const mandatory = mandatoryApprovalDecision(descriptor, effects, permissionMode);
  if (mandatory) return mandatory;
  const perCall = effects.some((effect) => effect === "network"
    || effect === "filesystem.read.external" || effect === "process.handoff" || effect === "open_world");
  const effectGrant = effects.slice().sort().join("\0");
  if (permissionMode === "auto" && !effects.includes("open_world")) return "allow";
  return !perCall && (descriptor.approval === "auto"
    || session.interaction.alwaysAllowedEffects.has(effectGrant)) ? "allow" : undefined;
}

function validApprovalGrant(
  grant: CallApprovalGrant | undefined,
  expectedBinding: ReturnType<typeof createApprovalBinding>,
  plan: ToolCallPlan
): grant is CallApprovalGrant {
  if (!grant) return false;
  const approvalSatisfied = (required: boolean, approved: boolean | undefined): boolean =>
    !required || approved === true;
  return sameApprovalBinding(grant, expectedBinding)
    && grant.callId === expectedBinding.callId
    && (grant.authority === "user" || grant.authority === "runtime")
    && approvalSatisfied(plan.network === "full", grant.networkApproved)
    && approvalSatisfied(
      plan.exactEffects.includes("filesystem.read.external"), grant.externalReadApproved
    )
    && approvalSatisfied(plan.exactEffects.includes("process.handoff"), grant.processHandoffApproved)
    && approvalSatisfied(plan.exactEffects.includes("open_world"), grant.unsafeHostExecApproved);
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
  if (session.interaction.approvals.get(requestId) !== waiter) return;
  session.interaction.approvals.delete(requestId);
  const restartDeadline = session.interaction.approvals.size === 0;
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
    if (restartDeadline && session.durable.state.deadlineRemainingMs !== undefined) {
      session.execution.controller?.abort(Object.assign(
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
  constructor(private readonly options: Pick<EffectRunnerOptions, "runtime" | "emit" | "finish">) {}

  async decision(
    session: RuntimeSession,
    prepared: ApprovalRequest,
    signal: AbortSignal
  ): Promise<"allow" | "deny" | "always_allow"> {
    const { call, modelTurn, descriptor, plan } = prepared;
    const permissionMode = profilePermissionMode(this.options.runtime, session);
    const effects = approvalEffectsForPlan(plan);
    const mandatory = mandatoryApprovalDecision(descriptor, effects, permissionMode);
    if (mandatory) return mandatory;
    const restored = session.durable.state.pendingTools.find((item) => item.request.callId === call.id)?.approval;
    const expectedBinding = createApprovalBinding(
      session.identity.sessionId, session.durable.runId, call, plan, effects
    );
    const existingGrant = session.interaction.callApprovals.get(call.id);
    const hadCallGrant = Boolean(existingGrant);
    const freshCallGrant = sameApprovalBinding(existingGrant, expectedBinding);
    if (existingGrant && !freshCallGrant) session.interaction.callApprovals.delete(call.id);
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
      session.identity.sessionId, session.durable.runId, prepared.call, prepared.plan, effects
    );
    const restored = session.durable.state.pendingTools
      .find((item) => item.request.callId === prepared.call.id)?.approval;
    const perCall = requiresPerCallApproval(prepared.plan);
    const grant = session.interaction.callApprovals.get(prepared.call.id);
    const requiresGrant = Boolean(grant) || perCall
      || (restored === "allowed" && requiresFreshRecoveredApproval(prepared.plan));
    session.interaction.callApprovals.delete(prepared.call.id);
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
      session.interaction.alwaysAllowedEffects.add(grant.alwaysAllowEffectGrant);
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
    if (immediate) {
      return requiresPerCallApproval(plan)
        ? await this.resolveAutomatically(session, descriptor, effects, request, modelTurn, plan)
        : immediate;
    }
    if (this.options.runtime.interactiveApprovals === false) {
      return await this.suspendWithoutInteractiveApproval(
        session, descriptor, effects, request, modelTurn, plan
      );
    }
    let resolve!: (value: "allow" | "deny" | "always_allow") => void;
    const pending = new Promise<"allow" | "deny" | "always_allow">((accept) => { resolve = accept; });
    if (session.interaction.approvals.has(requestId)) throw new Error(`Duplicate approval '${requestId}'.`);
    const waiter: ApprovalWaiter = {
      effects,
      binding: createApprovalBinding(session.identity.sessionId, session.durable.runId, request, plan, effects),
      resolve
    };
    session.interaction.approvals.set(requestId, waiter);
    const remainingDeadlineMs = pauseRunDeadline(session);
    let completed = false;
    let requestWasDurable = false;
    try {
      await this.options.emit(session, "tool.approval_requested", "runtime", {
        requestId, callId: requestId, toolName: descriptor.name, arguments: request.arguments,
        effects,
        plan,
        approvalMode: "human",
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

  private async resolveAutomatically(
    session: RuntimeSession,
    descriptor: ToolDescriptor,
    effects: ToolDescriptor["possibleEffects"],
    request: ModelToolCall,
    modelTurn: ActiveModelTurn,
    plan: ToolCallPlan
  ): Promise<"allow"> {
    const binding = createApprovalBinding(
      session.identity.sessionId, session.durable.runId, request, plan, effects
    );
    await this.options.emit(session, "tool.approval_requested", "runtime", {
      requestId: request.id, callId: request.id, toolName: descriptor.name, arguments: request.arguments,
      effects, plan, approvalMode: "automatic",
      reason: `Permission mode auto authorized the planned effects: ${effects.join(", ")}.`,
      ...turnPayload(modelTurn)
    });
    await this.options.emit(session, "tool.approval_resolved", "runtime", {
      requestId: request.id, callId: request.id, decision: "allow", ...turnPayload(modelTurn)
    });
    session.interaction.callApprovals.set(request.id, {
      ...binding,
      authority: "runtime",
      networkApproved: plan.network === "full",
      externalReadApproved: plan.exactEffects.includes("filesystem.read.external"),
      processHandoffApproved: plan.exactEffects.includes("process.handoff"),
      unsafeHostExecApproved: false
    });
    return "allow";
  }

  private async suspendWithoutInteractiveApproval(
    session: RuntimeSession,
    descriptor: ToolDescriptor,
    effects: ToolDescriptor["possibleEffects"],
    request: ModelToolCall,
    modelTurn: ActiveModelTurn,
    plan: ToolCallPlan
  ): Promise<never> {
    const remainingDeadlineMs = pauseRunDeadline(session);
    let suspended = false;
    try {
      await this.options.emit(session, "tool.approval_requested", "runtime", {
        requestId: request.id, callId: request.id, toolName: descriptor.name, arguments: request.arguments,
        effects, plan, approvalMode: "human",
        reason: `Human approval is required for effects: ${effects.join(", ")}.`,
        ...turnPayload(modelTurn)
      });
      await this.options.emit(session, "tool.approval_resolved", "runtime", {
        requestId: request.id, callId: request.id, decision: "cancelled", ...turnPayload(modelTurn)
      });
      const message = `Tool '${descriptor.name}' requires human approval, but this runtime surface is non-interactive.`;
      const committed = await this.options.finish(session, {
        kind: "needs_input", requestId: request.id, message
      }, undefined, { remainingDeadlineMs });
      if (!committed) {
        throw Object.assign(new Error("Runtime could not commit a non-interactive approval suspension."), {
          code: "approval_suspension_failed"
        });
      }
      suspended = true;
      throw Object.assign(new Error(message), { code: "approval_needs_input" });
    } finally {
      if (!suspended) armRunDeadline(session);
    }
  }
}
