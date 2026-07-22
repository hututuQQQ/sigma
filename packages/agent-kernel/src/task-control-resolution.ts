import type { TaskControlStateV1 } from "./task-control-state.js";

/** Resolve a repeated policy violation from the runtime-owned obligation,
 * never from the model-selected tool name or diagnostic wording. */
export function policyExhaustionCode(control: TaskControlStateV1): string {
  const obligation = control.obligation;
  if (obligation?.kind === "terminal_resolution") return obligation.failureCode;
  if (obligation?.kind === "completion_evidence" && obligation.failureCode) {
    return obligation.failureCode;
  }
  switch (obligation?.kind) {
    case "review_repair": return "review_repair_exhausted";
    case "capability_recovery": return "capability_recovery_exhausted";
    case "repository_recovery": return "repository_recovery_exhausted";
    case "restoration": return "restoration_incomplete";
    case "process_settlement": return "process_settlement_failed";
    case "user_decision": return "user_decision_action_required";
    default: return "action_convergence_no_progress";
  }
}
