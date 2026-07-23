import type { EvidenceRecord, JsonValue } from "agent-protocol";
import type { KernelState } from "./state.js";
import {
  resolveTaskObligation,
  reviewRepairObligation,
  terminalResolutionObligation,
  userDecisionObligation
} from "./task-control.js";
import { restorationObligation } from "./restoration-task-control.js";

function actionableReviewFinding(value: JsonValue): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return true;
  const finding = value as Record<string, JsonValue>;
  return finding.actionable === true && finding.severity === "error";
}

function findingCode(value: JsonValue): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const code = (value as Record<string, JsonValue>).code;
  return typeof code === "string" ? code : undefined;
}

function reviewFailureTransition(
  state: KernelState,
  review: Extract<EvidenceRecord, { kind: "review" }>
): KernelState {
  const obligation = state.taskControl.obligation;
  const sameBasisFailures = state.evidence.filter((item) => item.kind === "review"
    && item.data.reviewBasisDigest === review.data.reviewBasisDigest
    && item.data.failureKind === review.data.failureKind).length;
  const unavailable = obligation?.kind === "review_repair" && obligation.stage === "re_review"
    && review.data.failureKind === "protocol" && sameBasisFailures >= 2;
  return unavailable
    ? { ...state, taskControl: terminalResolutionObligation(state.taskControl, state.revision, "review_unavailable") }
    : state;
}

function actionableReviewTransition(
  state: KernelState,
  review: Extract<EvidenceRecord, { kind: "review" }>
): KernelState {
  const obligation = state.taskControl.obligation;
  const userDecision = review.data.findings.find((finding) =>
    actionableReviewFinding(finding) && findingCode(finding) === "user_decision_required");
  if (userDecision) {
    return {
      ...state,
      taskControl: state.mutationFrontier.changedPaths.length > 0
        ? restorationObligation(state.taskControl, state.revision, "review_user_decision_required")
        : userDecisionObligation(state.taskControl, state.revision, "review_user_decision_required")
    };
  }
  if (obligation?.kind === "review_repair" && obligation.stage === "re_review") {
    return {
      ...state,
      taskControl: terminalResolutionObligation(state.taskControl, state.revision, "review_repair_exhausted")
    };
  }
  return {
    ...state,
    taskControl: reviewRepairObligation(
      state.taskControl,
      state.revision,
      review.data.reviewBasisDigest ?? review.data.stateDigest,
      state.mutationFrontier.changedPaths
    )
  };
}

export function reviewTaskControl(
  state: KernelState,
  review: Extract<EvidenceRecord, { kind: "review" }>
): KernelState {
  const obligation = state.taskControl.obligation;
  if (review.data.failureKind) return reviewFailureTransition(state, review);
  if (review.status === "passed" && review.data.verdict === "approved") {
    return obligation?.kind === "review_repair" && obligation.stage === "re_review"
      ? { ...state, taskControl: resolveTaskObligation(state.taskControl) }
      : state;
  }
  if (!review.data.findings.some(actionableReviewFinding)) return state;
  return actionableReviewTransition(state, review);
}
