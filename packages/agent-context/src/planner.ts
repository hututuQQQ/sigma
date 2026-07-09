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
}

export interface PlanContextOptions {
  system: ContextItem[];
  history: ModelMessage[];
  dynamic: ContextItem[];
  tools: ModelToolDefinition[];
  contextWindowTokens: number;
  outputReserveTokens: number;
}

function messageTokens(message: ModelMessage): number {
  return approximateTokens(message.content) + approximateTokens(JSON.stringify(message.toolCalls ?? [])) + 6;
}

function toolTokens(tools: ModelToolDefinition[]): number {
  return tools.reduce((total, tool) => total + approximateTokens(JSON.stringify(tool)) + 8, 0);
}

function historyTurns(history: ModelMessage[]): ModelMessage[][] {
  const turns: ModelMessage[][] = [];
  for (const message of history) {
    if (message.role === "user" || turns.length === 0) turns.push([]);
    turns[turns.length - 1].push(message);
  }
  return turns;
}

function turnTokens(turn: ModelMessage[]): number {
  return turn.reduce((total, message) => total + messageTokens(message), 0);
}

function contextRole(item: ContextItem): ModelMessage["role"] {
  if (item.authority === "system") return "system";
  if (item.authority === "developer" || item.authority === "project" || item.authority === "runtime") return "developer";
  return "user";
}

function overflow(message: string): Error {
  return Object.assign(new Error(message), { code: "context_overflow" });
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
  const included: ContextItem[] = [...mandatory];
  const omitted: ContextItem[] = [];
  const turns = historyTurns(options.history);
  const retainedTurns: ModelMessage[][] = [];
  let historyTokens = 0;
  let oldestRetained = turns.length;
  const newest = turns.at(-1);
  if (newest) {
    const newestTokens = turnTokens(newest);
    if (mandatoryTokens + newestTokens > available) {
      throw overflow(`Mandatory context and the newest user turn require ${mandatoryTokens + newestTokens} tokens but only ${available} context tokens are available.`);
    }
    retainedTurns.unshift(newest);
    historyTokens += newestTokens;
    oldestRetained = turns.length - 1;
  }
  let used = mandatoryTokens + historyTokens;
  const summaryReserve = turns.length > 1 ? Math.min(1_024, Math.floor(available * 0.05)) : 0;
  const fitLimit = Math.max(used, available - summaryReserve);
  for (const item of candidates) {
    if (used + item.tokenCount <= fitLimit) {
      included.push(item);
      used += item.tokenCount;
    } else {
      omitted.push(item);
    }
  }
  for (let index = turns.length - 2; index >= 0; index -= 1) {
    const count = turnTokens(turns[index]);
    if (used + count > fitLimit) break;
    retainedTurns.unshift(turns[index]);
    oldestRetained = index;
    historyTokens += count;
    used += count;
  }
  const retainedHistory = retainedTurns.flat();
  const omittedTurns = turns.slice(0, oldestRetained);
  const summary = summarizeHistory(omittedTurns, available - used);
  if (summary) included.push(summary);
  const contextMessages: ModelMessage[] = included.map((item) => ({
    role: contextRole(item),
    content: `[${item.provenance}]\n${item.content}`
  }));
  const dynamicTokens = included.slice(mandatory.length).reduce((total, item) => total + item.tokenCount, 0);
  return {
    messages: [...contextMessages, ...retainedHistory],
    included,
    omitted,
    ...(summary ? { summary } : {}),
    omittedHistoryTurns: omittedTurns.length,
    budget: {
      contextWindowTokens: options.contextWindowTokens,
      outputReserveTokens: options.outputReserveTokens,
      toolTokens: toolCount,
      systemTokens: mandatoryTokens,
      dynamicTokens,
      historyTokens
    }
  };
}
