import { mutationFrontierHasChanges } from "agent-kernel";
import {
  authenticCurrentReviewApproval,
  currentFrontierReview
} from "./mutation-evidence.js";
import {
  completionAdvisory,
  completionFindingText,
  completionGateDigest,
  hasCompletionAdvisory,
  type CompletionGateDecision
} from "./completion-gate-common.js";
import type { RuntimeSession } from "./types.js";

function strictState(session: RuntimeSession) {
  const frontier = session.durable.state.mutationFrontier;
  const review = currentFrontierReview(session);
  return {
    frontier,
    review,
    reviewSatisfied: authenticCurrentReviewApproval(session, review, true)
  };
}

type StrictState = ReturnType<typeof strictState>;

function strictBasisDigest(session: RuntimeSession, state: StrictState): string {
  return completionGateDigest({
    profile: "strict",
    frontierRevision: state.frontier.revision,
    stateDigest: state.frontier.currentStateDigest,
    reviewStatus: state.review?.status ?? null,
    reviewVerdict: state.review?.data.verdict ?? null,
    findings: state.review?.data.findings ?? []
  });
}

function strictMissing(state: StrictState): string[] {
  const missing: string[] = [];
  if (!state.reviewSatisfied) {
    missing.push(
      "reviewer approval with at least one durable reviewer-executed check bound to the current mutation frontier"
    );
  }
  return missing;
}

function strictFindings(state: StrictState): string {
  const findings = state.review?.data.findings ?? [];
  return findings.length > 0
    ? ` Reviewer findings: ${findings.slice(0, 20).map(completionFindingText).join("; ")}.`
    : "";
}

export function strictCompletionDecision(
  session: RuntimeSession
): CompletionGateDecision {
  const state = strictState(session);
  if (!mutationFrontierHasChanges(state.frontier)) {
    return {
      action: "complete",
      authority: "user_policy",
      validationStatus: "not_needed"
    };
  }
  if (state.reviewSatisfied) {
    return {
      action: "complete",
      authority: "verification_verdict",
      validationStatus: "passed",
      statusNote:
        "Strict completion policy: the current mutation frontier was approved using a durable reviewer-executed check."
    };
  }
  if (state.review?.data.failureKind !== undefined
    || state.review?.data.verdict === "blocked") {
    return {
      action: "fail",
      authority: "verification_verdict",
      code: "verification_unavailable",
      message: `Strict completion verification was unavailable: ${
        state.review?.summary ?? "no current reviewer evidence"
      }.`
    };
  }
  const basisDigest = strictBasisDigest(session, state);
  const missing = strictMissing(state);
  const findings = strictFindings(state);
  if (!hasCompletionAdvisory(session, basisDigest)) {
    return completionAdvisory(
      basisDigest,
      `Strict completion requirements are not yet satisfied: ${missing.join("; ")}.${findings} `
        + "Address the evidence or findings and then stop naturally again. All permitted safety and development tools remain available.",
      "verification_verdict"
    );
  }
  return {
    action: "fail",
    authority: "verification_verdict",
    code: "verification_failed",
    message: `Strict completion policy remained unsatisfied after an unchanged second stop: ${missing.join("; ")}.${findings}`
  };
}
