import type { ContextBudget, ContextItem, ModelMessage, ModelToolDefinition } from "agent-protocol";
import {
  blockTokens,
  CACHED_RAW_HISTORY_TOKEN_LIMIT,
  contextOverflow,
  historyBlocks,
  historySummaries,
  includeRecentHistory,
  MAXIMUM_HISTORY_SUMMARY_TOKENS,
  MAXIMUM_RAW_HISTORY_BLOCKS,
  PROACTIVE_HISTORY_TOKEN_LIMIT,
  RECENT_RAW_BLOCK_TOKEN_LIMIT,
  selectMandatoryHistory,
  withoutUnneededHistoricalReasoning
} from "./history-planning.js";
import { approximateTokens } from "./unicode.js";
export interface ContextPlan {
  messages: ModelMessage[];
  included: ContextItem[];
  omitted: ContextItem[];
  budget: ContextBudget;
  summary?: ContextItem;
  omittedHistoryTurns: number;
  latestHistoryBlockTokens: number;
  cacheMode: "prefix_cache" | "proactive_window";
  historyTokenLimit: number;
  dynamicSuffixTokens: number;
}
export interface PlanContextOptions {
  system: ContextItem[];
  history: ModelMessage[];
  dynamic: ContextItem[];
  tools: ModelToolDefinition[];
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
  const defaultHistory = options.promptCache ? CACHED_RAW_HISTORY_TOKEN_LIMIT : PROACTIVE_HISTORY_TOKEN_LIMIT;
  const historyTokenLimit = Math.min(available, defaultHistory, optionalLimit(options.historyTokenLimit));
  const defaultRawBlock = options.promptCache ? historyTokenLimit : RECENT_RAW_BLOCK_TOKEN_LIMIT;
  return {
    historyTokenLimit,
    rawBlockTokenLimit: Math.min(defaultRawBlock, optionalLimit(options.rawHistoryBlockTokenLimit)),
    maximumRawBlocks: Math.max(0, Math.min(
      MAXIMUM_RAW_HISTORY_BLOCKS, optionalLimit(options.maximumRawHistoryBlocks)
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

function arrangeMessages(
  mandatory: readonly ContextItem[],
  included: readonly ContextItem[],
  summary: ContextItem | undefined,
  summaryDelta: ContextItem | undefined,
  retainedHistory: readonly ModelMessage[],
  promptCache: boolean
): { messages: ModelMessage[]; dynamicTokens: number } {
  const dynamic = included.filter((item) =>
    !mandatory.includes(item) && item !== summary && item !== summaryDelta);
  const dynamicSuffix = [...dynamic]
    .sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id));
  const legacy = [...included.map(toContextMessage), ...retainedHistory];
  const cacheFirst = [
    ...mandatory.map(toContextMessage),
    ...(summary ? [toContextMessage(summary)] : []),
    ...(summaryDelta ? [toContextMessage(summaryDelta)] : []),
    ...retainedHistory,
    ...dynamicSuffix.map(toContextMessage)
  ];
  return {
    messages: promptCache ? cacheFirst : legacy,
    dynamicTokens: dynamic.reduce((total, item) => total + item.tokenCount, 0)
  };
}

export function planContext(options: PlanContextOptions): ContextPlan {
  const toolCount = toolTokens(options.tools);
  const available = Math.max(0, options.contextWindowTokens - options.outputReserveTokens - toolCount);
  const mandatory = [...options.system];
  const candidates = [...options.dynamic]
    .sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id));
  const mandatoryTokens = mandatory.reduce((total, item) => total + item.tokenCount, 0);
  if (mandatoryTokens > available) {
    throw contextOverflow(`Mandatory system and project context requires ${mandatoryTokens} tokens but only ${available} context tokens are available.`);
  }

  // Tool-call reasoning is part of the provider wire protocol for thinking
  // models and must be replayed with that call. Reasoning on ordinary
  // assistant turns remains audit-only and is omitted from future requests.
  const blocks = historyBlocks(options.history.map(withoutUnneededHistoricalReasoning));
  const { historyTokenLimit, rawBlockTokenLimit, maximumRawBlocks } = historyPlanningLimits(options, available);
  const selection = selectMandatoryHistory(
    blocks,
    available,
    mandatoryTokens,
    historyTokenLimit,
    rawBlockTokenLimit,
    true
  );
  const included: ContextItem[] = [...mandatory];
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

  const omittedBlocks = blocks
    .filter((_block, index) => !selection.selected.has(index))
    .map((block) => block.messages);
  const retainedHistoryTokens = [...selection.selected.values()]
    .reduce((total, messages) => total + blockTokens(messages), 0);
  const summaryTokenBudget = Math.max(0, Math.min(
    MAXIMUM_HISTORY_SUMMARY_TOKENS,
    optionalLimit(options.historySummaryTokenLimit),
    available - used,
    options.promptCache ? Number.POSITIVE_INFINITY : Math.max(0, historyTokenLimit - retainedHistoryTokens)
  ));
  const { summary, summaryDelta } = historySummaries(
    omittedBlocks, summaryTokenBudget, options.promptCache
  );
  if (summary) included.push(summary);
  if (summaryDelta) included.push(summaryDelta);
  const retainedHistory = [...selection.selected.entries()]
    .sort(([left], [right]) => left - right)
    .flatMap(([, messages]) => messages);
  const layout = arrangeMessages(
    mandatory, included, summary, summaryDelta, retainedHistory, options.promptCache
  );
  return {
    messages: layout.messages,
    included,
    omitted,
    ...(summary ? { summary } : {}),
    omittedHistoryTurns: omittedBlocks.length,
    latestHistoryBlockTokens: blockTokens(selection.selected.get(blocks.length - 1) ?? []),
    cacheMode: options.promptCache ? "prefix_cache" : "proactive_window",
    historyTokenLimit,
    dynamicSuffixTokens: layout.dynamicTokens,
    budget: {
      contextWindowTokens: options.contextWindowTokens,
      outputReserveTokens: options.outputReserveTokens,
      toolTokens: toolCount,
      systemTokens: mandatoryTokens,
      dynamicTokens: layout.dynamicTokens,
      historyTokens: blockTokens(retainedHistory)
        + (summary?.tokenCount ?? 0)
        + (summaryDelta?.tokenCount ?? 0)
    }
  };
}
