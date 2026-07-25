import { createHash } from "node:crypto";
import type {
  ModelMessage,
  ReasoningTrajectoryStateV1,
  ToolResultPruneStateV1
} from "agent-protocol";
import {
  compactHistoryFallback,
  historyBlocks,
  messageTokens,
  stableHistoryDigest,
  type HistoryBlock
} from "./history-blocks.js";

export const PROTECTED_RECENT_TOOL_RESULT_TOKENS = 40_000;
export const MINIMUM_TOOL_RESULT_PRUNE_TOKENS = 20_000;
const TOOL_RESULT_TOMBSTONE_TOKENS = 1_024;
const REASONING_TRAJECTORY_TOMBSTONE_TOKENS = 1_536;

function historyBlockDigest(block: HistoryBlock): string {
  return stableHistoryDigest([block]);
}

function missingToolReasoning(block: HistoryBlock): boolean {
  const assistant = block.messages[0];
  return block.wireSafe
    && assistant?.role === "assistant"
    && (assistant.toolCalls?.length ?? 0) > 0
    && assistant.reasoningContent === undefined;
}

function reasoningTrajectorySourceDigest(blockDigests: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(blockDigests)).digest("hex");
}

export interface ReasoningTrajectoryProposal {
  state: ReasoningTrajectoryStateV1;
  changed: boolean;
  newlyTombstoned: number;
}

export function proposeReasoningTrajectoryTombstones(
  history: readonly ModelMessage[],
  previous: ReasoningTrajectoryStateV1,
  required: boolean
): ReasoningTrajectoryProposal {
  if (!required) return { state: previous, changed: false, newlyTombstoned: 0 };
  const existing = new Set(previous.blockDigests);
  const missing = historyBlocks(history).filter(missingToolReasoning)
    .map(historyBlockDigest);
  if (missing.length === 0 && existing.size === 0) {
    return { state: previous, changed: false, newlyTombstoned: 0 };
  }
  const newlyTombstoned = missing.filter((blockDigest) => !existing.has(blockDigest)).length;
  for (const blockDigest of missing) existing.add(blockDigest);
  const blockDigests = [...existing].sort();
  const state: ReasoningTrajectoryStateV1 = {
    schemaVersion: 1,
    blockDigests,
    sourceDigest: reasoningTrajectorySourceDigest(blockDigests)
  };
  return {
    state,
    changed: state.sourceDigest !== previous.sourceDigest,
    newlyTombstoned
  };
}

function reasoningTrajectoryTombstone(
  block: HistoryBlock,
  blockDigest: string
): ModelMessage[] {
  const compacted = compactHistoryFallback(
    block,
    REASONING_TRAJECTORY_TOMBSTONE_TOKENS
  );
  const observation = compacted?.[0]?.content
    ?? "A prior assistant/tool exchange remains durable but is not replayable under this provider reasoning protocol.";
  return [{
    role: "assistant",
    content: [
      `[reasoning-trajectory-tombstone:${blockDigest}]`,
      "This complete assistant/tool block began under a trajectory that did not contain replayable provider reasoning. Its tool side effects were already settled exactly once; no reasoning was guessed and no call should be repeated.",
      observation
    ].join("\n")
  }];
}

export function projectReasoningSafeHistory(
  history: readonly ModelMessage[],
  state: ReasoningTrajectoryStateV1,
  required: boolean
): ModelMessage[] {
  if (!required) return [...history];
  const tombstoned = new Set(state.blockDigests);
  return historyBlocks(history).flatMap((block) => {
    const blockDigest = historyBlockDigest(block);
    return missingToolReasoning(block) || tombstoned.has(blockDigest)
      ? reasoningTrajectoryTombstone(block, blockDigest)
      : block.messages;
  });
}

function toolResultTokens(block: HistoryBlock): number {
  return block.messages.filter((message) => message.role === "tool")
    .reduce((total, message) => total + messageTokens(message), 0);
}

function validPruneState(
  blocks: readonly HistoryBlock[],
  state: ToolResultPruneStateV1 | undefined,
  archiveSourceDigest: string | undefined
): state is ToolResultPruneStateV1 {
  return Boolean(state
    && state.archiveSourceDigest === archiveSourceDigest
    && state.coveredBlocks <= blocks.length
    && stableHistoryDigest(blocks.slice(0, state.coveredBlocks)) === state.sourceDigest);
}

export interface ToolResultPruneProposal {
  state?: ToolResultPruneStateV1;
  changed: boolean;
  protectedTokens: number;
  prunedTokens: number;
}

export function proposeToolResultPrune(
  history: readonly ModelMessage[],
  previous: ToolResultPruneStateV1 | undefined,
  archiveSourceDigest?: string
): ToolResultPruneProposal {
  const blocks = historyBlocks(history);
  const current = validPruneState(blocks, previous, archiveSourceDigest)
    ? previous : undefined;
  let protectedTokens = 0;
  let firstProtected = blocks.length;
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const tokens = toolResultTokens(blocks[index]!);
    if (tokens <= 0) continue;
    protectedTokens += tokens;
    firstProtected = index;
    if (protectedTokens >= PROTECTED_RECENT_TOOL_RESULT_TOKENS) break;
  }
  const eligibleEnd = firstProtected - 1;
  const start = current?.coveredBlocks ?? 0;
  if (eligibleEnd < start) {
    return {
      ...(current ? { state: current } : {}),
      changed: false,
      protectedTokens,
      prunedTokens: 0
    };
  }
  const prunedTokens = blocks.slice(start, eligibleEnd + 1)
    .reduce((total, block) => total + toolResultTokens(block), 0);
  if (prunedTokens < MINIMUM_TOOL_RESULT_PRUNE_TOKENS) {
    return {
      ...(current ? { state: current } : {}),
      changed: false,
      protectedTokens,
      prunedTokens
    };
  }
  const coveredBlocks = eligibleEnd + 1;
  const state: ToolResultPruneStateV1 = {
    schemaVersion: 1,
    coveredBlocks,
    sourceDigest: stableHistoryDigest(blocks.slice(0, coveredBlocks)),
    ...(archiveSourceDigest ? { archiveSourceDigest } : {})
  };
  return { state, changed: true, protectedTokens, prunedTokens };
}

export function projectToolResultHistory(
  history: readonly ModelMessage[],
  state: ToolResultPruneStateV1 | undefined,
  archiveSourceDigest?: string
): ModelMessage[] {
  const blocks = historyBlocks(history);
  if (!validPruneState(blocks, state, archiveSourceDigest)) return [...history];
  return blocks.flatMap((block, index) => {
    if (index >= state.coveredBlocks || toolResultTokens(block) === 0) return block.messages;
    return compactHistoryFallback(block, TOOL_RESULT_TOMBSTONE_TOKENS)
      ?? [{
        role: "assistant" as const,
        content: "A prior tool exchange was compacted; inspect current state or its receipt artifact if needed."
      }];
  });
}
