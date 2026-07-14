import { isCompletionEligibleEvidence, type ToolDescriptor } from "agent-protocol";
import type { RuntimeSession } from "./types.js";

export type CompletionRepairPhase = "none" | "evidence" | "terminal";

export function completionRepairPhase(session: RuntimeSession): CompletionRepairPhase {
  if (session.durable.state.completionRepairAttempts === 0) return "none";
  const hasEvidence = session.durable.state.evidence.some((item) =>
    isCompletionEligibleEvidence(item, session.identity.sessionId, session.durable.runId));
  return hasEvidence ? "terminal" : "evidence";
}

export function descriptorAllowedForRepair(
  descriptor: ToolDescriptor,
  phase: CompletionRepairPhase
): boolean {
  if (phase === "none") return true;
  const proposesCompletion = descriptor.possibleEffects.includes("outcome.propose");
  if (phase === "evidence") return !proposesCompletion;
  return descriptor.possibleEffects.some((effect) =>
    effect === "outcome.propose" || effect === "outcome.request_input");
}

export function descriptorsAllowedForRepair(
  descriptors: readonly ToolDescriptor[],
  phase: CompletionRepairPhase
): ToolDescriptor[] {
  return descriptors.filter((descriptor) => descriptorAllowedForRepair(descriptor, phase));
}
