import type {
  ContextArchiveV1,
  ContextItem,
  ModelMessage
} from "agent-protocol";
import {
  blockTokens,
  compactHistoryBlock,
  historyBlocks,
  messageTokens,
  stableHistoryDigest,
  type HistoryBlock
} from "./history-blocks.js";
import {
  STABLE_SUMMARY_EPOCH_BLOCKS,
  summarizeHistory,
  summarizeStableHistoryArchive
} from "./summary.js";

export {
  projectReasoningSafeHistory,
  projectToolResultHistory,
  proposeReasoningTrajectoryTombstones,
  proposeToolResultPrune,
  type ReasoningTrajectoryProposal,
  type ToolResultPruneProposal
} from "./history-trajectory-projection.js";

export const MAXIMUM_HISTORY_SUMMARY_TOKENS = 16_000;
const SUMMARY_DELTA_TOKEN_RESERVE = 2_048;

export function historyAfterArchive(
  history: readonly ModelMessage[],
  archive: ContextArchiveV1 | undefined
): {
  archive?: ContextArchiveV1;
  history: ModelMessage[];
  coveredBlocks: HistoryBlock[];
  /** Authority-bearing blocks replayed raw even though the archive covers
   * them. Callers subtract these when extending the covered prefix. */
  replayedCoveredBlocks: HistoryBlock[];
} {
  if (!archive || archive.omittedHistoryTurns <= 0) {
    return { history: [...history], coveredBlocks: [], replayedCoveredBlocks: [] };
  }
  const blocks = historyBlocks(history);
  const coveredBlocks = blocks.slice(0, archive.omittedHistoryTurns);
  if (coveredBlocks.length !== archive.omittedHistoryTurns
    || stableHistoryDigest(coveredBlocks) !== archive.sourceDigest) {
    return { history: [...history], coveredBlocks: [], replayedCoveredBlocks: [] };
  }
  const newestUser = latestUserBlock(blocks);
  const replayedCoveredBlocks = newestUser >= 0 && newestUser < archive.omittedHistoryTurns
    ? [blocks[newestUser]!]
    : [];
  return {
    archive,
    coveredBlocks,
    replayedCoveredBlocks,
    history: [
      ...replayedCoveredBlocks,
      ...blocks.slice(archive.omittedHistoryTurns)
    ].flatMap((block) => block.messages)
  };
}

export function contextOverflow(message: string): Error {
  return Object.assign(new Error(message), { code: "context_overflow" });
}

function latestUserBlock(blocks: readonly HistoryBlock[]): number {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    if (blocks[index].messages.some((message) => message.role === "user")) return index;
  }
  return -1;
}

interface HistorySelection {
  selected: Map<number, ModelMessage[]>;
  used: number;
  fitLimit: number;
}

export function selectMandatoryHistory(
  blocks: readonly HistoryBlock[],
  available: number,
  mandatoryTokens: number,
  historyTokenLimit: number,
  rawBlockTokenLimit: number,
  reserveSummary: boolean
): HistorySelection {
  const selected = new Map<number, ModelMessage[]>();
  const newestUser = latestUserBlock(blocks);
  let used = mandatoryTokens;
  if (newestUser >= 0) {
    const block = blocks[newestUser];
    const rawTokens = blockTokens(block.messages);
    const limit = available - used;
    // The user's latest request is mandatory authority-bearing input. Only
    // oversized tool exchanges are textualized; silently truncating the user
    // request could change the task itself.
    if (!block.wireSafe || rawTokens > limit) {
      throw contextOverflow(`Mandatory context and the newest user turn cannot fit in ${available} context tokens.`);
    }
    const messages = block.messages;
    const tokens = blockTokens(messages);
    selected.set(newestUser, messages);
    used += tokens;
  }

  const newest = blocks.length - 1;
  const requiresLatest = newest >= 0 && newest !== newestUser;
  const couldOmit = blocks.length > selected.size + (requiresLatest ? 1 : 0);
  const desiredSummaryReserve = reserveSummary && couldOmit
    ? Math.min(MAXIMUM_HISTORY_SUMMARY_TOKENS, Math.max(16, Math.floor(available * 0.05)))
    : 0;
  const minimumLatestTokens = requiresLatest ? messageTokens({ role: "assistant", content: "" }) : 0;
  const summaryReserve = Math.min(desiredSummaryReserve, Math.max(0, available - used - minimumLatestTokens));
  const fitLimit = available - summaryReserve;

  if (!requiresLatest) return { selected, used, fitLimit };
  const block = blocks[newest];
  const rawTokens = blockTokens(block.messages);
  const limit = Math.min(
    rawBlockTokenLimit,
    fitLimit - used
  );
  const messages = block.wireSafe && rawTokens <= limit
    ? block.messages
    : compactHistoryBlock(block, limit);
  if (!messages) {
    throw contextOverflow(`Mandatory context, the newest user turn, and the latest history block cannot fit in ${available} context tokens.`);
  }
  selected.set(newest, messages);
  return { selected, used: used + blockTokens(messages), fitLimit };
}

export function includeRecentHistory(
  blocks: readonly HistoryBlock[],
  selected: Map<number, ModelMessage[]>,
  initialUsed: number,
  fitLimit: number,
  historyTokenLimit: number,
  rawBlockTokenLimit: number,
  maximumRawBlocks: number
): number {
  let used = initialUsed;
  let historyUsed = [...selected.values()].reduce((total, messages) => total + blockTokens(messages), 0);
  let reachedBoundary = false;
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    if (selected.has(index)) continue;
    const block = blocks[index];
    const messages = block.messages;
    const tokens = messages ? blockTokens(messages) : Number.POSITIVE_INFINITY;
    if (reachedBoundary || selected.size >= maximumRawBlocks
      || !block.wireSafe || !messages || tokens > rawBlockTokenLimit
      || used + tokens > fitLimit || historyUsed + tokens > historyTokenLimit) {
      reachedBoundary = true;
      continue;
    }
    selected.set(index, messages);
    used += tokens;
    historyUsed += tokens;
  }
  return used;
}

export function historySummaries(
  omittedBlocks: readonly ModelMessage[][],
  summaryTokenBudget: number
): { summary?: ContextItem; summaryDelta?: ContextItem } {
  // Stable epochs are a context invariant, not a provider-cache optimization.
  // Every provider gets the same append-only archive plus a bounded recent
  // delta; prompt-cache capability only controls the size/layout of the raw
  // tail in the planner.
  const completeEpochBlockCount = Math.floor(
    omittedBlocks.length / STABLE_SUMMARY_EPOCH_BLOCKS
  ) * STABLE_SUMMARY_EPOCH_BLOCKS;
  if (completeEpochBlockCount === 0) {
    const summary = summarizeHistory(
      omittedBlocks,
      Math.min(SUMMARY_DELTA_TOKEN_RESERVE, summaryTokenBudget)
    );
    return summary ? { summary } : {};
  }
  const deltaTokenBudget = Math.min(
    SUMMARY_DELTA_TOKEN_RESERVE,
    summaryTokenBudget < 32 ? 0 : Math.max(0, Math.floor(summaryTokenBudget / 4))
  );
  const archive = summarizeStableHistoryArchive(
    omittedBlocks.slice(0, completeEpochBlockCount),
    Math.max(0, summaryTokenBudget - deltaTokenBudget),
    STABLE_SUMMARY_EPOCH_BLOCKS
  );
  const summaryDelta = summarizeHistory(
    omittedBlocks.slice(archive.coveredBlocks),
    deltaTokenBudget
  );
  return {
    ...(archive.summary ? { summary: archive.summary } : {}),
    ...(summaryDelta ? { summaryDelta } : {})
  };
}
