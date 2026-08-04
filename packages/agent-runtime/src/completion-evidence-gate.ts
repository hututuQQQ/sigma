import { mutationFrontierHasChanges } from "agent-kernel";
import {
  completionAdvisory as advisory,
  completionFindingText as findingText,
  completionGateDigest as digest,
  hasCompletionAdvisory as hasAdvisory,
  type CompletionGateDecision
} from "./completion-gate-common.js";
import { strictCompletionDecision } from "./completion-gate-strict.js";
import {
  currentFrontierReview,
  currentFrontierValidationStatus,
  frontierValidationReadiness
} from "./mutation-evidence.js";
import type { RuntimeSession } from "./types.js";
import { substantiveReview } from "./review-coordinator-support.js";
import { rawAvailableBudget } from "./assurance-budget.js";

export { completionCandidate } from "./completion-gate-common.js";
export { completionFailure } from "./completion-terminal-gate.js";
export type {
  CompletionCandidate,
  CompletionGateDecision
} from "./completion-gate-common.js";

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function reviewMode(session: RuntimeSession): "off" | "advisory" | "required" {
  return session.services.profile?.profile.mutationPolicy.reviewMode ?? "advisory";
}

export function automaticCompletionReviewRequired(session: RuntimeSession): boolean {
  return reviewMode(session) === "required";
}

function unresolvedRepositoryTransactions(session: RuntimeSession): string[] {
  const open = new Set<string>();
  for (const receipt of session.durable.state.receipts) {
    const result = record(receipt.result);
    const handle = typeof result?.transactionHandle === "string"
      ? result.transactionHandle
      : "";
    if (!handle) continue;
    if (result?.status === "conflicts_pending") open.add(handle);
    else if (["completed", "aborted", "restored"].includes(String(result?.status))) open.delete(handle);
  }
  return [...open];
}

function sealedMutationEvidenceMissing(session: RuntimeSession): boolean {
  const head = session.durable.state.checkpointHead;
  if (head?.status !== "sealed" || !head.delta
    || head.delta.added.length + head.delta.modified.length + head.delta.deleted.length === 0) {
    return false;
  }
  return ![...session.durable.state.mutationEvidence, ...session.durable.state.evidence]
    .some((item) => item.kind === "workspace_delta"
      && item.data.checkpointId === head.checkpointId);
}

export function completionReviewBlocker(
  session: RuntimeSession
): string | undefined {
  const approvals = session.durable.state.pendingTools.filter((item) =>
    item.approval === "pending");
  if (approvals.length > 0 || session.interaction.approvals.size > 0) {
    return "Completion is blocked while an approval decision is unsettled. Resolve or cancel the pending request first.";
  }
  if (session.durable.state.activeProcessIds.length > 0) {
    return "Completion is blocked while session processes remain active. Terminate them or hand off verified deliverable processes first. "
      + `Active process IDs: ${session.durable.state.activeProcessIds.join(", ")}.`;
  }
  if (session.durable.state.checkpointHead?.status === "open"
    || session.recovery.openCheckpointRecovery) {
    return "Completion is blocked by an open checkpoint. Restore it or explicitly keep and seal it first.";
  }
  if (sealedMutationEvidenceMissing(session)) {
    return "Completion is blocked because the latest sealed mutation checkpoint has no durable workspace-delta evidence.";
  }
  const transactions = unresolvedRepositoryTransactions(session);
  if (transactions.length > 0) {
    return "Completion is blocked by an uncommitted repository transaction. Continue or abort it first. "
      + `Transaction handles: ${transactions.join(", ")}.`;
  }
  if (session.execution.controller?.signal.aborted) {
    return "Completion cannot be committed because cancellation has been requested.";
  }
  return undefined;
}

type StandardValidationKind = "not_needed" | "passed" | "failed" | "incomplete" | "unverified";
type FrontierValidation = ReturnType<typeof currentFrontierValidationStatus>;
type PlanNode = RuntimeSession["durable"]["state"]["plan"]["nodes"][number];

function standardValidationKind(
  changedPathCount: number,
  validation: FrontierValidation
): StandardValidationKind {
  if (changedPathCount === 0) return "not_needed";
  if (validation.passed) return "passed";
  if (validation.latestFailed) return "failed";
  return validation.hasRecord ? "incomplete" : "unverified";
}

function standardBasisDigest(
  session: RuntimeSession,
  incompleteNodes: readonly PlanNode[],
  validationKind: StandardValidationKind,
  validation: FrontierValidation,
  claimGaps: readonly string[]
): string {
  const frontier = session.durable.state.mutationFrontier;
  return digest({
    profile: "standard",
    planRevision: session.durable.state.plan.revision,
    incompleteNodes: incompleteNodes.map((node) => ({
      id: node.id, status: node.status, blockedReason: node.blockedReason ?? null
    })),
    frontierRevision: frontier.revision,
    stateDigest: frontier.currentStateDigest,
    validationKind,
    latestValidationId: validation.validations.at(-1)?.evidenceId ?? null,
    claimGaps
  });
}

function repairIssues(
  incompleteNodes: readonly PlanNode[],
  validationKind: StandardValidationKind,
  validation: FrontierValidation,
  claimGaps: readonly string[]
): string[] {
  const issues: string[] = [];
  if (incompleteNodes.length > 0) {
    issues.push(`the durable plan still has ${incompleteNodes.length} unfinished node(s): ${incompleteNodes
      .slice(0, 12).map((node) => `${node.id}[${node.status}]`).join(", ")}`);
  }
  if (validationKind === "unverified") {
    issues.push("the current mutation frontier has not been validated");
  } else if (validationKind === "failed") {
    issues.push(`the latest current-frontier validation failed${validation.latestFailed
      ? ` (${validation.latestFailed.summary})` : ""}`);
  } else if (validationKind === "incomplete") {
    issues.push("current-frontier validation records are incomplete");
  }
  if (claimGaps.length > 0 && validationKind === "passed") {
    issues.push(
      `the passing validation does not yet establish the inferred behavioral coverage: ${claimGaps.join(", ")}`
    );
  }
  return issues;
}

function completionStatusNote(
  session: RuntimeSession,
  incompleteNodes: readonly PlanNode[],
  validationKind: StandardValidationKind,
  validation: FrontierValidation,
  claimGaps: readonly string[]
): string | undefined {
  const planNote = incompleteNodes.length > 0
    ? `Plan status: incomplete (${incompleteNodes.length} unfinished node(s)).`
    : session.durable.state.plan.nodes.length > 0 ? "Plan status: complete." : undefined;
  let validationNote: string | undefined;
  if (validationKind === "passed") {
    validationNote = "Validation status: passed for the current mutation frontier.";
  } else if (validationKind === "failed") {
    validationNote = `Validation status: failed for the current mutation frontier${validation.latestFailed
      ? ` (${validation.latestFailed.summary})` : ""}.`;
  } else if (validationKind === "incomplete") {
    validationNote = "Validation status: recorded but incomplete for the current mutation frontier.";
  } else if (validationKind === "unverified") {
    validationNote = "Validation status: not run for the current mutation frontier.";
  }
  const coverageNote = claimGaps.length > 0 && validationKind === "passed"
    ? `Validation coverage advisory: inferred ${claimGaps.join(", ")} behavior remains unestablished.`
    : undefined;
  const review = currentFrontierReview(session);
  const reviewNote = review && substantiveReview(review) && review.data.verdict !== "approved"
    ? `Independent advisory review status: ${review.data.verdict}; unresolved findings remain.`
    : undefined;
  const note = [planNote, validationNote, coverageNote, reviewNote].filter(Boolean).join(" ");
  return note || undefined;
}

function publicValidationStatus(
  validationKind: StandardValidationKind
): Extract<CompletionGateDecision, { action: "complete" }>["validationStatus"] {
  if (validationKind === "not_needed" || validationKind === "passed") return validationKind;
  return validationKind === "failed" ? "failed" : "unverified";
}

function standardUncheckedDecision(session: RuntimeSession): CompletionGateDecision {
  const frontier = session.durable.state.mutationFrontier;
  const validation = currentFrontierValidationStatus(session);
  const claimGaps = frontierValidationReadiness(session).missingClaims;
  const incompleteNodes = session.durable.state.plan.nodes.filter((node) =>
    node.status === "pending" || node.status === "in_progress" || node.status === "blocked");
  const validationKind = standardValidationKind(
    mutationFrontierHasChanges(frontier) ? 1 : 0,
    validation
  );
  const needsRepair = incompleteNodes.length > 0
    || !["not_needed", "passed"].includes(validationKind)
    || claimGaps.length > 0;
  const basisDigest = standardBasisDigest(
    session, incompleteNodes, validationKind, validation, claimGaps
  );
  const available = rawAvailableBudget(session);
  const repairTurnAvailable = available.inputTokens > 0
    && available.outputTokens > 0
    && available.modelTurns > 0;
  if (needsRepair && repairTurnAvailable && !hasAdvisory(session, basisDigest)) {
    const issues = repairIssues(incompleteNodes, validationKind, validation, claimGaps);
    return advisory(
      basisDigest,
      `Before natural completion, ${issues.join("; ")}. This is one repair opportunity for this unchanged plan/frontier basis. `
        + "Use the highest-value validation or finish/update the plan if that advances the user's goal. "
        + "All permitted tools remain available; stopping again without a state change is allowed and will be reported explicitly."
    );
  }
  const ordinaryStatus = completionStatusNote(
    session,
    incompleteNodes,
    validationKind,
    validation,
    claimGaps
  );
  const boundaryStatus = needsRepair && !repairTurnAvailable
    ? "Model-turn budget exhausted; unresolved Standard advisory items are reported without an impossible repair turn."
    : undefined;
  const statusNote = [ordinaryStatus, boundaryStatus].filter(Boolean).join(" ") || undefined;
  return {
    action: "complete",
    authority: "user_policy",
    validationStatus: publicValidationStatus(validationKind),
    ...(statusNote ? { statusNote } : {})
  };
}

function reviewRepairDetails(
  review: NonNullable<ReturnType<typeof currentFrontierReview>>
): string {
  const findings = review.data.findings.slice(0, 20).map(findingText);
  const criteria = (review.data.criteria ?? [])
    .filter((item) => item.status !== "satisfied")
    .slice(0, 20)
    .map((item) => `${item.criterion} [${item.status}]${item.summary ? `: ${item.summary}` : ""}`);
  const validations = (review.data.requiredValidations ?? [])
    .slice(0, 12)
    .map((item) => item.purpose);
  return [
    ...(findings.length > 0 ? [`findings: ${findings.join("; ")}`] : []),
    ...(criteria.length > 0 ? [`acceptance gaps: ${criteria.join("; ")}`] : []),
    ...(validations.length > 0 ? [`validation targets: ${validations.join("; ")}`] : [])
  ].join(" ");
}

function reviewRepairDecision(
  session: RuntimeSession,
  review: NonNullable<ReturnType<typeof currentFrontierReview>>
): Extract<CompletionGateDecision, { action: "continue" | "fail" }> | undefined {
  const frontier = session.durable.state.mutationFrontier;
  const reviewAttempts = session.durable.state.evidence.filter((item) =>
    item.kind === "review" && item.runId === session.durable.runId
      && substantiveReview(item)).length;
  const reviewRounds =
    session.services.profile?.profile.assurancePolicy?.reviewRounds ?? 2;
  const basisDigest = digest({
    kind: "verification_repair",
    frontierRevision: frontier.revision,
    stateDigest: frontier.currentStateDigest,
    planRevision: session.durable.state.plan.revision,
    reviewEvidenceId: review.evidenceId,
    reviewVerdict: review.data.verdict
  });
  const details = reviewRepairDetails(review);
  if (reviewAttempts < reviewRounds && !hasAdvisory(session, basisDigest)) {
    return advisory(
      basisDigest,
      `Independent completion review did not approve this result (${review.data.verdict}). `
        + `${details || review.summary} This is the single repair opportunity. `
        + "Address the actionable findings or run the requested validation, update the work plan if facts changed, and then stop naturally again.",
      "verification_verdict"
    );
  }
  if (reviewMode(session) !== "required") {
    const unresolvedBasisDigest = digest({
      kind: "advisory_review_unresolved",
      frontierRevision: frontier.revision,
      stateDigest: frontier.currentStateDigest,
      planRevision: session.durable.state.plan.revision,
      reviewEvidenceId: review.evidenceId,
      reviewVerdict: review.data.verdict
    });
    if (hasAdvisory(session, unresolvedBasisDigest)) return undefined;
    return advisory(
      unresolvedBasisDigest,
      `Independent advisory review remains unresolved (${review.data.verdict}). `
        + `${details || review.summary} Standard mode does not convert an advisory review into a runtime failure. `
        + "Address the findings if useful, or stop naturally and report the unresolved review status. "
        + "Request another review only after adding materially new evidence.",
      "verification_verdict"
    );
  }
  return {
    action: "fail",
    authority: "verification_verdict",
    code: "verification_failed",
    message: reviewAttempts >= reviewRounds
      ? `Independent completion review still did not approve after repair and re-review. ${details || review.summary}`
      : `The task stopped again without changing the frontier, validation, or plan after review requested repair. ${details || review.summary}`
  };
}

/**
 * Explicit review is binding only for profiles whose review mode is required.
 * Advisory profiles preserve the findings and one repair opportunity, then
 * return control to ordinary solving so a natural stop can report them.
 */
export function explicitReviewGateDecision(
  session: RuntimeSession
): Extract<CompletionGateDecision, { action: "continue" | "fail" }> | undefined {
  const review = currentFrontierReview(session);
  if (!review || review.data.verdict === "approved" || !substantiveReview(review)) {
    return undefined;
  }
  return reviewRepairDecision(session, review);
}

export function completionGateDecision(session: RuntimeSession): CompletionGateDecision {
  const invariant = completionReviewBlocker(session);
  if (invariant) {
    const frontier = session.durable.state.mutationFrontier;
    const basisDigest = digest({
      kind: "hard_completion_invariant",
      message: invariant,
      frontierRevision: frontier.revision,
      stateDigest: frontier.currentStateDigest
    });
    return advisory(
      basisDigest,
      `${invariant} This is a deterministic safety/transaction invariant; all tools needed to settle it remain available.`,
      "safety_invariant"
    );
  }
  return automaticCompletionReviewRequired(session)
    ? strictCompletionDecision(session)
    : standardUncheckedDecision(session);
}
