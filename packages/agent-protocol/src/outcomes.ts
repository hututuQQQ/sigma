import type { EvidenceRecord } from "./domain.js";

export type RunMode = "analyze" | "change";

export type DecisionAuthority =
  | "safety_invariant"
  | "resource_boundary"
  | "provider_protocol"
  | "user_policy"
  | "verification_verdict";

export type RunOutcome =
  | {
    kind: "completed";
    message: string;
    evidence: EvidenceRecord[];
    decisionAuthority?: DecisionAuthority;
  }
  | {
    kind: "needs_input";
    requestId: string;
    message: string;
    decisionAuthority?: DecisionAuthority;
  }
  | {
    kind: "cancelled";
    reason: string;
    decisionAuthority?: DecisionAuthority;
  }
  | {
    kind: "recoverable_failure";
    code: string;
    message: string;
    resumeToken?: string;
    /** Present only for a runtime-authorized report_blocked outcome. */
    failureKind?: "blocked";
    /** Stable structured code mirrored for external runners. */
    failureCode?: string;
    decisionAuthority?: DecisionAuthority;
  }
  | {
    kind: "fatal";
    code: string;
    message: string;
    decisionAuthority?: DecisionAuthority;
  };

export type RunCommand =
  | { type: "submit"; sessionId: string; text: string; mode?: RunMode }
  | { type: "steer"; sessionId: string; text: string }
  | { type: "follow_up"; sessionId: string; text: string }
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
  /** User-only, one-shot audit waiver for one unreviewed mutation delta. */
  | {
    type: "reviewer_waiver";
    sessionId: string;
    reason: string;
    /** Defaults to the next still-unassigned current-run mutation checkpoint. */
    checkpointId?: string;
  }
  | { type: "cancel"; sessionId: string; reason?: string }
  | { type: "resume"; sessionId: string };
