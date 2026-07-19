import { createHash } from "node:crypto";
import type {
  CompletionLimitationV1,
  EvidenceRecord,
  JsonValue,
  ModelToolCall,
  ToolCallPlan,
  ValidationEvidence
} from "agent-protocol";
import type { ActiveModelTurn, KernelEffect } from "agent-kernel";
import type {
  ChildLimitationEvidenceSource,
  RuntimeSession
} from "./types.js";

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

function limitationKey(limitation: CompletionLimitationV1): string {
  return JSON.stringify([
    limitation.kind,
    limitation.claim,
    limitation.attemptedCommandSummary,
    limitation.capabilityEvidenceId,
    limitation.reason
  ]);
}

function importedEvidenceId(
  session: RuntimeSession,
  source: ChildLimitationEvidenceSource
): string {
  const digest = createHash("sha256").update(JSON.stringify([
    source.childId,
    source.evidence.sessionId,
    source.evidence.runId,
    source.evidence.evidenceId
  ])).digest("hex");
  return `child-capability:${session.durable.runId}:${digest}`;
}

export interface ImportedChildLimitationsV1 {
  evidence: ValidationEvidence[];
  limitations: CompletionLimitationV1[];
}

/** Maps child-owned validation records to parent-owned proxy evidence and
 * rewrites every limitation reference. Missing, extra, or mismatched sources
 * fail closed so a parent outcome can never contain a dangling evidence ID. */
export function importedChildLimitations(
  session: RuntimeSession,
  limitations: readonly CompletionLimitationV1[],
  sources: readonly ChildLimitationEvidenceSource[]
): ImportedChildLimitationsV1 | null {
  if (limitations.length !== sources.length) return null;
  const remaining = [...sources];
  const evidence = new Map<string, ValidationEvidence>();
  const remapped: CompletionLimitationV1[] = [];
  for (const limitation of limitations) {
    const index = remaining.findIndex((source) => limitationKey(source.limitation) === limitationKey(limitation));
    if (index < 0) return null;
    const source = remaining.splice(index, 1)[0]!;
    if (source.evidence.evidenceId !== limitation.capabilityEvidenceId) return null;
    const evidenceId = importedEvidenceId(session, source);
    if (!evidence.has(evidenceId)) {
      evidence.set(evidenceId, {
        ...source.evidence,
        evidenceId,
        sessionId: session.identity.sessionId,
        runId: session.durable.runId,
        createdAt: new Date().toISOString(),
        producer: { authority: "runtime", id: "child-supervisor" },
        summary: `Child '${source.childId}' validation capability was imported for parent completion.`,
        data: {
          ...source.evidence.data,
          sourceSessionId: source.evidence.sessionId,
          childId: source.childId
        }
      });
    }
    remapped.push({ ...limitation, capabilityEvidenceId: evidenceId });
  }
  return { evidence: [...evidence.values()], limitations: remapped };
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
