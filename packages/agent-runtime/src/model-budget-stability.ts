import type { BudgetAmounts } from "agent-protocol";
import type { DeadlineForecast } from "./convergence-policy.js";
import {
  prepareBudgetedModelTurn,
  requestCapacity,
  type BudgetStage
} from "./model-budget-convergence.js";
import {
  requestedBudgetStage,
  requestedResourceBudgetStage
} from "./model-tool-capabilities.js";

const BUDGET_STAGES: readonly BudgetStage[] = ["normal", "converge", "terminal"];

export function maximumBudgetStage(left: BudgetStage, right: BudgetStage): BudgetStage {
  return BUDGET_STAGES.indexOf(left) >= BUDGET_STAGES.indexOf(right) ? left : right;
}

type PreparedBudgetedTurn = Awaited<ReturnType<typeof prepareBudgetedModelTurn>>;

export interface StableBudgetPreparation {
  prepared: PreparedBudgetedTurn;
  reviewerReserve: BudgetAmounts;
  stage: BudgetStage;
  resourceStage: BudgetStage;
}

/** Re-quote each contracted stage before committing the monotonic resource
 * high-water. If a one-turn budget cannot even prepare the intermediate
 * two-turn converge contract, skip that impossible contract and quote the
 * already-requested terminal stage directly. */
export async function stableBudgetPreparation(
  initial: PreparedBudgetedTurn,
  forecast: DeadlineForecast,
  minimumStage: BudgetStage,
  lengthLimited: boolean,
  prepare: (stage: BudgetStage) => Promise<PreparedBudgetedTurn>,
  quote: (prepared: PreparedBudgetedTurn) => Promise<BudgetAmounts>,
  available: BudgetAmounts
): Promise<StableBudgetPreparation> {
  let prepared = initial;
  let stage = minimumStage;
  let resourceStage = minimumStage;
  for (let index = 0; index < BUDGET_STAGES.length; index += 1) {
    const reviewerReserve = await quote(prepared);
    const rawCapacity = requestCapacity(available, prepared.turn.budget, reviewerReserve);
    const capacity = lengthLimited ? Math.min(rawCapacity, 2) : rawCapacity;
    const resourceRequested = requestedResourceBudgetStage(forecast, capacity);
    const budgetRequested = requestedBudgetStage(forecast, capacity);
    if (BUDGET_STAGES.indexOf(budgetRequested) <= BUDGET_STAGES.indexOf(stage)) {
      return { prepared, reviewerReserve, stage, resourceStage };
    }
    const nextStage = BUDGET_STAGES[BUDGET_STAGES.indexOf(stage) + 1] ?? "terminal";
    const advancesResource = BUDGET_STAGES.indexOf(resourceRequested) > BUDGET_STAGES.indexOf(stage);
    try {
      prepared = await prepare(nextStage);
      if (advancesResource) resourceStage = maximumBudgetStage(resourceStage, nextStage);
      stage = nextStage;
    } catch (error) {
      const code = (error as { code?: unknown })?.code;
      const canSkipImpossibleIntermediate = nextStage === "converge"
        && budgetRequested === "terminal" && code === "budget_exhausted";
      if (!canSkipImpossibleIntermediate) throw error;
      stage = "terminal";
      if (advancesResource) resourceStage = maximumBudgetStage(resourceStage, resourceRequested);
      prepared = await prepare(stage);
    }
  }
  throw new Error("Model budget stage did not converge within the bounded stage lattice.");
}
