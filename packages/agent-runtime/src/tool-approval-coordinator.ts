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
import type { RuntimeSession } from "./types.js";
import { armRunDeadline, pauseRunDeadline, resumedDeadlineAt } from "./run-deadline.js";

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

function approvalEffects(plan: ToolCallPlan): ToolDescriptor["possibleEffects"] {
  const effects = [...plan.exactEffects];
  if (plan.network === "full" && !effects.includes("network")) effects.push("network");
  return effects;
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
    if (restored === "allowed" && (!requiresPerCallApproval(plan) || session.callApprovals.has(call.id))) return "allow";
    return await this.request(session, descriptor, approvalEffects(plan), call, modelTurn, signal);
  }

  consume(session: RuntimeSession, prepared: ApprovalRequest): ToolCallApproval | undefined {
    if (!requiresPerCallApproval(prepared.plan)) {
      session.callApprovals.delete(prepared.call.id);
      return undefined;
    }
    const grant = session.callApprovals.get(prepared.call.id);
    session.callApprovals.delete(prepared.call.id);
    const networkApproved = prepared.plan.network !== "full" || grant?.networkApproved === true;
    const unsafeApproved = !prepared.plan.exactEffects.includes("open_world")
      || grant?.unsafeHostExecApproved === true;
    if (!grant || grant.callId !== prepared.call.id || grant.authority !== "user"
      || !networkApproved || !unsafeApproved) {
      throw Object.assign(new Error("Sensitive execution requires a fresh per-call human approval."), {
        code: "per_call_approval_required"
      });
    }
    return grant;
  }

  private async request(
    session: RuntimeSession,
    descriptor: ToolDescriptor,
    effects: ToolDescriptor["possibleEffects"],
    request: ModelToolCall,
    modelTurn: ActiveModelTurn,
    signal: AbortSignal
  ): Promise<"allow" | "deny" | "always_allow"> {
    const requestId = request.id;
    const permissionMode = profilePermissionMode(this.options.runtime, session);
    if (descriptor.approval === "deny" || permissionMode === "deny") return "deny";
    const effectGrant = effects.slice().sort().join("\0");
    const perCall = effects.some((effect) => effect === "network" || effect === "open_world");
    if (!perCall && (descriptor.approval === "auto" || permissionMode === "auto"
      || session.alwaysAllowedEffects.has(effectGrant))) return "allow";
    let resolve!: (value: "allow" | "deny" | "always_allow") => void;
    const pending = new Promise<"allow" | "deny" | "always_allow">((accept) => { resolve = accept; });
    session.approvals.set(requestId, { effects, resolve });
    const remainingDeadlineMs = pauseRunDeadline(session);
    await this.options.emit(session, "tool.approval_requested", "runtime", {
      requestId, callId: requestId, toolName: descriptor.name, arguments: request.arguments,
      effects, reason: `Effects: ${effects.join(", ")}`, ...turnPayload(modelTurn)
    });
    await this.options.emit(session, "run.suspended", "runtime", {
      requestId, callId: requestId, message: `Approval required for ${descriptor.name}.`,
      remainingDeadlineMs,
      ...turnPayload(modelTurn)
    });
    try {
      return await abortable(pending, signal);
    } catch (error) {
      session.approvals.delete(requestId);
      const deadlineAt = session.approvals.size === 0 ? resumedDeadlineAt(session) : undefined;
      await this.options.emit(session, "tool.approval_resolved", "runtime", {
        requestId, callId: requestId,
        decision: steeringRestart(signal) ? "superseded" : "cancelled",
        ...(deadlineAt ? { deadlineAt } : {}),
        ...turnPayload(modelTurn)
      });
      if (deadlineAt) armRunDeadline(session);
      throw error;
    }
  }
}
