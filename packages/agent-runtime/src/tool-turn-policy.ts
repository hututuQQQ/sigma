import { isCompletionEligibleEvidence, type ToolDescriptor, type ToolEffect } from "agent-protocol";
import { terminalProtocolAction } from "agent-tools";
import type { RuntimeSession } from "./types.js";

export type CompletionRepairPhase =
  | "none"
  | "evidence"
  | "terminal"
  | "protected_completion"
  | "protected_recovery";

export function completionRepairPhase(session: RuntimeSession): CompletionRepairPhase {
  const repair = session.durable.state.completionRepair;
  if (repair?.kind === "evidence_acquisition") return "evidence";
  if (repair?.kind === "terminal_action") return "terminal";
  if (repair?.kind === "protected_completion") return "protected_completion";
  if (repair?.kind === "protected_recovery") return "protected_recovery";
  if (session.durable.state.completionRepairAttempts === 0) return "none";
  // Compatibility for snapshots created before repair intent was durable.
  const hasEvidence = session.durable.state.evidence.some((item) =>
    isCompletionEligibleEvidence(item, session.identity.sessionId, session.durable.runId));
  return hasEvidence ? "terminal" : "evidence";
}

export function descriptorAllowedForRepair(
  descriptor: ToolDescriptor,
  phase: CompletionRepairPhase
): boolean {
  if (phase === "none") return true;
  const action = terminalProtocolAction(descriptor);
  if (phase === "evidence" && action === "request_input") return true;
  if (phase === "protected_completion") {
    return (descriptor.name === "complete_task" && action === "complete")
      || (descriptor.name === "request_user_input" && action === "request_input");
  }
  if (phase === "protected_recovery" && action !== null) {
    return (descriptor.name === "complete_task" && action === "complete")
      || (descriptor.name === "request_user_input" && action === "request_input");
  }
  if (phase === "terminal") return action !== null;
  const maximum = descriptor.maximumEffects ?? descriptor.possibleEffects;
  return [...descriptor.possibleEffects, ...maximum].every((effect) =>
    effect !== "outcome.propose" && effect !== "outcome.request_input");
}

export function effectsAllowedForRepair(
  effects: readonly ToolEffect[],
  phase: CompletionRepairPhase
): boolean {
  if (phase === "none") return true;
  const terminalEffects = effects.filter((effect) =>
    effect === "outcome.propose" || effect === "outcome.request_input");
  if (terminalEffects.length === 0) return phase === "evidence" || phase === "protected_recovery";
  if (effects.length !== 1 || terminalEffects.length !== 1) return false;
  if (phase === "protected_completion") return terminalEffects[0] === "outcome.propose"
    || terminalEffects[0] === "outcome.request_input";
  if (phase === "protected_recovery") return terminalEffects[0] === "outcome.propose"
    || terminalEffects[0] === "outcome.request_input";
  if (phase === "terminal") return true;
  return terminalEffects[0] === "outcome.request_input";
}

export function descriptorsAllowedForRepair(
  descriptors: readonly ToolDescriptor[],
  phase: CompletionRepairPhase
): ToolDescriptor[] {
  return descriptors.filter((descriptor) => descriptorAllowedForRepair(descriptor, phase));
}
