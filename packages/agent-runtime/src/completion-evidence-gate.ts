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
  authenticCurrentReviewApproval,
  currentFrontierReview,
  currentFrontierValidationStatus,
  sessionMutationEvidence,
  unresolvedWorkspaceDeltas
} from "./mutation-evidence.js";
import type { RuntimeSession } from "./types.js";
import { reviewerWaivedDeltaIds } from "./review-waiver-policy.js";
import { substantiveReview } from "./review-coordinator-support.js";

export { completionCandidate } from "./completion-gate-common.js";
export { completionFailure } from "./completion-terminal-gate.js";
export type {
  CompletionCandidateV1,
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
  validation: FrontierValidation
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
    latestValidationId: validation.validations.at(-1)?.evidenceId ?? null
  });
}

function repairIssues(
  incompleteNodes: readonly PlanNode[],
  validationKind: StandardValidationKind,
  validation: FrontierValidation
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
  return issues;
}

function completionStatusNote(
  session: RuntimeSession,
  incompleteNodes: readonly PlanNode[],
  validationKind: StandardValidationKind,
  validation: FrontierValidation
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
  const note = [planNote, validationNote].filter(Boolean).join(" ");
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
  const incompleteNodes = session.durable.state.plan.nodes.filter((node) =>
    node.status === "pending" || node.status === "in_progress" || node.status === "blocked");
  const validationKind = standardValidationKind(
    mutationFrontierHasChanges(frontier) ? 1 : 0,
    validation
  );
  const needsRepair = incompleteNodes.length > 0
    || !["not_needed", "passed"].includes(validationKind);
  const basisDigest = standardBasisDigest(session, incompleteNodes, validationKind, validation);
  if (needsRepair && !hasAdvisory(session, basisDigest)) {
    const issues = repairIssues(incompleteNodes, validationKind, validation);
    return advisory(
      basisDigest,
      `Before natural completion, ${issues.join("; ")}. This is one repair opportunity for this unchanged plan/frontier basis. `
        + "Use the highest-value validation or finish/update the plan if that advances the user's goal. "
        + "All permitted tools remain available; stopping again without a state change is allowed and will be reported explicitly."
    );
  }
  const statusNote = completionStatusNote(session, incompleteNodes, validationKind, validation);
  return {
    action: "complete",
    authority: "user_policy",
    validationStatus: publicValidationStatus(validationKind),
    ...(statusNote ? { statusNote } : {})
  };
}

function currentReviewWaiver(session: RuntimeSession): boolean {
  const evidence = sessionMutationEvidence(session);
  const waived = reviewerWaivedDeltaIds(evidence);
  const unresolved = unresolvedWorkspaceDeltas(session);
  const environmentChanged =
    (session.durable.state.mutationFrontier.environmentChangedPaths?.length ?? 0) > 0;
  const broadWaiver = evidence.some((item) =>
    item.kind === "user_waiver"
    && item.runId === session.durable.runId
    && item.data.scope === "review"
    && !item.data.checkpointId);
  return (unresolved.length > 0 || environmentChanged)
    && (broadWaiver
      || (!environmentChanged
        && unresolved.every((item) => waived.has(item.evidenceId))));
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

function unavailableReviewDecision(
  review: ReturnType<typeof currentFrontierReview>
): CompletionGateDecision | undefined {
  if (!review) {
    return {
      action: "fail",
      authority: "verification_verdict",
      code: "verification_unavailable",
      message: "The run changed the workspace, but no independent completion review could be produced for the current frontier. The result is incomplete and is not reported as verified."
    };
  }
  if (review.data.failureKind || review.data.verdict === "blocked") {
    return {
      action: "fail",
      authority: "verification_verdict",
      code: "verification_unavailable",
      message: `Independent completion review was unavailable (${review.summary}). The result is incomplete and is not reported as verified.`
    };
  }
  if (review.data.verdict === "approved") {
    return {
      action: "fail",
      authority: "provider_protocol",
      code: "verification_unavailable",
      message: "Independent completion review claimed approval without valid durable V3 evidence provenance. The result is incomplete and is not reported as verified."
    };
  }
  return undefined;
}

function reviewRepairDecision(
  session: RuntimeSession,
  review: NonNullable<ReturnType<typeof currentFrontierReview>>
): Extract<CompletionGateDecision, { action: "continue" | "fail" }> {
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
 * Explicit review is a protocol barrier. Once it yields the same unresolved
 * verdict after the one repair opportunity, or consumes the final substantive
 * review round, the runtime must not silently reopen ordinary solving.
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

function standardReviewedDecision(session: RuntimeSession): CompletionGateDecision {
  const frontier = session.durable.state.mutationFrontier;
  const validation = currentFrontierValidationStatus(session);
  const validationKind = standardValidationKind(
    mutationFrontierHasChanges(frontier) ? 1 : 0,
    validation
  );
  if (!mutationFrontierHasChanges(frontier)) {
    return standardUncheckedDecision(session);
  }
  if (currentReviewWaiver(session)) {
    return {
      action: "complete",
      authority: "user_policy",
      validationStatus: publicValidationStatus(validationKind),
      statusNote: [
        "Independent review was explicitly waived by the user for this Standard run.",
        completionStatusNote(session, [], validationKind, validation)
      ].filter(Boolean).join(" ")
    };
  }
  const taskBasisReview = currentFrontierReview(session);
  if (taskBasisReview?.status === "passed"
    && authenticCurrentReviewApproval(session, taskBasisReview)) {
    return {
      action: "complete",
      authority: "verification_verdict",
      validationStatus: publicValidationStatus(validationKind),
      statusNote: [
        "Independent reviewer approved the current mutation frontier.",
        completionStatusNote(session, [], validationKind, validation)
      ].filter(Boolean).join(" ")
    };
  }
  const unavailable = unavailableReviewDecision(taskBasisReview);
  return unavailable ?? reviewRepairDecision(session, taskBasisReview!);
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
  return reviewMode(session) === "required"
    ? strictCompletionDecision(session)
    : reviewMode(session) === "off"
      ? standardUncheckedDecision(session)
      : standardReviewedDecision(session);
}
