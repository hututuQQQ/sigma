import { createHash } from "node:crypto";
import {
  type ModelToolCall,
  type ToolDescriptor,
  type ToolReceipt
} from "agent-protocol";
import {
  currentFrontierReview,
  currentFrontierValidationStatus,
  reviewBasisDigest
} from "./mutation-evidence.js";
import { failed } from "./tool-receipt.js";
import type { RuntimeSession } from "./types.js";

const ADVISORY_PREFIX = "[sigma-completion-advisory:";

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function findingText(value: unknown): string {
  if (typeof value === "string") return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

export interface CompletionCandidateV1 {
  answer: string;
  digest: string;
}

export function completionCandidate(session: RuntimeSession): CompletionCandidateV1 | undefined {
  const proposed = session.durable.state.proposedOutcome;
  const answer = proposed?.kind === "completed"
    ? proposed.message.trim()
    : [...session.durable.state.messages].reverse().find((message) =>
        message.role === "assistant"
        && (message.toolCalls?.length ?? 0) === 0
        && message.content.trim().length > 0)?.content.trim() ?? "";
  return answer ? { answer, digest: digest({ answer }) } : undefined;
}

function reviewMode(session: RuntimeSession): "off" | "advisory" | "required" {
  return session.services.profile?.profile.mutationPolicy.reviewMode ?? "advisory";
}

export type CompletionGateDecision =
  | {
      action: "complete";
      validationStatus: "not_needed" | "passed" | "failed" | "unverified";
      statusNote?: string;
    }
  | { action: "continue"; basisDigest: string; message: string }
  | { action: "fail"; code: "strict_policy_failure"; message: string };

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

function hardInvariantMessage(session: RuntimeSession): string | undefined {
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

function hasAdvisory(session: RuntimeSession, basisDigest: string): boolean {
  const marker = `${ADVISORY_PREFIX}${basisDigest}]`;
  return session.durable.state.messages.some((message) =>
    message.role === "developer" && message.content.includes(marker));
}

function advisory(basisDigest: string, body: string): CompletionGateDecision {
  return {
    action: "continue",
    basisDigest,
    message: `${ADVISORY_PREFIX}${basisDigest}]\n${body}`
  };
}

function standardDecision(session: RuntimeSession): CompletionGateDecision {
  const frontier = session.durable.state.mutationFrontier;
  if (frontier.changedPaths.length === 0) {
    return { action: "complete", validationStatus: "not_needed" };
  }
  const validation = currentFrontierValidationStatus(session);
  if (!validation.hasRecord) {
    const basisDigest = digest({
      profile: "standard",
      kind: "validation_missing",
      frontierRevision: frontier.revision,
      stateDigest: frontier.currentStateDigest
    });
    if (!hasAdvisory(session, basisDigest)) {
      return advisory(
        basisDigest,
        "The current mutation frontier has no validation record. This is a one-time advisory, not a hidden completion gate. "
          + "Validate if useful, or stop naturally again to finish with an explicit unverified status. "
          + "All permitted tools remain available."
      );
    }
    return {
      action: "complete",
      validationStatus: "unverified",
      statusNote: "Validation status: not run for the current mutation frontier."
    };
  }
  if (validation.passed) {
    return {
      action: "complete",
      validationStatus: "passed",
      statusNote: "Validation status: passed for the current mutation frontier."
    };
  }
  const failedEvidence = validation.latestFailed;
  return {
    action: "complete",
    validationStatus: failedEvidence ? "failed" : "unverified",
    statusNote: failedEvidence
      ? `Validation status: failed for the current mutation frontier (${failedEvidence.summary}).`
      : "Validation status: recorded but incomplete for the current mutation frontier."
  };
}

function strictState(session: RuntimeSession) {
  const frontier = session.durable.state.mutationFrontier;
  const validation = currentFrontierValidationStatus(session);
  const candidate = completionCandidate(session);
  const review = currentFrontierReview(session, candidate?.digest);
  return {
    frontier,
    candidate,
    review,
    validationSatisfied: validation.passed,
    reviewSatisfied: review?.status === "passed" && review.data.verdict === "approved"
  };
}

type StrictState = ReturnType<typeof strictState>;

function strictBasisDigest(session: RuntimeSession, state: StrictState): string {
  return digest({
    profile: "strict",
    frontierRevision: state.frontier.revision,
    stateDigest: state.frontier.currentStateDigest,
    candidateDigest: state.candidate?.digest ?? null,
    reviewBasisDigest: reviewBasisDigest(session, undefined, state.candidate?.digest),
    validationSatisfied: state.validationSatisfied,
    reviewStatus: state.review?.status ?? null,
    reviewVerdict: state.review?.data.verdict ?? null,
    findings: state.review?.data.findings ?? []
  });
}

function strictMissing(state: StrictState): string[] {
  const missing: string[] = [];
  if (!state.validationSatisfied) {
    missing.push(
      `successful validation bound to frontier ${state.frontier.revision}/${state.frontier.currentStateDigest}`
    );
  }
  if (!state.candidate) missing.push("a non-empty completion candidate");
  if (!state.reviewSatisfied) {
    missing.push("reviewer approval bound to this same completion candidate");
  }
  return missing;
}

function strictFindings(state: StrictState): string {
  const findings = state.review?.data.findings ?? [];
  return findings.length > 0
    ? ` Reviewer findings: ${findings.slice(0, 20).map(findingText).join("; ")}.`
    : "";
}

function strictDecision(session: RuntimeSession): CompletionGateDecision {
  const state = strictState(session);
  if (state.frontier.changedPaths.length === 0) {
    return { action: "complete", validationStatus: "not_needed" };
  }
  if (state.validationSatisfied && state.reviewSatisfied) {
    return {
      action: "complete",
      validationStatus: "passed",
      statusNote: "Strict completion policy: current-frontier validation passed and the completion candidate was approved."
    };
  }
  const basisDigest = strictBasisDigest(session, state);
  const missing = strictMissing(state);
  const findings = strictFindings(state);
  if (!hasAdvisory(session, basisDigest)) {
    return advisory(
      basisDigest,
      `Strict completion requirements are not yet satisfied: ${missing.join("; ")}.${findings} `
        + "Address the evidence or findings and then stop naturally again. All permitted safety and development tools remain available."
    );
  }
  return {
    action: "fail",
    code: "strict_policy_failure",
    message: `Strict completion policy remained unsatisfied after an unchanged second stop: ${missing.join("; ")}.${findings}`
  };
}

export function completionGateDecision(session: RuntimeSession): CompletionGateDecision {
  const invariant = hardInvariantMessage(session);
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
      `${invariant} This is a deterministic safety/transaction invariant; all tools needed to settle it remain available.`
    );
  }
  return reviewMode(session) === "required"
    ? strictDecision(session)
    : standardDecision(session);
}

function commonTerminalFailure(
  session: RuntimeSession,
  call: ModelToolCall,
  startedAt: string
): ToolReceipt | null {
  if (session.durable.state.activeProcessIds.length > 0) {
    return failed(
      call,
      startedAt,
      `Terminal outcome is blocked while background processes remain active: ${session.durable.state.activeProcessIds.join(", ")}.`,
      "active_processes"
    );
  }
  if (session.durable.state.checkpointHead?.status === "open"
    || session.recovery.openCheckpointRecovery) {
    return failed(
      call,
      startedAt,
      "Terminal outcome is blocked until the open mutation checkpoint is restored or kept.",
      "checkpoint_recovery_required"
    );
  }
  if (unresolvedRepositoryTransactions(session).length > 0) {
    return failed(
      call,
      startedAt,
      "Terminal outcome is blocked until the open repository transaction is continued or aborted.",
      "repository_transaction_open"
    );
  }
  return null;
}

/**
 * Explicit terminal tools are checked only against hard lifecycle invariants.
 * Validation, review, recovery, and plan semantics remain model-owned.
 */
export function completionFailure(
  session: RuntimeSession,
  call: ModelToolCall,
  descriptor: ToolDescriptor,
  startedAt: string
): ToolReceipt | null {
  const terminal = descriptor.possibleEffects.includes("outcome.propose")
    || descriptor.possibleEffects.includes("outcome.report_blocked");
  if (!terminal) return null;
  if (descriptor.possibleEffects.includes("outcome.propose")) {
    return failed(
      call,
      startedAt,
      "Natural model stop is the completion protocol; no completion tool is registered in V6.",
      "internal_tool_denied"
    );
  }
  return commonTerminalFailure(session, call, startedAt);
}
