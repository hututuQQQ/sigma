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

export function childOutcomeEvidence(
  session: RuntimeSession,
  value: JsonValue,
  index: number
): EvidenceRecord {
  const detail = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : {};
  const childId = typeof detail.childId === "string" ? detail.childId : `joined-child-${index + 1}`;
  return {
    evidenceId: `child:${session.durable.runId}:${childId}`,
    sessionId: session.identity.sessionId,
    runId: session.durable.runId,
    kind: "child_outcome",
    status: "passed",
    createdAt: new Date().toISOString(),
    producer: { authority: "runtime", id: "child-supervisor" },
    summary: `Child '${childId}' completed and was joined into this run.`,
    data: { childId, outcome: "completed", planNodeIds: [] }
  };
}

export function mutatingPlan(plan: ToolCallPlan): boolean {
  return plan.exactEffects.some((effect) =>
    ["filesystem.write", "process.spawn", "destructive", "open_world"].includes(effect));
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
