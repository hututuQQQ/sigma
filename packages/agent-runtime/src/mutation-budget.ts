import type { BudgetReservation, ValidationEvidence, WorkspaceDeltaEvidence } from "agent-protocol";
import type { BudgetController } from "./budget-controller.js";
import { sessionMutationEvidence } from "./mutation-evidence.js";
import type { RuntimeSession } from "./types.js";
import { validationExecutionCoversDelta } from "./validation-policy.js";

const PREFIX = "mutation-tool:";

export interface MutationBudgetOwner {
  callId: string;
  checkpointId: string;
}

export function mutationBudgetOwner(callId: string, checkpointId: string): string {
  return `${PREFIX}${Buffer.from(JSON.stringify({ callId, checkpointId }), "utf8").toString("base64url")}`;
}

export function parseMutationBudgetOwner(ownerId: string): MutationBudgetOwner | undefined {
  if (!ownerId.startsWith(PREFIX)) return undefined;
  try {
    const value = JSON.parse(Buffer.from(ownerId.slice(PREFIX.length), "base64url").toString("utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const item = value as Record<string, unknown>;
    return typeof item.callId === "string" && item.callId && typeof item.checkpointId === "string" && item.checkpointId
      ? { callId: item.callId, checkpointId: item.checkpointId } : undefined;
  } catch {
    return undefined;
  }
}

export async function settleEligibleToolBudgets(
  session: RuntimeSession,
  budgets: BudgetController
): Promise<void> {
  const active = session.durable.state.budget.reservations.filter((item) => item.status === "reserved");
  for (const reservation of active) {
    const mutation = parseMutationBudgetOwner(reservation.ownerId);
    if (mutation ? mutationReservationSatisfied(session, reservation, mutation) : toolReceiptExists(session, reservation)) {
      await budgets.commitIfReserved(session, reservation.reservationId, {
        toolCalls: Math.min(1, reservation.requested.toolCalls)
      });
    }
  }
}

export function mutationReservationHasDelta(
  session: RuntimeSession,
  mutation: MutationBudgetOwner
): boolean {
  return mutationDeltas(session, mutation.checkpointId).length > 0;
}

function mutationReservationSatisfied(
  session: RuntimeSession,
  _reservation: BudgetReservation,
  mutation: MutationBudgetOwner
): boolean {
  const deltas = mutationDeltas(session, mutation.checkpointId);
  if (deltas.length === 0) {
    return session.recovery.openCheckpointRecovery?.checkpointId !== mutation.checkpointId
      && session.durable.state.receipts.some((item) => item.callId === mutation.callId);
  }
  const evidence = sessionMutationEvidence(session);
  const validations = evidence.filter((item): item is ValidationEvidence =>
    item.kind === "validation");
  if (deltas.some((delta) => !validations.some((item) => validationExecutionCoversDelta(item, delta)))) return false;
  return true;
}

function mutationDeltas(session: RuntimeSession, checkpointId: string): WorkspaceDeltaEvidence[] {
  return sessionMutationEvidence(session).filter((item): item is WorkspaceDeltaEvidence =>
    item.kind === "workspace_delta" && item.status === "passed" && item.data.checkpointId === checkpointId);
}

function toolReceiptExists(session: RuntimeSession, reservation: BudgetReservation): boolean {
  if (!reservation.ownerId.startsWith("tool:")) return false;
  return session.durable.state.receipts.some((item) => `tool:${item.callId}` === reservation.ownerId);
}
