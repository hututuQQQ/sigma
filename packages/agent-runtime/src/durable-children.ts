import {
  isBudgetLedgerState,
  isEvidenceRecord,
  type AgentEventEnvelope,
  type BudgetAmounts,
  type BudgetLedgerState,
  type CompletionLimitationV1,
  type JsonValue,
  type RunOutcome,
  type RunStore,
  type ValidationEvidence
} from "agent-protocol";
import { finalizeChildCompletion, handleChildEvent } from "./child-event-handler.js";
import type { RuntimeControlService } from "./runtime-control.js";
import type {
  ChildJoinSummary,
  ChildLimitationEvidenceSource,
  RuntimeSession
} from "./types.js";

export interface DurableChild {
  childId: string;
  detached: boolean;
  metadata: Record<string, JsonValue>;
  childSessionId?: string;
  completed?: Record<string, JsonValue>;
  integrated: boolean;
  outcomeRecorded: boolean;
}

const BUDGET_KEYS = [
  "inputTokens", "outputTokens", "costMicroUsd", "modelTurns", "toolCalls", "children"
] as const satisfies readonly (keyof BudgetAmounts)[];

function record(value: unknown): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, JsonValue> : {};
}

function childEvent(event: AgentEventEnvelope): { childId: string; detail: Record<string, JsonValue> } | null {
  if (!event.type.startsWith("child.")) return null;
  const outer = record(event.payload);
  if (typeof outer.childId !== "string") return null;
  return { childId: outer.childId, detail: record(outer.payload ?? null) };
}

export async function readDurableChildren(store: RunStore, parentSessionId: string): Promise<Map<string, DurableChild>> {
  const children = new Map<string, DurableChild>();
  for await (const event of store.events(parentSessionId)) {
    const recordedChildId = childOutcomeRecorded(event);
    if (recordedChildId) {
      const child = children.get(recordedChildId);
      if (child) child.outcomeRecorded = true;
      continue;
    }
    const parsed = childEvent(event);
    if (!parsed) continue;
    if (event.type === "child.spawned") {
      children.set(parsed.childId, {
        childId: parsed.childId,
        detached: parsed.detail.detached === true,
        metadata: record(parsed.detail.metadata ?? null),
        integrated: false,
        outcomeRecorded: false
      });
      continue;
    }
    const child = children.get(parsed.childId);
    if (!child) continue;
    if (event.type === "child.completed") child.completed = parsed.detail;
    if (event.type === "child.message" && parsed.detail.kind === "integrated") child.integrated = true;
    if (event.type === "child.message" && parsed.detail.kind === "started"
      && typeof parsed.detail.sessionId === "string") child.childSessionId = parsed.detail.sessionId;
  }
  return children;
}

function childOutcomeRecorded(event: AgentEventEnvelope): string | null {
  if (event.type !== "evidence.recorded") return null;
  const evidence = record(event.payload);
  if (evidence.kind !== "child_outcome") return null;
  const childId = record(evidence.data).childId;
  return typeof childId === "string" && childId ? childId : null;
}

function failure(child: DurableChild): string | null {
  if (!child.completed) return `Child ${child.childId} was interrupted before a durable terminal outcome; spawn a replacement or resolve it explicitly.`;
  const status = typeof child.completed.status === "string" ? child.completed.status : "unknown";
  if (status !== "completed") return `Child ${child.childId} ended as ${status}.`;
  const outcome = record(child.completed.outcome ?? null);
  if (outcome.kind === "completed_with_limitations") {
    const declared = Array.isArray(outcome.limitations) ? outcome.limitations : [];
    if (declared.length === 0 || childLimitations(child).length !== declared.length
      || childLimitationEvidence(child).length !== declared.length) {
      return `Child ${child.childId} reported malformed completion limitations.`;
    }
  }
  const isolation = record(child.completed.isolation ?? null);
  if (isolation.kind === "git_worktree" && isolation.cleanup === "retained" && !child.integrated) {
    return `Child ${child.childId} has an unintegrated worktree at ${String(isolation.worktreePath ?? "unknown")}.`;
  }
  return null;
}

const VALIDATION_CLAIMS = new Set([
  "probe", "syntax", "typecheck", "lint", "unit", "integration", "acceptance"
]);

function completionLimitation(value: JsonValue): CompletionLimitationV1 | null {
  const item = record(value);
  return item.kind === "validation_capability_unavailable"
    && typeof item.claim === "string" && VALIDATION_CLAIMS.has(item.claim)
    && typeof item.attemptedCommandSummary === "string" && item.attemptedCommandSummary.length > 0
    && typeof item.capabilityEvidenceId === "string" && item.capabilityEvidenceId.length > 0
    && typeof item.reason === "string" && item.reason.length > 0
    ? item as CompletionLimitationV1 : null;
}

function childLimitations(child: DurableChild): CompletionLimitationV1[] {
  const outcome = record(child.completed?.outcome ?? null);
  if (outcome.kind !== "completed_with_limitations" || !Array.isArray(outcome.limitations)) return [];
  return outcome.limitations.flatMap((value) => {
    const limitation = completionLimitation(value);
    return limitation ? [limitation] : [];
  });
}

function validationWithId(value: JsonValue, evidenceId: string): value is ValidationEvidence {
  return isEvidenceRecord(value) && value.kind === "validation" && value.evidenceId === evidenceId;
}

function limitationMatchesValidation(
  candidate: ValidationEvidence,
  limitation: CompletionLimitationV1
): boolean {
  const claim = candidate.data.claim;
  const compatibleClaim = claim?.kind === limitation.claim
    || (claim?.kind === "integration" && limitation.claim === "unit");
  return candidate.status === "failed"
    && claim?.status === "unavailable"
    && compatibleClaim
    && candidate.data.termination?.processStarted === false
    && typeof candidate.data.command === "string"
    && candidate.data.command.trim().length > 0;
}

function sourceValidation(
  outcome: Record<string, JsonValue>,
  limitation: CompletionLimitationV1
): ValidationEvidence | null {
  if (!Array.isArray(outcome.evidence)) return null;
  const candidate = outcome.evidence.find((value) =>
    validationWithId(value, limitation.capabilityEvidenceId));
  return candidate && validationWithId(candidate, limitation.capabilityEvidenceId)
    && limitationMatchesValidation(candidate, limitation) ? candidate : null;
}

export function childLimitationEvidenceSources(
  childId: string,
  outcomeValue: JsonValue
): ChildLimitationEvidenceSource[] {
  const outcome = record(outcomeValue);
  if (outcome.kind !== "completed_with_limitations") return [];
  const limitations = Array.isArray(outcome.limitations) ? outcome.limitations.flatMap((value) => {
    const limitation = completionLimitation(value);
    return limitation ? [limitation] : [];
  }) : [];
  return limitations.flatMap((limitation) => {
    const evidence = sourceValidation(outcome, limitation);
    return evidence ? [{ childId, limitation, evidence }] : [];
  });
}

function childLimitationEvidence(child: DurableChild): ChildLimitationEvidenceSource[] {
  return childLimitationEvidenceSources(child.childId, child.completed?.outcome ?? null);
}

export async function auditDurableChildren(
  store: RunStore,
  parentSessionId: string,
  excludeIds: ReadonlySet<string> = new Set()
): Promise<ChildJoinSummary> {
  const children = await readDurableChildren(store, parentSessionId);
  const joined = [...children.values()].filter((child) => !child.detached && !excludeIds.has(child.childId));
  return {
    evidence: joined.map((child) => ({
      childId: child.childId,
      status: child.completed?.status ?? "interrupted",
      isolation: child.completed?.isolation ?? null,
      integrated: child.integrated
    })),
    failures: joined.flatMap((child) => {
      const value = failure(child);
      return value ? [value] : [];
    }),
    limitations: joined.flatMap(childLimitations),
    limitationEvidence: joined.flatMap(childLimitationEvidence)
  };
}

interface ChildLedgerSnapshot {
  seen: boolean;
  ledger?: BudgetLedgerState;
  terminal?: { status: "completed" | "failed" | "cancelled"; outcome: RunOutcome };
}

function eventOutcome(event: AgentEventEnvelope): ChildLedgerSnapshot["terminal"] {
  if (!["run.completed", "run.failed", "run.cancelled"].includes(event.type)) return undefined;
  const value = record(event.payload);
  if (event.type === "run.completed") {
    const kind = value.kind === "completed_with_limitations" ? "completed_with_limitations" : "completed";
    return { status: "completed", outcome: { ...value, kind } as RunOutcome };
  }
  if (event.type === "run.cancelled") {
    return {
      status: "cancelled",
      outcome: { kind: "cancelled", reason: typeof value.reason === "string" ? value.reason : "Child was cancelled." }
    };
  }
  return {
    status: "failed",
    outcome: {
      kind: "recoverable_failure",
      code: typeof value.code === "string" ? value.code : "child_failed",
      message: typeof value.message === "string" ? value.message : "Child run failed."
    }
  };
}

async function childLedger(store: RunStore, sessionId: string): Promise<ChildLedgerSnapshot> {
  const result: ChildLedgerSnapshot = { seen: false };
  for await (const event of store.events(sessionId)) {
    result.seen = true;
    if (event.type === "run.started") result.terminal = undefined;
    const terminal = eventOutcome(event);
    if (terminal) result.terminal = terminal;
    if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) continue;
    const ledger = (event.payload as Record<string, unknown>).ledger;
    if (isBudgetLedgerState(ledger)) result.ledger = ledger;
  }
  return result;
}

function conservativeUsage(ledger: BudgetLedgerState | undefined): Partial<BudgetAmounts> {
  if (!ledger) return {};
  return Object.fromEntries(BUDGET_KEYS.map((key) => [key, ledger.consumed[key] + ledger.reserved[key]]));
}

function ownedPlanNodes(session: RuntimeSession, childId: string): string[] {
  return session.durable.state.plan.nodes.flatMap((node) =>
    node.owner.kind === "child" && node.owner.childId === childId ? [node.id] : []);
}

function childReservationId(ownerId: string): string | null {
  return ownerId.startsWith("child:") && ownerId.length > "child:".length
    ? ownerId.slice("child:".length) : null;
}

function recordedOutcomeChildIds(session: RuntimeSession): Set<string> {
  return new Set(session.durable.state.evidence.flatMap((item) => item.kind === "child_outcome"
    && typeof item.data.childId === "string" ? [item.data.childId] : []));
}

async function reconcileOrphanChildReservations(
  children: ReadonlyMap<string, DurableChild>,
  session: RuntimeSession,
  control: RuntimeControlService,
  emit: Parameters<typeof handleChildEvent>[4]
): Promise<number> {
  const childIds = new Set([
    ...session.durable.state.budget.reservations.flatMap((item) => {
      const childId = childReservationId(item.ownerId);
      return childId ? [childId] : [];
    }),
    ...session.durable.state.plan.nodes.flatMap((node) => node.owner.kind === "child" ? [node.owner.childId] : [])
  ]);
  const recorded = recordedOutcomeChildIds(session);
  let reconciled = 0;
  for (const childId of childIds) {
    if (children.has(childId)) continue;
    const planNodeIds = ownedPlanNodes(session, childId);
    const reservation = session.durable.state.budget.reservations.find((item) =>
      item.ownerId === `child:${childId}` && item.status === "reserved");
    if (!reservation && planNodeIds.length === 0 && recorded.has(childId)) continue;
    // No durable spawn exists, so no child could legitimately consume this
    // allocation. Release it instead of charging a synthetic child attempt.
    await control.releaseChildBudget(session, childId);
    const completion = {
      childId,
      payload: {
        status: "failed",
        outcome: {
          kind: "recoverable_failure",
          code: "orphan_child_reservation",
          message: "The runtime stopped before child.spawned became durable; the child was never launched."
        },
        report: { budgetConsumed: {}, recovery: "orphan_spawn_rollback" },
        metadata: { planNodeIds },
        isolation: null,
        error: "Recovered an unregistered child allocation without replaying the spawn."
      }
    };
    if (recorded.has(childId)) {
      await finalizeChildCompletion(session, completion, control, emit);
    } else {
      await handleChildEvent(session, "child.completed", completion, control, emit);
    }
    reconciled += 1;
  }
  return reconciled;
}

/**
 * Closes children that existed durably before a runtime restart. It never
 * starts or resumes a child. Unknown in-flight usage is charged from the
 * child's own durable ledger; if that ledger is unreadable, the full parent
 * reservation is consumed so recovery cannot create budget out of thin air.
 */
export async function reconcileInterruptedChildren(
  store: RunStore,
  session: RuntimeSession,
  control: RuntimeControlService,
  emit: Parameters<typeof handleChildEvent>[4]
): Promise<number> {
  const children = await readDurableChildren(store, session.identity.sessionId);
  let reconciled = await reconcileOrphanChildReservations(children, session, control, emit);
  for (const child of children.values()) {
    const reservation = session.durable.state.budget.reservations.find((item) =>
      item.ownerId === `child:${child.childId}` && item.status === "reserved");
    const planNodeIds = ownedPlanNodes(session, child.childId);
    if (child.completed) {
      if (!reservation && planNodeIds.length === 0 && child.outcomeRecorded) continue;
      await finalizeChildCompletion(session, {
        childId: child.childId,
        payload: child.completed
      }, control, emit);
      reconciled += 1;
      continue;
    }
    let snapshot: ChildLedgerSnapshot = { seen: false };
    if (child.childSessionId) {
      try {
        snapshot = await childLedger(store, child.childSessionId);
      } catch {
        snapshot = { seen: false };
      }
    }
    const usage = snapshot.ledger
      ? conservativeUsage(snapshot.ledger)
      : child.childSessionId && reservation
        ? Object.fromEntries(BUDGET_KEYS.map((key) => [
          key,
          key === "children" ? Math.max(0, reservation.requested.children - 1) : reservation.requested[key]
        ]))
        : {};
    const terminal = snapshot.terminal;
    const outcome: RunOutcome = {
      kind: "recoverable_failure",
      code: "child_interrupted",
      message: terminal
        ? "The child run ended, but its supervisor stopped before publishing a durable completion and workspace-isolation result; the child was not replayed."
        : "The runtime stopped before the child produced a durable terminal outcome; the child was not replayed."
    };
    await handleChildEvent(session, "child.completed", {
      childId: child.childId,
      payload: {
        status: "failed",
        outcome,
        report: {
          sessionId: child.childSessionId ?? null,
          budgetConsumed: usage,
          recovery: "durable_no_replay",
          childTerminal: terminal ? { status: terminal.status, outcome: terminal.outcome } : null
        },
        metadata: { ...child.metadata, planNodeIds },
        isolation: null,
        error: terminal ? null : "Child process state was lost during runtime recovery."
      }
    }, control, emit);
    reconciled += 1;
  }
  return reconciled;
}
