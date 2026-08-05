import {
  type AgentEventEnvelope,
  type BudgetAmounts,
  type BudgetLedgerState,
  type JsonValue,
  type RunOutcome,
  type RunStore
} from "agent-protocol";
import { replayBudgetLedgerEvent } from "agent-kernel";
import { finalizeChildCompletion, handleChildEvent } from "./child-event-handler.js";
import type { RuntimeControlService } from "./runtime-control.js";
import type { ChildJoinSummary, RuntimeSession } from "./types.js";

export interface DurableChild {
  childId: string;
  runId: string;
  detached: boolean;
  metadata: Record<string, JsonValue>;
  childSessionId?: string;
  completed?: Record<string, JsonValue>;
  integrated: boolean;
  outcomeRecorded: boolean;
  planReconciled: boolean;
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

function updatedPlanNodes(event: AgentEventEnvelope): JsonValue[] | undefined {
  if (event.type !== "plan.updated") return undefined;
  const nodes = record(record(event.payload).plan).nodes;
  return Array.isArray(nodes) ? nodes : undefined;
}

function reconciledPlanOwnership(
  child: DurableChild,
  latestPlanNodes: readonly JsonValue[] | undefined
): boolean {
  const planNodeIds = Array.isArray(child.metadata.planNodeIds)
    ? child.metadata.planNodeIds.filter((item): item is string => typeof item === "string")
    : [];
  if (planNodeIds.length === 0) return true;
  if (!latestPlanNodes) return false;
  return planNodeIds.every((id) => !latestPlanNodes.some((value) => {
    const node = record(value);
    const owner = record(node.owner);
    return node.id === id && owner.kind === "child" && owner.childId === child.childId;
  }));
}

function reconcileChildrenPlanOwnership(
  children: ReadonlyMap<string, DurableChild>,
  latestPlanNodes: readonly JsonValue[] | undefined
): void {
  for (const child of children.values()) {
    child.planReconciled = reconciledPlanOwnership(child, latestPlanNodes);
  }
}

export async function readDurableChildren(store: RunStore, parentSessionId: string): Promise<Map<string, DurableChild>> {
  const children = new Map<string, DurableChild>();
  let latestPlanNodes: JsonValue[] | undefined;
  for await (const event of store.events(parentSessionId)) {
    latestPlanNodes = updatedPlanNodes(event) ?? latestPlanNodes;
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
        runId: event.runId,
        detached: parsed.detail.detached === true,
        metadata: record(parsed.detail.metadata ?? null),
        integrated: false,
        outcomeRecorded: false,
        planReconciled: false
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
  reconcileChildrenPlanOwnership(children, latestPlanNodes);
  return children;
}

function childOutcomeRecorded(event: AgentEventEnvelope): string | null {
  if (event.type !== "evidence.recorded") return null;
  const evidence = record(event.payload);
  if (evidence.kind !== "child_outcome") return null;
  const childId = record(evidence.data).childId;
  return typeof childId === "string" && childId ? childId : null;
}

export function durableChildCompletionFailure(child: DurableChild): string | null {
  if (!child.completed) return `Child ${child.childId} was interrupted before a durable terminal outcome; spawn a replacement or resolve it explicitly.`;
  const isolation = record(child.completed.isolation ?? null);
  if (isolation.kind === "git_worktree" && isolation.cleanup === "retained" && !child.integrated) {
    return `Child ${child.childId} has an unintegrated worktree at ${String(isolation.worktreePath ?? "unknown")}.`;
  }
  const status = typeof child.completed.status === "string" ? child.completed.status : "unknown";
  if (status === "completed") return null;
  // Failed delegation is durable evidence, not an irrevocable failure of the
  // parent goal. The child completion handler has already returned its Plan
  // nodes to the parent. Stay conservative when that reconciliation evidence
  // was not recorded, because the parent may still have child-owned work.
  if (!child.outcomeRecorded) {
    return `Child ${child.childId} ended as ${status} before its terminal outcome was durably reconciled.`;
  }
  return child.planReconciled
    ? null
    : `Child ${child.childId} ended as ${status}, but its delegated Plan ownership was not durably returned to the parent.`;
}

export function auditDurableChildRecords(
  children: ReadonlyMap<string, DurableChild>,
  parentRunId: string,
  excludeIds: ReadonlySet<string> = new Set()
): ChildJoinSummary {
  const joined = [...children.values()].filter((child) =>
    child.runId === parentRunId && !child.detached && !excludeIds.has(child.childId)
  );
  return {
    evidence: joined.map((child) => ({
      childId: child.childId,
      status: child.completed?.status ?? "interrupted",
      outcome: record(child.completed?.outcome ?? null).kind ?? null,
      metadata: child.metadata,
      planReconciled: child.planReconciled,
      isolation: child.completed?.isolation ?? null,
      integrated: child.integrated,
      error: child.completed?.error ?? null
    })),
    failures: joined.flatMap((child) => {
      const value = durableChildCompletionFailure(child);
      return value ? [value] : [];
    })
  };
}

export async function auditDurableChildren(
  store: RunStore,
  parentSessionId: string,
  parentRunId: string,
  excludeIds: ReadonlySet<string> = new Set()
): Promise<ChildJoinSummary> {
  return auditDurableChildRecords(
    await readDurableChildren(store, parentSessionId),
    parentRunId,
    excludeIds
  );
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
    return { status: "completed", outcome: { ...value, kind: "completed" } as RunOutcome };
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
    result.ledger = replayBudgetLedgerEvent(result.ledger, event);
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
