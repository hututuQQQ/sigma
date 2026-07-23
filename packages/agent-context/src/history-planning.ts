import { createHash } from "node:crypto";
import type { ContextArchiveV1, ContextItem, ModelMessage } from "agent-protocol";
import {
  STABLE_SUMMARY_EPOCH_BLOCKS,
  summarizeHistory,
  summarizeStableHistoryArchive
} from "./summary.js";
import { approximateTokens } from "./unicode.js";

export interface HistoryBlock {
  messages: ModelMessage[];
  wireSafe: boolean;
}
export const MAXIMUM_HISTORY_SUMMARY_TOKENS = 16_000;

const SUMMARY_DELTA_TOKEN_RESERVE = 2_048;

function messageTokens(message: ModelMessage): number {
  return approximateTokens(message.content)
    + approximateTokens(message.reasoningContent ?? "")
    + approximateTokens(JSON.stringify(message.toolCalls ?? []))
    + 6;
}

export function withoutUnneededHistoricalReasoning(message: ModelMessage): ModelMessage {
  if (message.reasoningContent === undefined || (message.toolCalls?.length ?? 0) > 0) return message;
  const { reasoningContent: _reasoningContent, ...wireMessage } = message;
  return wireMessage;
}

export function blockTokens(block: readonly ModelMessage[]): number {
  return block.reduce((total, message) => total + messageTokens(message), 0);
}

export function historyBlocks(history: readonly ModelMessage[]): HistoryBlock[] {
  const blocks: HistoryBlock[] = [];
  for (let index = 0; index < history.length;) {
    const message = history[index];
    const calls = message.role === "assistant" ? message.toolCalls ?? [] : [];
    if (calls.length === 0) {
      blocks.push({ messages: [message], wireSafe: message.role !== "tool" });
      index += 1;
      continue;
    }

    const expected = new Set(calls.map((call) => call.id));
    const matched = new Set<string>();
    const messages = [message];
    let cursor = index + 1;
    while (cursor < history.length) {
      const result = history[cursor];
      const callId = result.role === "tool" ? result.toolCallId : undefined;
      if (!callId || !expected.has(callId) || matched.has(callId)) break;
      messages.push(result);
      matched.add(callId);
      cursor += 1;
    }
    blocks.push({
      messages,
      wireSafe: expected.size === calls.length && matched.size === expected.size
        && !calls.some((call) => call.id.startsWith("runtime_completion_intent_"))
    });
    index = cursor;
  }
  return blocks;
}

export function stableHistoryDigest(blocks: readonly HistoryBlock[]): string {
  return createHash("sha256").update(JSON.stringify(
    blocks.map((block) => block.messages)
  )).digest("hex");
}

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

function fitPrefix(value: string, maximumTokens: number): string {
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (approximateTokens(value.slice(0, middle)) <= maximumTokens) low = middle;
    else high = middle - 1;
  }
  return value.slice(0, low).trimEnd();
}

function fitText(value: string, maximumTokens: number): string {
  if (maximumTokens <= 0) return "";
  if (approximateTokens(value) <= maximumTokens) return value;
  const marker = "\n...[context compacted]...\n";
  const markerTokens = approximateTokens(marker);
  if (markerTokens >= maximumTokens) return fitPrefix(value, maximumTokens);
  let low = 0;
  let high = Math.floor(value.length / 2);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = `${value.slice(0, middle)}${marker}${value.slice(-middle)}`;
    if (approximateTokens(candidate) <= maximumTokens) low = middle;
    else high = middle - 1;
  }
  const suffix = low > 0 ? value.slice(-low) : "";
  return `${value.slice(0, low)}${marker}${suffix}`.trimEnd();
}

function compactFallback(block: HistoryBlock, maximumTokens: number): ModelMessage[] | undefined {
  const empty: ModelMessage = { role: "assistant", content: "" };
  const contentOverhead = messageTokens(empty) - approximateTokens(empty.content);
  if (maximumTokens < messageTokens(empty)) return undefined;
  const observations = block.messages
    .filter((message) => message.role === "tool")
    .map((message, index) => `Observation ${index + 1}:\n${message.content}`)
    .join("\n\n");
  const explanation = `A ${block.messages.length}-message history block was omitted because it could not be represented within the context budget without breaking tool-call protocol. Re-inspect the relevant state if needed.`;
  // Historical assistant tool calls contain executable arguments. Never copy
  // those arguments into a lossy replacement. Tool-result messages are safe
  // to textualize, however, and retain the receipt status, bounded output
  // preview, and durable artifact references supplied by the kernel.
  const observationSummary = observations.length > 0
    ? `${explanation}\nThe following is a non-executable observation summary; it is not a tool call and contains no call arguments:\n${observations}`
    : explanation;
  const compacted: ModelMessage = {
    role: "assistant",
    content: fitText(observationSummary, maximumTokens - contentOverhead)
  };
  return messageTokens(compacted) <= maximumTokens ? [compacted] : [empty];
}

function compactBlock(block: HistoryBlock, maximumTokens: number): ModelMessage[] | undefined {
  if (!block.wireSafe) return compactFallback(block, maximumTokens);
  // A historical tool call is executable-looking protocol. Never manufacture
  // replacement arguments or a partial call/result skeleton: models have been
  // observed copying those placeholders into a later real invocation. Tool
  // exchanges are therefore retained losslessly or replaced as one
  // low-authority text summary.
  if (block.messages.some((message) => (message.toolCalls?.length ?? 0) > 0 || message.role === "tool")) {
    return compactFallback(block, maximumTokens);
  }
  const compacted = block.messages.map((message) => ({
    ...message,
    content: fitText(message.content, Math.max(0, maximumTokens - 6))
  }));
  return blockTokens(compacted) <= maximumTokens ? compacted : compactFallback(block, maximumTokens);
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
    : compactBlock(block, limit);
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
