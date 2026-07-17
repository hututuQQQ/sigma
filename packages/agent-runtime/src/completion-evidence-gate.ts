import {
  isCompletionEligibleEvidence,
  isCompletionReferenceableEvidence,
  type EvidenceRecord,
  type ModelToolCall,
  type PlanGraph,
  type ToolDescriptor,
  type ToolReceipt
} from "agent-protocol";
import { parseCompletionProposal } from "agent-tools";
import { currentFrontierReview, frontierValidationReadiness } from "./mutation-evidence.js";
import { failed } from "./tool-receipt.js";
import type { RuntimeSession } from "./types.js";

export function currentRunEvidence(session: RuntimeSession): EvidenceRecord[] {
  return session.durable.state.evidence.filter((item) =>
    isCompletionReferenceableEvidence(item, session.identity.sessionId, session.durable.runId));
}

function reviewMode(session: RuntimeSession): "off" | "advisory" | "required" {
  return session.services.profile?.profile.mutationPolicy.reviewMode ?? "advisory";
}

function unresolvedGoalInputPaths(session: RuntimeSession): string[] {
  const latest = new Map<string, Extract<EvidenceRecord, { kind: "input_access" }>>();
  for (const evidence of session.durable.state.evidence) {
    if (evidence.kind === "input_access" && evidence.runId === session.durable.runId
      && evidence.data.scope === "external") latest.set(evidence.data.path, evidence);
  }
  const goal = session.durable.state.plan.goal;
  return [...latest.values()].filter((evidence) => evidence.status === "failed"
    && goal.includes(evidence.data.path)).map((evidence) => evidence.data.path);
}

function commonTerminalFailure(
  session: RuntimeSession,
  call: ModelToolCall,
  startedAt: string
): ToolReceipt | null {
  if (session.durable.state.activeProcessIds.length > 0) {
    const deliverable = session.durable.state.activeProcessIds.filter((id) =>
      session.execution.processHandles.get(id)?.lifecycle === "deliverable");
    const sessionLocal = session.durable.state.activeProcessIds.filter((id) => !deliverable.includes(id));
    return failed(call, startedAt,
      `Terminal outcome is blocked while background processes remain active. `
        + `${deliverable.length > 0 ? `Hand off verified deliverable processes: ${deliverable.join(", ")}. ` : ""}`
        + `${sessionLocal.length > 0 ? `Terminate session processes: ${sessionLocal.join(", ")}.` : ""}`,
      "active_processes", {
        status: "rejected", code: "active_processes",
        deliverableProcessIds: deliverable,
        sessionProcessIds: sessionLocal,
        nextActions: [
          ...(deliverable.length > 0 ? [{ tool: "process_handoff", processIds: deliverable }] : []),
          ...(sessionLocal.length > 0 ? [{ tool: "process_terminate", processIds: sessionLocal }] : [])
        ]
      });
  }
  if (session.durable.state.checkpointHead?.status === "open" || session.recovery.openCheckpointRecovery) {
    return failed(call, startedAt,
      "Terminal outcome is blocked until the open mutation checkpoint is restored or kept.",
      "checkpoint_recovery_required");
  }
  return null;
}

export function completionFailure(
  session: RuntimeSession,
  call: ModelToolCall,
  descriptor: ToolDescriptor,
  startedAt: string
): ToolReceipt | null {
  const terminal = descriptor.possibleEffects.includes("outcome.propose")
    || descriptor.possibleEffects.includes("outcome.report_blocked");
  if (!terminal) return null;
  const common = commonTerminalFailure(session, call, startedAt);
  if (common) return common;
  if (!descriptor.possibleEffects.includes("outcome.propose")) return null;
  if (!parseCompletionProposal(call.arguments)) {
    return failed(call, startedAt, "Completion proposal does not match the V4 schema.", "invalid_completion_proposal", {
      status: "rejected", code: "invalid_completion_proposal"
    });
  }
  const unresolvedInputs = unresolvedGoalInputPaths(session);
  if (unresolvedInputs.length > 0) {
    return failed(call, startedAt,
      `Completion is blocked because required external inputs were not read: ${unresolvedInputs.join(", ")}. `
        + "A run-created substitute does not satisfy the original input obligation.",
      "input_access_unresolved", {
        status: "rejected", code: "input_access_unresolved", paths: unresolvedInputs,
        nextActions: [
          { tool: "read", paths: unresolvedInputs },
          { tool: "request_user_input", when: "the input location or substitution requires a user decision" },
          { tool: "report_blocked", when: "the declared inputs remain inaccessible" }
        ]
      });
  }
  const frontier = session.durable.state.mutationFrontier;
  if (frontier.changedPaths.length === 0) return null;
  return validationOrReviewFailure(session, call, startedAt);
}

function validationOrReviewFailure(
  session: RuntimeSession,
  call: ModelToolCall,
  startedAt: string
): ToolReceipt | null {
  const frontier = session.durable.state.mutationFrontier;
  const validation = frontierValidationReadiness(session);
  if (!validation.ready) {
    return failed(call, startedAt,
      validation.latestFailed
        ? `Current-state semantic validation failed; repair and validate again, or use report_blocked. Missing coverage: ${validation.missingPaths.join(", ")}.`
        : `Current-state semantic validation is required for: ${validation.missingPaths.join(", ")}.`,
      validation.latestFailed ? "validation_failed" : "validation_evidence_required",
      {
        status: "rejected",
        code: validation.latestFailed ? "validation_failed" : "validation_evidence_required",
        frontierRevision: frontier.revision,
        stateDigest: frontier.currentStateDigest,
        missingPaths: validation.missingPaths,
        nextActions: validation.latestFailed
          ? [{ tool: "report_blocked", when: "repair is exhausted" }, { tool: "validate", after: "repair" }]
          : [{ tool: "validate", deriveCoverageFrom: ["cwd", "readRoots"] }]
      }
    );
  }
  return requiredReviewFailure(session, call, startedAt);
}

function requiredReviewFailure(
  session: RuntimeSession,
  call: ModelToolCall,
  startedAt: string
): ToolReceipt | null {
  if (reviewMode(session) !== "required") return null;
  const frontier = session.durable.state.mutationFrontier;
  const review = currentFrontierReview(session);
  if (review?.status === "passed" && review.data.verdict === "approved") return null;
  return failed(call, startedAt,
    review
      ? `Strict review requested changes: ${review.data.findings.slice(0, 20).map(String).join("; ")}.`
      : "Strict profile requires an approved review of the validated current state.",
    "review_evidence_required",
    {
      status: "rejected", code: "review_evidence_required",
      frontierRevision: frontier.revision,
      stateDigest: frontier.currentStateDigest,
      nextActions: review ? [{ action: "address_review_findings" }] : [{ tool: "request_review", arguments: {} }]
    }
  );
}

export function completionPlan(session: RuntimeSession): PlanGraph | null {
  const pending = session.durable.state.plan.nodes.filter((node) =>
    node.status !== "completed" && node.status !== "cancelled");
  if (pending.length !== 1 || pending[0]?.id !== "root" || pending[0].status !== "in_progress") return null;
  const evidence = currentRunEvidence(session).map((item) => ({
    evidenceId: item.evidenceId,
    kind: item.kind,
    claim: isCompletionEligibleEvidence(item, session.identity.sessionId, session.durable.runId)
      ? "acceptance_met" as const : "validation_executed" as const
  }));
  return {
    ...session.durable.state.plan,
    revision: session.durable.state.plan.revision + 1,
    activeNodeId: undefined,
    nodes: session.durable.state.plan.nodes.map((node) => node.id === "root"
      ? { ...node, status: "completed" as const, evidence }
      : node)
  };
}

export function completionPlanError(
  session: RuntimeSession,
  call: ModelToolCall,
  startedAt: string
): ToolReceipt | null {
  const incomplete = session.durable.state.plan.nodes.filter((node) =>
    node.status !== "completed" && node.status !== "cancelled");
  return incomplete.length === 0 ? null : failed(call, startedAt,
    `Completion is blocked by unfinished plan nodes: ${incomplete.map((node) => `${node.id}:${node.status}`).join(", ")}.`,
    "plan_incomplete");
}
