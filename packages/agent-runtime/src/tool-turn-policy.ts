import {
  evidenceSupportsClaim,
  isCompletionReferenceableEvidence,
  type ToolDescriptor,
  type ToolEffect
} from "agent-protocol";
import type { RuntimeSession } from "./types.js";

export type CompletionRepairPhase =
  | "none"
  | "evidence"
  | "terminal"
  | "failed_validation_terminal"
  | "protected_completion"
  | "protected_recovery";

function hasExitedFailedValidation(session: RuntimeSession): boolean {
  return session.durable.state.evidence.some((item) => item.sessionId === session.identity.sessionId
    && item.runId === session.durable.runId
    && item.kind === "validation"
    && item.status === "failed"
    && evidenceSupportsClaim(item, "validation_executed"));
}

function prerequisiteRepairPhase(
  session: RuntimeSession,
  evidenceCount: number
): CompletionRepairPhase {
  const referenceableEvidence = session.durable.state.evidence.filter((item) =>
    isCompletionReferenceableEvidence(item, session.identity.sessionId, session.durable.runId)).length;
  return referenceableEvidence > evidenceCount ? "protected_completion" : "evidence";
}

function explicitRepairPhase(session: RuntimeSession): CompletionRepairPhase | null {
  const repair = session.durable.state.completionRepair;
  if (repair?.kind === "evidence_acquisition") {
    // A failed validation is still referenceable for the narrow
    // validation_executed claim. Once it is durable, asking for another
    // evidence tool would make an honest failure look like an unfinished
    // validation obligation. Restrict the next turn to terminal actions so
    // the agent can report exactly what happened.
    const hasReferenceableEvidence = session.durable.state.evidence.some((item) =>
      isCompletionReferenceableEvidence(item, session.identity.sessionId, session.durable.runId));
    return hasReferenceableEvidence
      ? hasExitedFailedValidation(session) ? "failed_validation_terminal" : "terminal"
      : "evidence";
  }
  if (repair?.kind === "terminal_action") {
    return hasExitedFailedValidation(session) ? "failed_validation_terminal" : "terminal";
  }
  if (repair?.kind === "protected_completion") {
    return hasExitedFailedValidation(session) ? "failed_validation_terminal" : "protected_completion";
  }
  if (repair?.kind === "protected_recovery") return "protected_recovery";
  if (repair?.kind === "completion_prerequisite") return prerequisiteRepairPhase(session, repair.evidenceCount);
  return null;
}

export function completionRepairPhase(session: RuntimeSession): CompletionRepairPhase {
  const explicit = explicitRepairPhase(session);
  if (explicit) return explicit;
  if (session.durable.state.completionRepairAttempts === 0) return "none";
  // Compatibility for snapshots created before repair intent was durable.
  const hasEvidence = session.durable.state.evidence.some((item) =>
    isCompletionReferenceableEvidence(item, session.identity.sessionId, session.durable.runId));
  return hasEvidence ? "terminal" : "evidence";
}

export function descriptorAllowedForRepair(
  descriptor: ToolDescriptor,
  phase: CompletionRepairPhase
): boolean {
  void phase;
  void descriptor;
  return true;
}

export function effectsAllowedForRepair(
  effects: readonly ToolEffect[],
  phase: CompletionRepairPhase
): boolean {
  void effects;
  void phase;
  return true;
}

export function descriptorsAllowedForRepair(
  descriptors: readonly ToolDescriptor[],
  phase: CompletionRepairPhase
): ToolDescriptor[] {
  void phase;
  return [...descriptors];
}
