import {
  evidenceSupportsClaim,
  isCompletionReferenceableEvidence,
  type ToolDescriptor,
  type ToolEffect
} from "agent-protocol";
import type { RuntimeSession } from "./types.js";
import { completionCoordinatorState } from "./completion-evidence-gate.js";

export type CompletionRepairPhase =
  | "none"
  | "evidence"
  | "review_repair"
  | "terminal"
  | "failed_validation_terminal"
  | "no_change_confirmation"
  | "protected_completion"
  | "protected_recovery";

export function internalToolForRepair(name: string, phase: CompletionRepairPhase): boolean {
  return phase === "no_change_confirmation" && name === "confirm_no_change";
}

function hasExitedFailedValidation(session: RuntimeSession): boolean {
  return session.durable.state.evidence.some((item) => item.sessionId === session.identity.sessionId
    && item.runId === session.durable.runId
    && item.kind === "validation"
    && item.status === "failed"
    && evidenceSupportsClaim(item, "validation_executed"));
}

function prerequisiteRepairPhase(session: RuntimeSession): CompletionRepairPhase {
  return completionCoordinatorState(session).runCompleted ? "protected_completion" : "evidence";
}

function terminalRepairPhase(
  session: RuntimeSession,
  fallback: "terminal" | "protected_completion"
): CompletionRepairPhase {
  return hasExitedFailedValidation(session) ? "failed_validation_terminal" : fallback;
}

function evidenceAcquisitionPhase(session: RuntimeSession): CompletionRepairPhase {
  // A failed validation is still referenceable for the narrow
  // validation_executed claim. Once it is durable, asking for another
  // evidence tool would make an honest failure look like an unfinished
  // validation obligation.
  const hasReferenceableEvidence = session.durable.state.evidence.some((item) =>
    isCompletionReferenceableEvidence(item, session.identity.sessionId, session.durable.runId));
  return hasReferenceableEvidence ? terminalRepairPhase(session, "terminal") : "evidence";
}

function explicitRepairPhase(session: RuntimeSession): CompletionRepairPhase | null {
  const repair = session.durable.state.completionRepair;
  if (repair?.kind === "evidence_acquisition") return evidenceAcquisitionPhase(session);
  if (repair?.kind === "review_changes_requested") return "review_repair";
  if (repair?.kind === "terminal_action") return terminalRepairPhase(session, "terminal");
  if (repair?.kind === "no_change_confirmation") return "no_change_confirmation";
  if (repair?.kind === "protected_completion") return terminalRepairPhase(session, "protected_completion");
  if (repair?.kind === "protected_recovery") return "protected_recovery";
  if (repair?.kind === "completion_prerequisite") return prerequisiteRepairPhase(session);
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
  if (phase !== "no_change_confirmation") return true;
  return ["confirm_no_change", "request_user_input", "report_blocked"].includes(descriptor.name);
}

export function effectsAllowedForRepair(
  effects: readonly ToolEffect[],
  phase: CompletionRepairPhase
): boolean {
  if (phase !== "no_change_confirmation") return true;
  return effects.length === 1 && [
    "outcome.propose", "outcome.request_input", "outcome.report_blocked"
  ].includes(effects[0] ?? "");
}

export function descriptorsAllowedForRepair(
  descriptors: readonly ToolDescriptor[],
  phase: CompletionRepairPhase
): ToolDescriptor[] {
  return descriptors.filter((descriptor) => descriptorAllowedForRepair(descriptor, phase));
}
