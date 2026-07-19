import type { EvidenceRecord } from "./domain.js";
import type { ValidationClaimKindV1 } from "./execution-v5.js";

export type RunMode = "analyze" | "change";

export type ValidationCapabilityUnavailableLimitationV1 = {
  kind: "validation_capability_unavailable";
  claim: ValidationClaimKindV1;
  attemptedCommandSummary: string;
  capabilityEvidenceId: string;
  reason: string;
};

export type CompletionLimitationV1 = ValidationCapabilityUnavailableLimitationV1;

/** Trusted control-plane classification of whether validation is merely the
 * runtime's default assurance obligation or an explicit user requirement.
 * Omitted values are interpreted conservatively as `required`. */
export type ValidationRequirementV1 = "default" | "required";

export type RunOutcome =
  | { kind: "completed"; message: string; evidence: EvidenceRecord[] }
  | {
    kind: "completed_with_limitations";
    message: string;
    evidence: EvidenceRecord[];
    limitations: CompletionLimitationV1[];
  }
  | { kind: "needs_input"; requestId: string; message: string }
  | { kind: "cancelled"; reason: string }
  | { kind: "recoverable_failure"; code: string; message: string; resumeToken?: string }
  | { kind: "fatal"; code: string; message: string };

export type RunCommand =
  | {
    type: "submit";
    sessionId: string;
    text: string;
    mode?: RunMode;
    validationRequirement?: ValidationRequirementV1;
  }
  | { type: "steer"; sessionId: string; text: string; validationRequirement?: ValidationRequirementV1 }
  | { type: "follow_up"; sessionId: string; text: string; validationRequirement?: ValidationRequirementV1 }
  | { type: "approve"; sessionId: string; requestId: string; decision: "allow" | "deny" | "always_allow" }
  /** User-only control-plane decision for an interrupted open checkpoint. */
  | {
    type: "checkpoint_recovery";
    sessionId: string;
    checkpointId: string;
    decision: "restore" | "keep";
  }
  /** User-only additive increase; profiles, hooks, and models cannot issue this command. */
  | {
    type: "budget_increase";
    sessionId: string;
    increase: Partial<import("./domain.js").BudgetLimits>;
  }
  /** User-only, one-shot waiver for one pending independent-review obligation. */
  | {
    type: "reviewer_waiver";
    sessionId: string;
    reason: string;
    /** Defaults to the latest pending non-documentation checkpoint. */
    checkpointId?: string;
  }
  | { type: "cancel"; sessionId: string; reason?: string }
  | { type: "resume"; sessionId: string };
