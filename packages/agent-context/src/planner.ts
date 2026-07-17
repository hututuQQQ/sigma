import type { ContextBudget, ContextItem, ModelMessage, ModelToolDefinition } from "agent-protocol";
import { approximateTokens } from "./unicode.js";
import { summarizeHistory } from "./summary.js";

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
}

interface HistoryBlock {
  messages: ModelMessage[];
  wireSafe: boolean;
}

const RECENT_RAW_BLOCK_TOKEN_LIMIT = 8_192;
/**
 * Replaying every tool turn that still fits the provider window makes the
 * cumulative request cost quadratic in long sessions. For providers without
 * prompt caching, keep a generous raw working set and summarize older blocks
 * even when the provider could technically accept them. Cache-capable
 * providers instead retain the append-only prefix until the real window fills.
 */
const PROACTIVE_HISTORY_TOKEN_LIMIT = 24_000;

function messageTokens(message: ModelMessage): number {
  return approximateTokens(message.content)
    + approximateTokens(message.reasoningContent ?? "")
    + approximateTokens(JSON.stringify(message.toolCalls ?? []))
    + 6;
}

function withoutUnneededHistoricalReasoning(message: ModelMessage): ModelMessage {
  if (message.reasoningContent === undefined || (message.toolCalls?.length ?? 0) > 0) return message;
  const { reasoningContent: _reasoningContent, ...wireMessage } = message;
  return wireMessage;
}

function blockTokens(block: readonly ModelMessage[]): number {
  return block.reduce((total, message) => total + messageTokens(message), 0);
}

function toolTokens(tools: ModelToolDefinition[]): number {
  return tools.reduce((total, tool) => total + approximateTokens(JSON.stringify(tool)) + 8, 0);
}

function historyBlocks(history: readonly ModelMessage[]): HistoryBlock[] {
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
    });
    index = cursor;
  }
  return blocks;
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

function contextRole(item: ContextItem): ModelMessage["role"] {
  if (item.authority === "system") return "system";
  if (item.authority === "developer" || item.authority === "project" || item.authority === "runtime") return "developer";
  return "user";
}

function overflow(message: string): Error {
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

function selectMandatoryHistory(
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
    const limit = Math.min(rawBlockTokenLimit, historyTokenLimit, available - used);
    // The user's latest request is mandatory authority-bearing input. Only
    // oversized tool exchanges are textualized; silently truncating the user
    // request could change the task itself.
    if (!block.wireSafe || rawTokens > limit) {
      throw overflow(`Mandatory context and the newest user turn cannot fit in ${available} context tokens.`);
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
    ? Math.min(1_024, Math.max(16, Math.floor(available * 0.05)))
    : 0;
  const minimumLatestTokens = requiresLatest ? messageTokens({ role: "assistant", content: "" }) : 0;
  const summaryReserve = Math.min(desiredSummaryReserve, Math.max(0, available - used - minimumLatestTokens));
  const fitLimit = available - summaryReserve;

  if (!requiresLatest) return { selected, used, fitLimit };
  const block = blocks[newest];
  const rawTokens = blockTokens(block.messages);
  const selectedTokens = used - mandatoryTokens;
  const limit = Math.min(
    rawBlockTokenLimit,
    fitLimit - used,
    historyTokenLimit - selectedTokens
  );
  const messages = block.wireSafe && rawTokens <= limit
    ? block.messages
    : compactBlock(block, limit);
  if (!messages) {
    throw overflow(`Mandatory context, the newest user turn, and the latest history block cannot fit in ${available} context tokens.`);
  }
  selected.set(newest, messages);
  return { selected, used: used + blockTokens(messages), fitLimit };
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

function includeRecentHistory(
  blocks: readonly HistoryBlock[],
  selected: Map<number, ModelMessage[]>,
  initialUsed: number,
  fitLimit: number,
  historyTokenLimit: number,
  rawBlockTokenLimit: number
): number {
  let used = initialUsed;
  let historyUsed = [...selected.values()].reduce((total, messages) => total + blockTokens(messages), 0);
  let reachedBoundary = false;
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    if (selected.has(index)) continue;
    const block = blocks[index];
    const messages = block.messages;
    const tokens = messages ? blockTokens(messages) : Number.POSITIVE_INFINITY;
    if (reachedBoundary || !block.wireSafe || !messages || tokens > rawBlockTokenLimit
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

function toContextMessage(item: ContextItem): ModelMessage {
  return { role: contextRole(item), content: `[${item.provenance}]\n${item.content}` };
}

function arrangeMessages(
  mandatory: readonly ContextItem[],
  included: readonly ContextItem[],
  summary: ContextItem | undefined,
  retainedHistory: readonly ModelMessage[],
  promptCache: boolean
): { messages: ModelMessage[]; dynamicTokens: number } {
  const dynamic = included.filter((item) => !mandatory.includes(item) && item !== summary);
  const dynamicSuffix = [...dynamic]
    .sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id));
  const legacy = [...included.map(toContextMessage), ...retainedHistory];
  const cacheFirst = [
    ...mandatory.map(toContextMessage),
    ...(summary ? [toContextMessage(summary)] : []),
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
    throw overflow(`Mandatory system and project context requires ${mandatoryTokens} tokens but only ${available} context tokens are available.`);
  }

  // Tool-call reasoning is part of the provider wire protocol for thinking
  // models and must be replayed with that call. Reasoning on ordinary
  // assistant turns remains audit-only and is omitted from future requests.
  const blocks = historyBlocks(options.history.map(withoutUnneededHistoricalReasoning));
  const historyTokenLimit = options.promptCache
    ? available
    : Math.min(available, PROACTIVE_HISTORY_TOKEN_LIMIT);
  const rawBlockTokenLimit = options.promptCache
    ? historyTokenLimit
    : RECENT_RAW_BLOCK_TOKEN_LIMIT;
  const selection = selectMandatoryHistory(
    blocks,
    available,
    mandatoryTokens,
    historyTokenLimit,
    rawBlockTokenLimit,
    !options.promptCache
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
    rawBlockTokenLimit
  );

  const omittedBlocks = blocks
    .filter((_block, index) => !selection.selected.has(index))
    .map((block) => block.messages);
  const retainedHistoryTokens = [...selection.selected.values()]
    .reduce((total, messages) => total + blockTokens(messages), 0);
  const summary = summarizeHistory(
    omittedBlocks,
    Math.min(available - used, Math.max(0, historyTokenLimit - retainedHistoryTokens))
  );
  if (summary) included.push(summary);
  const retainedHistory = [...selection.selected.entries()]
    .sort(([left], [right]) => left - right)
    .flatMap(([, messages]) => messages);
  const layout = arrangeMessages(mandatory, included, summary, retainedHistory, options.promptCache);
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
      historyTokens: blockTokens(retainedHistory) + (summary?.tokenCount ?? 0)
    }
  };
}
