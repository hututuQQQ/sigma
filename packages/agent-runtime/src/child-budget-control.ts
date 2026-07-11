import {
  DEFAULT_CHILD_BUDGET_LIMITS,
  type BudgetAmounts,
  type BudgetLimits
} from "agent-protocol";
import type { BudgetController } from "./budget-controller.js";
import type { RuntimeSession } from "./types.js";

export const DEFAULT_CHILD_BUDGET: Readonly<BudgetLimits> = DEFAULT_CHILD_BUDGET_LIMITS;

const BUDGET_KEYS = [
  "inputTokens", "outputTokens", "costMicroUsd", "modelTurns", "toolCalls", "children"
] as const satisfies readonly (keyof BudgetAmounts)[];

function allocation(session: RuntimeSession, requested: Partial<BudgetLimits> = {}): BudgetLimits {
  const value = Object.fromEntries(BUDGET_KEYS.map((key) => {
    const remaining = Math.max(0, session.state.budget.limits[key]
      - session.state.budget.consumed[key] - session.state.budget.reserved[key]);
    const defaultMaximum = key === "children" ? Math.max(0, remaining - 1) : remaining;
    const amount = requested[key] ?? Math.min(DEFAULT_CHILD_BUDGET[key], defaultMaximum);
    if (!Number.isSafeInteger(amount) || amount < 0) {
      throw new Error(`Child budget '${key}' must be a non-negative integer.`);
    }
    return [key, amount];
  })) as unknown as Omit<BudgetLimits, "maxDepth">;
  const availableDepth = Math.max(0, session.state.budget.limits.maxDepth - 1);
  const maxDepth = requested.maxDepth ?? Math.min(DEFAULT_CHILD_BUDGET.maxDepth, availableDepth);
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 0 || maxDepth > availableDepth) {
    throw new Error(`Child maxDepth must be between 0 and ${availableDepth}.`);
  }
  return { ...value, maxDepth };
}

export class ChildBudgetControl {
  constructor(private readonly budgets: BudgetController) {}

  async reserve(
    session: RuntimeSession,
    childId: string,
    requested?: Partial<BudgetLimits>
  ): Promise<BudgetLimits> {
    return await this.budgets.reserveChild(session, `child:${childId}`, () => {
      const child = allocation(session, requested);
      return {
        requested: {
          inputTokens: child.inputTokens,
          outputTokens: child.outputTokens,
          costMicroUsd: child.costMicroUsd,
          modelTurns: child.modelTurns,
          toolCalls: child.toolCalls,
          children: child.children + 1
        },
        result: child
      };
    });
  }

  async settle(
    session: RuntimeSession,
    childId: string,
    reported: Partial<BudgetAmounts> = {}
  ): Promise<void> {
    const reservation = session.state.budget.reservations.find((item) =>
      item.ownerId === `child:${childId}` && item.status === "reserved");
    if (!reservation) return;
    const consumed = Object.fromEntries(BUDGET_KEYS.map((key) => {
      const raw = reported[key] ?? 0;
      const amount = key === "children" ? raw + 1 : raw;
      return [key, Math.min(reservation.requested[key], Math.max(0, Number.isSafeInteger(amount) ? amount : 0))];
    })) as unknown as BudgetAmounts;
    await this.budgets.commit(session, reservation.reservationId, consumed);
  }

  async release(session: RuntimeSession, childId: string): Promise<void> {
    const reservation = session.state.budget.reservations.find((item) =>
      item.ownerId === `child:${childId}` && item.status === "reserved");
    if (reservation) await this.budgets.release(session, reservation.reservationId);
  }
}
