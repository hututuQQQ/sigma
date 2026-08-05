import type { BudgetAmounts } from "agent-protocol";
import {
  blockTokens,
  historyAfterArchive,
  historyBlocks,
  projectReasoningSafeHistory,
  projectToolResultHistory,
  stableHistoryDigest,
  type HistoryBlock
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

const ARCHIVE_RETAINED_HISTORY_TARGET_RATIO = 0.6;
const MINIMUM_RETAINED_HISTORY_BLOCKS = 4;

function latestUserBlockIndex(blocks: readonly HistoryBlock[]): number {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    if (blocks[index]!.messages.some((message) => message.role === "user")) return index;
  }
  return -1;
}

function retainedHistoryTokens(
  blocks: readonly HistoryBlock[],
  coverage: number,
  latestUser: number
): number {
  const rawTail = blocks.slice(coverage)
    .reduce((total, block) => total + blockTokens(block.messages), 0);
  // Archive projection always replays the latest authority-bearing user block
  // even when it belongs to the covered prefix.
  return latestUser >= 0 && latestUser < coverage
    ? rawTail + blockTokens(blocks[latestUser]!.messages)
    : rawTail;
}

/**
 * Extend the minimum archive prefix until the retained raw tail is materially
 * below the omission threshold. Keeping trigger and target separate prevents
 * a single new tool round from immediately starting another summarizer call.
 */
export function archiveCoverageTarget(
  blocks: readonly HistoryBlock[],
  minimumCoverage: number,
  historyTokenLimit: number
): number {
  const minimum = Math.max(0, Math.min(blocks.length, Math.floor(minimumCoverage)));
  const maximum = Math.max(
    minimum,
    Math.max(0, blocks.length - MINIMUM_RETAINED_HISTORY_BLOCKS)
  );
  const targetTokens = Math.max(
    1,
    Math.floor(historyTokenLimit * ARCHIVE_RETAINED_HISTORY_TARGET_RATIO)
  );
  const latestUser = latestUserBlockIndex(blocks);
  let coverage = minimum;
  let retainedTokens = retainedHistoryTokens(blocks, coverage, latestUser);
  while (coverage < maximum && retainedTokens > targetTokens) {
    if (coverage !== latestUser) {
      retainedTokens -= blockTokens(blocks[coverage]!.messages);
    }
    coverage += 1;
  }
  return coverage;
}

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
  const minimumCoverage = input.initialProjection.coveredBlocks.length + newlyCoveredTurns;
  const omittedHistoryTurns = archiveCoverageTarget(
    completeHistory,
    minimumCoverage,
    input.initial.plan.historyTokenLimit
  );
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
    history: projectToolResultHistory(
      projectReasoningSafeHistory(
        projection.history,
        input.session.durable.state.reasoningTrajectory,
        input.session.services.gateway.capabilities.requiresToolCallReasoningReplay === true
      ),
      input.session.durable.state.toolResultPrune,
      input.session.durable.state.contextArchive?.sourceDigest
    ),
    archive: projection.archive?.item
  });
  return { prepared, available };
}
