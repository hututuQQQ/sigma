import type {
  BudgetAmounts,
  JsonValue
} from "agent-protocol";
import type { RuntimeSession } from "./types.js";
import type { RuntimeControlService } from "./runtime-control.js";
import type { RuntimeEventEmitter } from "./runtime-event-emitter.js";

type ChildEventType = "child.spawned" | "child.message" | "child.completed";
function object(value: unknown): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, JsonValue> : {};
}

function strings(value: JsonValue | undefined): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function consumed(detail: Record<string, JsonValue>): Partial<BudgetAmounts> {
  const report = object(detail.report);
  const raw = object(report.budgetConsumed);
  return Object.fromEntries(Object.entries(raw).filter((entry): entry is [string, number] =>
    Number.isSafeInteger(entry[1]) && Number(entry[1]) >= 0)) as Partial<BudgetAmounts>;
}

function childOutcome(detail: Record<string, JsonValue>): "completed" | "failed" | "cancelled" | "blocked" {
  const status = detail.status;
  if (status === "completed") return "completed";
  if (status === "cancelled") return "cancelled";
  const kind = object(detail.outcome).kind;
  return kind === "needs_input" ? "blocked" : "failed";
}

export function childOutcomeEvidenceId(runId: string, childId: string): string {
  return `child-terminal:${runId}:${childId}`;
}

export async function finalizeChildCompletion(
  session: RuntimeSession,
  payload: JsonValue,
  control: RuntimeControlService,
  emit: RuntimeEventEmitter
): Promise<void> {
  const envelope = object(payload);
  const childId = typeof envelope.childId === "string" ? envelope.childId : "";
  if (!childId) return;
  const detail = object(envelope.payload);
  await control.settleChildBudget(session, childId, consumed(detail));
  const metadata = object(detail.metadata);
  const planNodeIds = strings(metadata.planNodeIds);
  const outcome = childOutcome(detail);
  const recoveryReason = typeof detail.error === "string" && detail.error ? detail.error : undefined;
  const evidenceId = childOutcomeEvidenceId(session.runId, childId);
  let evidence = session.state.evidence.find((item) => item.evidenceId === evidenceId);
  if (!evidence) {
    evidence = {
      evidenceId,
      sessionId: session.sessionId,
      runId: session.runId,
      kind: "child_outcome",
      status: outcome === "completed" ? "passed" : "failed",
      createdAt: new Date().toISOString(),
      producer: { authority: "runtime", id: childId },
      summary: `Child '${childId}' ${outcome}${recoveryReason ? `: ${recoveryReason}` : ""}.`,
      data: { childId, outcome, planNodeIds, ...(recoveryReason ? { recoveryReason } : {}) }
    };
    await emit(session, "evidence.recorded", "runtime", evidence);
  }
  if (evidence.kind !== "child_outcome") {
    throw new Error(`Child outcome evidence id '${evidenceId}' is already used by '${evidence.kind}'.`);
  }
  if (planNodeIds.length === 0) return;
  await control.updatePlanFromChildOutcome(session, {
    childId,
    planNodeIds,
    outcome,
    evidence: { evidenceId: evidence.evidenceId, kind: evidence.kind }
  });
}

export async function handleChildEvent(
  session: RuntimeSession,
  type: ChildEventType,
  payload: JsonValue,
  control: RuntimeControlService,
  emit: RuntimeEventEmitter
): Promise<void> {
  const envelope = object(payload);
  await emit(session, type, "runtime", envelope);
  if (type !== "child.completed") return;
  await finalizeChildCompletion(session, envelope, control, emit);
}
