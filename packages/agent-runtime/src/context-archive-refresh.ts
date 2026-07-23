import type { BudgetAmounts } from "agent-protocol";
import {
  historyAfterArchive,
  historyBlocks,
  stableHistoryDigest
} from "agent-context";
import type { EffectRunnerOptions } from "./effect-runner.js";
import {
  availableModelBudget,
  prepareBudgetedModelTurn,
  type TurnPreparationInput
} from "./model-budget-convergence.js";
import {
  deterministicArchiveFallback,
  type ModelSummarizer,
  type ModelSummaryInput
} from "./model-summarizer.js";
import type { RuntimeSession } from "./types.js";

export interface ContextArchiveRefreshInput {
  session: RuntimeSession;
  preparation: TurnPreparationInput;
  initial: Awaited<ReturnType<typeof prepareBudgetedModelTurn>>;
  initialProjection: ReturnType<typeof historyAfterArchive>;
  available: BudgetAmounts;
  signal: AbortSignal;
  summarizer: ModelSummarizer;
  emit: EffectRunnerOptions["emit"];
}

export async function refreshContextArchive(
  input: ContextArchiveRefreshInput
): Promise<{
  prepared: Awaited<ReturnType<typeof prepareBudgetedModelTurn>>;
  available: BudgetAmounts;
}> {
  if (input.initial.plan.stableOmittedHistory.length === 0) {
    return { prepared: input.initial, available: input.available };
  }
  const completeHistory = historyBlocks(input.session.durable.state.messages);
  const newlyCoveredTurns = Math.max(
    0,
    input.initial.plan.stableOmittedHistory.length
      - input.initialProjection.replayedCoveredBlocks.length
  );
  const omittedHistoryTurns = input.initialProjection.coveredBlocks.length + newlyCoveredTurns;
  const stableHistory = completeHistory.slice(0, omittedHistoryTurns);
  const sourceDigest = stableHistoryDigest(stableHistory);
  if (input.session.durable.state.contextArchive?.sourceDigest === sourceDigest) {
    return { prepared: input.initial, available: input.available };
  }
  const summaryInput: ModelSummaryInput = {
    sourceDigest,
    omittedHistoryTurns,
    stableHistory: stableHistory.map((block) => block.messages),
    newHistory: completeHistory
      .slice(input.initialProjection.coveredBlocks.length, omittedHistoryTurns)
      .map((block) => block.messages),
    ...(input.initialProjection.archive
      ? { previous: input.initialProjection.archive.item }
      : {})
  };
  const item = await input.summarizer.summarize(
    input.session, summaryInput, input.signal
  ) ?? await deterministicArchiveFallback(input.session.services.gateway, summaryInput);
  await input.emit(input.session, "context.compacted", "runtime", {
    item,
    omittedHistoryTurns
  });
  const available = availableModelBudget(input.session);
  const projection = historyAfterArchive(
    input.session.durable.state.messages,
    input.session.durable.state.contextArchive
  );
  const prepared = await prepareBudgetedModelTurn({
    ...input.preparation,
    available,
    history: projection.history,
    archive: projection.archive?.item
  });
  return { prepared, available };
}
