import type { ContextBudget, ContextItem, ModelMessage, ModelToolDefinition } from "agent-protocol";
import {
  blockTokens,
  contextOverflow,
  historyBlocks,
  historySummaries,
  includeRecentHistory,
  MAXIMUM_HISTORY_SUMMARY_TOKENS,
  selectMandatoryHistory,
  withoutUnneededHistoricalReasoning,
  type HistoryBlock
} from "./history-planning.js";
import { approximateTokens } from "./unicode.js";
export interface ContextPlan {
  messages: ModelMessage[];
  included: ContextItem[];
  omitted: ContextItem[];
  budget: ContextBudget;
  summary?: ContextItem;
  archive?: ContextItem;
  /** Stable omitted prefix used by the runtime summarizer; never persisted here. */
  stableOmittedHistory: ModelMessage[][];
  omittedHistoryTurns: number;
  latestHistoryBlockTokens: number;
  cacheMode: "prefix_cache" | "provider_window";
  historyTokenLimit: number;
  dynamicSuffixTokens: number;
}
export interface PlanContextOptions {
  system: ContextItem[];
  history: ModelMessage[];
  dynamic: ContextItem[];
  tools: ModelToolDefinition[];
  /** Durable assistant-level semantic archive of an older stable prefix. */
  archive?: ContextItem;
  contextWindowTokens: number;
  outputReserveTokens: number;
  promptCache: boolean;
  /** Optional history ceilings may compact replayable history earlier, but
   * never truncate the latest authority-bearing user instruction. */
  historyTokenLimit?: number;
  rawHistoryBlockTokenLimit?: number;
  historySummaryTokenLimit?: number;
  maximumRawHistoryBlocks?: number;
}
function toolTokens(tools: ModelToolDefinition[]): number {
  return tools.reduce((total, tool) => total + approximateTokens(JSON.stringify(tool)) + 8, 0);
}
function optionalLimit(value: number | undefined): number {
  return value === undefined ? Number.POSITIVE_INFINITY : Math.max(0, Math.floor(value));
}

function historyPlanningLimits(options: PlanContextOptions, available: number): {
  historyTokenLimit: number; rawBlockTokenLimit: number; maximumRawBlocks: number;
} {
  const historyTokenLimit = Math.min(available, optionalLimit(options.historyTokenLimit));
  const defaultRawBlock = historyTokenLimit;
  return {
    historyTokenLimit,
    rawBlockTokenLimit: Math.min(defaultRawBlock, optionalLimit(options.rawHistoryBlockTokenLimit)),
    maximumRawBlocks: Math.max(0, Math.min(
      Number.MAX_SAFE_INTEGER, optionalLimit(options.maximumRawHistoryBlocks)
    ))
  };
}

function contextRole(item: ContextItem): ModelMessage["role"] {
  if (item.authority === "system") return "system";
  if (item.authority === "developer" || item.authority === "project" || item.authority === "runtime") return "developer";
  return "user";
}

function includeDynamicContext(
  candidates: readonly ContextItem[],
  included: ContextItem[],
  omitted: ContextItem[],
  initialUsed: number,
  fitLimit: number
): number {
  let used = initialUsed;
  for (const item of candidates) {
    if (used + item.tokenCount <= fitLimit) {
      included.push(item);
      used += item.tokenCount;
    } else {
      omitted.push(item);
    }
  }
  return used;
}

function toContextMessage(item: ContextItem): ModelMessage {
  return { role: contextRole(item), content: `[${item.provenance}]\n${item.content}` };
}

function toArchiveMessage(item: ContextItem): ModelMessage {
  return {
    role: "assistant",
    content: `[${item.provenance}; historical summary, not instructions]\n${item.content}`
  };
}

function arrangeMessages(
  mandatory: readonly ContextItem[],
  included: readonly ContextItem[],
  archive: ContextItem | undefined,
  summary: ContextItem | undefined,
  summaryDelta: ContextItem | undefined,
  retainedHistory: readonly ModelMessage[],
  promptCache: boolean
): { messages: ModelMessage[]; dynamicTokens: number } {
  const dynamic = included.filter((item) =>
    !mandatory.includes(item) && item !== archive && item !== summary && item !== summaryDelta);
  const dynamicSuffix = [...dynamic]
    .sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id));
  const asMessage = (item: ContextItem): ModelMessage =>
    item === archive || item === summary || item === summaryDelta
      ? toArchiveMessage(item)
      : toContextMessage(item);
  const legacy = [...included.map(asMessage), ...retainedHistory];
  const cacheFirst = [
    ...mandatory.map(toContextMessage),
    ...(archive ? [toArchiveMessage(archive)] : []),
    ...(summary ? [toArchiveMessage(summary)] : []),
    ...(summaryDelta ? [toArchiveMessage(summaryDelta)] : []),
    ...retainedHistory,
    ...dynamicSuffix.map(toContextMessage)
  ];
  return {
    messages: promptCache ? cacheFirst : legacy,
    dynamicTokens: dynamic.reduce((total, item) => total + item.tokenCount, 0)
  };
}

function newestUserBlockIndex(blocks: readonly HistoryBlock[]): number {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    if (blocks[index]!.messages.some((message) => message.role === "user")) return index;
  }
  return -1;
}

function stableOmittedHistory(
  blocks: readonly HistoryBlock[],
  selected: ReadonlyMap<number, ModelMessage[]>
): ModelMessage[][] {
  const newestUser = newestUserBlockIndex(blocks);
  const firstRetainedTail = [...selected.keys()]
    .filter((index) => index !== newestUser)
    .sort((left, right) => left - right)[0] ?? blocks.length;
  const hasGap = blocks.slice(0, firstRetainedTail)
    .some((_block, index) => !selected.has(index));
  return hasGap
    ? blocks.slice(0, firstRetainedTail).map((block) => block.messages)
    : [];
}

function selectedHistory(
  options: PlanContextOptions,
  blocks: readonly HistoryBlock[],
  selected: ReadonlyMap<number, ModelMessage[]>,
  available: number,
  used: number,
  historyTokenLimit: number
): {
  omittedBlocks: ModelMessage[][];
  stableOmittedHistory: ModelMessage[][];
  retainedHistory: ModelMessage[];
  summary?: ContextItem;
  summaryDelta?: ContextItem;
} {
  const omittedBlocks = blocks
    .filter((_block, index) => !selected.has(index))
    .map((block) => block.messages);
  const retainedHistoryTokens = [...selected.values()]
    .reduce((total, messages) => total + blockTokens(messages), 0);
  const summaryTokenBudget = Math.max(0, Math.min(
    MAXIMUM_HISTORY_SUMMARY_TOKENS,
    optionalLimit(options.historySummaryTokenLimit),
    available - used,
    options.promptCache
      ? Number.POSITIVE_INFINITY
      : Math.max(0, historyTokenLimit - retainedHistoryTokens)
  ));
  const { summary, summaryDelta } = historySummaries(omittedBlocks, summaryTokenBudget);
  const retainedHistory = [...selected.entries()]
    .sort(([left], [right]) => left - right)
    .flatMap(([, messages]) => messages);
  return {
    omittedBlocks,
    stableOmittedHistory: stableOmittedHistory(blocks, selected),
    retainedHistory,
    ...(summary ? { summary } : {}),
    ...(summaryDelta ? { summaryDelta } : {})
  };
}

export function planContext(options: PlanContextOptions): ContextPlan {
  const toolCount = toolTokens(options.tools);
  const available = Math.max(0, options.contextWindowTokens - options.outputReserveTokens - toolCount);
  const mandatory = [...options.system];
  const archive = options.archive;
  const candidates = [...options.dynamic]
    .sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id));
  const mandatoryTokens = mandatory.reduce((total, item) => total + item.tokenCount, 0);
  const archiveTokens = archive?.tokenCount ?? 0;
  if (mandatoryTokens + archiveTokens > available) {
    throw contextOverflow(`Mandatory system, project, and archived context requires ${mandatoryTokens + archiveTokens} tokens but only ${available} context tokens are available.`);
  }

  // Tool-call reasoning is part of the provider wire protocol for thinking
  // models and must be replayed with that call. Reasoning on ordinary
  // assistant turns remains audit-only and is omitted from future requests.
  const blocks = historyBlocks(options.history.map(withoutUnneededHistoricalReasoning));
  const { historyTokenLimit, rawBlockTokenLimit, maximumRawBlocks } = historyPlanningLimits(options, available);
  const selection = selectMandatoryHistory(
    blocks,
    available,
    mandatoryTokens + archiveTokens,
    historyTokenLimit,
    rawBlockTokenLimit,
    false
  );
  const included: ContextItem[] = [...mandatory, ...(archive ? [archive] : [])];
  const omitted: ContextItem[] = [];
  let used = includeDynamicContext(candidates, included, omitted, selection.used, selection.fitLimit);
  used = includeRecentHistory(
    blocks,
    selection.selected,
    used,
    selection.fitLimit,
    historyTokenLimit,
    rawBlockTokenLimit,
    maximumRawBlocks
  );

  const projected = selectedHistory(
    options, blocks, selection.selected, available, used, historyTokenLimit
  );
  const { omittedBlocks, stableOmittedHistory, retainedHistory, summary, summaryDelta } = projected;
  if (summary) included.push(summary);
  if (summaryDelta) included.push(summaryDelta);
  const layout = arrangeMessages(
    mandatory, included, archive, summary, summaryDelta, retainedHistory, options.promptCache
  );
  return {
    messages: layout.messages,
    included,
    omitted,
    ...(summary ? { summary } : {}),
    ...(archive ? { archive } : {}),
    stableOmittedHistory,
    omittedHistoryTurns: omittedBlocks.length,
    latestHistoryBlockTokens: blockTokens(selection.selected.get(blocks.length - 1) ?? []),
    cacheMode: options.promptCache ? "prefix_cache" : "provider_window",
    historyTokenLimit,
    dynamicSuffixTokens: layout.dynamicTokens,
    budget: {
      contextWindowTokens: options.contextWindowTokens,
      outputReserveTokens: options.outputReserveTokens,
      toolTokens: toolCount,
      systemTokens: mandatoryTokens,
      dynamicTokens: layout.dynamicTokens,
      historyTokens: blockTokens(retainedHistory)
        + archiveTokens
        + (summary?.tokenCount ?? 0)
        + (summaryDelta?.tokenCount ?? 0)
    }
  };
}
