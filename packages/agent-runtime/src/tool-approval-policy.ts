import type {
  ModelToolCall,
  ToolCallPlan,
  ToolDescriptor,
  ToolEffect
} from "agent-protocol";
import {
  createApprovalBinding,
  sameApprovalBinding
} from "./approval-binding.js";
import { profilePermissionMode } from "./profile-policy.js";
import type { CallApprovalGrant, RuntimeSession } from "./types.js";

const internalTerminalEffects: ReadonlySet<ToolEffect> = new Set([
  "outcome.propose",
  "outcome.report_blocked",
  "outcome.request_input"
]);

function approvalCommand(call: ModelToolCall): string {
  const value = call.arguments && typeof call.arguments === "object" && !Array.isArray(call.arguments)
    ? call.arguments as Record<string, unknown> : {};
  if (typeof value.executable === "string") {
    const args = Array.isArray(value.args)
      ? value.args.filter((item): item is string => typeof item === "string") : [];
    return [value.executable, ...args].join(" ");
  }
  if (typeof value.command === "string") return value.command;
  return call.name;
}

function approvalRisk(effects: readonly ToolEffect[], plan: ToolCallPlan): { level: string; reason: string } {
  if (effects.includes("destructive") || effects.includes("repository.write") || plan.network === "full") {
    return { level: "high", reason: "repository, destructive, or full-network capability" };
  }
  if (effects.includes("filesystem.write") || effects.includes("filesystem.read.external")) {
    return { level: "medium", reason: "workspace mutation or external read capability" };
  }
  return { level: "low", reason: "read-only local capability" };
}

export function semanticApprovalReason(
  call: ModelToolCall,
  effects: readonly ToolEffect[],
  plan: ToolCallPlan,
  backend: "native" | "oci",
  automatic = false
): string {
  const risk = approvalRisk(effects, plan);
  const read = plan.readPaths.join(", ") || "none";
  const write = plan.writePaths.join(", ") || "none";
  return `command=${approvalCommand(call)}; read=${read}; write=${write}; network=${plan.network}; `
    + `backend=${backend}; risk=${risk.level} (${risk.reason})${automatic ? "; decision=automatic" : ""}`;
}

export function requiresPerCallApproval(plan: ToolCallPlan): boolean {
  return plan.network === "full"
    || plan.exactEffects.includes("filesystem.read.external")
    || plan.exactEffects.includes("repository.write")
    || plan.exactEffects.includes("destructive")
    || plan.exactEffects.includes("checkpoint.restore")
    || plan.exactEffects.includes("process.handoff")
    || plan.exactEffects.includes("open_world");
}

export function requiresFreshRecoveredApproval(plan: ToolCallPlan): boolean {
  return plan.exactEffects.some((effect) =>
    ["filesystem.write", "repository.write", "destructive", "checkpoint.restore", "open_world"].includes(effect));
}

function containsOnlyInternalTerminalEffects(effects: readonly ToolEffect[]): boolean {
  return effects.length > 0 && effects.every((effect) => internalTerminalEffects.has(effect));
}

export function mandatoryApprovalDecision(
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

export function immediateApprovalDecision(
  session: RuntimeSession,
  _call: ModelToolCall,
  descriptor: ToolDescriptor,
  effects: ToolDescriptor["possibleEffects"],
  permissionMode: ReturnType<typeof profilePermissionMode>,
  plan: ToolCallPlan
): "allow" | "deny" | undefined {
  const mandatory = mandatoryApprovalDecision(descriptor, effects, permissionMode);
  if (mandatory) return mandatory;
  const perCall = requiresPerCallApproval(plan);
  const effectGrant = effects.slice().sort().join("\0");
  if (permissionMode === "auto" && !effects.includes("open_world")) return "allow";
  if (permissionMode === "workspace-auto" && !perCall) return "allow";
  return !perCall && (descriptor.approval === "auto"
    || session.interaction.alwaysAllowedEffects.has(effectGrant)) ? "allow" : undefined;
}

export function validApprovalGrant(
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
    && approvalSatisfied(plan.exactEffects.includes("open_world"), grant.openWorldApproved);
}
