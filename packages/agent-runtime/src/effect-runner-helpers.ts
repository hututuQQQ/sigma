import type {
  EvidenceRecord,
  JsonValue,
  ModelToolCall,
  ToolCallPlan
} from "agent-protocol";
import type { ActiveModelTurn, KernelEffect } from "agent-kernel";
import type { RuntimeSession } from "./types.js";

export type ExecuteToolEffect = Extract<KernelEffect, { type: "execute_tool" }>;

export interface ToolAttempt {
  call: ModelToolCall;
  modelTurn: ActiveModelTurn;
}

function record(value: JsonValue | undefined): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : {};
}

function joinedChildOutcome(
  detail: Record<string, JsonValue>
): "completed" | "failed" | "cancelled" | "blocked" {
  const status = typeof detail.status === "string" ? detail.status : "unknown";
  const outcome = typeof detail.outcome === "string" ? detail.outcome : undefined;
  if (status === "completed" && (outcome === undefined || outcome === "completed")) return "completed";
  if (status === "cancelled" || outcome === "cancelled") return "cancelled";
  if (status === "blocked" || outcome === "needs_input") return "blocked";
  return "failed";
}

export function childOutcomeEvidence(
  session: RuntimeSession,
  value: JsonValue,
  index: number
): EvidenceRecord {
  const detail = record(value);
  const childId = typeof detail.childId === "string" ? detail.childId : `joined-child-${index + 1}`;
  const outcome = joinedChildOutcome(detail);
  const metadata = record(detail.metadata);
  const planNodeIds = Array.isArray(metadata.planNodeIds)
    ? metadata.planNodeIds.filter((item): item is string => typeof item === "string")
    : [];
  const recoveryReason = typeof detail.error === "string" && detail.error
    ? detail.error
    : undefined;
  return {
    evidenceId: `child:${session.durable.runId}:${childId}`,
    sessionId: session.identity.sessionId,
    runId: session.durable.runId,
    kind: "child_outcome",
    status: outcome === "completed" ? "passed" : "failed",
    createdAt: new Date().toISOString(),
    producer: { authority: "runtime", id: "child-supervisor" },
    summary: outcome === "completed"
      ? `Child '${childId}' completed and was joined into this run.`
      : `Child '${childId}' ended as ${outcome} and its terminal evidence was reconciled.`,
    data: { childId, outcome, planNodeIds, ...(recoveryReason ? { recoveryReason } : {}) }
  };
}

export function mutatingPlan(plan: ToolCallPlan): boolean {
  return plan.exactEffects.some((effect) =>
    ["filesystem.write", "repository.write", "process.spawn", "destructive", "open_world"].includes(effect));
}

export function planAllowsMutation(session: RuntimeSession): boolean {
  const active = session.durable.state.plan.nodes.find((node) => node.id === session.durable.state.plan.activeNodeId);
  return Boolean(active && active.owner.kind === "root" && active.status === "in_progress");
}

export function attemptFromEffect(effect: ExecuteToolEffect): ToolAttempt {
  return {
    call: { id: effect.request.callId, name: effect.request.name, arguments: effect.request.arguments },
    modelTurn: effect.modelTurn
  };
}

export function turnPayload(modelTurn: ActiveModelTurn): ActiveModelTurn {
  return { turnId: modelTurn.turnId, effectRevision: modelTurn.effectRevision };
}
