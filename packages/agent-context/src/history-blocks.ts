import { createHash } from "node:crypto";
import type { ModelMessage } from "agent-protocol";
import { approximateTokens } from "./unicode.js";

export interface HistoryBlock {
  messages: ModelMessage[];
  wireSafe: boolean;
}

export function messageTokens(message: ModelMessage): number {
  return approximateTokens(message.content)
    + approximateTokens(message.reasoningContent ?? "")
    + approximateTokens(JSON.stringify(message.toolCalls ?? []))
    + 6;
}

export function withoutUnneededHistoricalReasoning(message: ModelMessage): ModelMessage {
  if (message.reasoningContent === undefined || (message.toolCalls?.length ?? 0) > 0) {
    return message;
  }
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

export function compactHistoryFallback(
  block: HistoryBlock,
  maximumTokens: number
): ModelMessage[] | undefined {
  const empty: ModelMessage = { role: "assistant", content: "" };
  const contentOverhead = messageTokens(empty) - approximateTokens(empty.content);
  if (maximumTokens < messageTokens(empty)) return undefined;
  const observations = block.messages
    .filter((message) => message.role === "tool")
    .map((message, index) => `Observation ${index + 1}:\n${message.content}`)
    .join("\n\n");
  const explanation = `A ${block.messages.length}-message history block was omitted because it could not be represented within the context budget without breaking tool-call protocol. Re-inspect the relevant state if needed.`;
  const observationSummary = observations.length > 0
    ? `${explanation}\nThe following is a non-executable observation summary; it is not a tool call and contains no call arguments:\n${observations}`
    : explanation;
  const compacted: ModelMessage = {
    role: "assistant",
    content: fitText(observationSummary, maximumTokens - contentOverhead)
  };
  return messageTokens(compacted) <= maximumTokens ? [compacted] : [empty];
}

export function compactHistoryBlock(
  block: HistoryBlock,
  maximumTokens: number
): ModelMessage[] | undefined {
  if (!block.wireSafe) return compactHistoryFallback(block, maximumTokens);
  if (block.messages.some((message) =>
    (message.toolCalls?.length ?? 0) > 0 || message.role === "tool")) {
    return compactHistoryFallback(block, maximumTokens);
  }
  const compacted = block.messages.map((message) => ({
    ...message,
    content: fitText(message.content, Math.max(0, maximumTokens - 6))
  }));
  return blockTokens(compacted) <= maximumTokens
    ? compacted
    : compactHistoryFallback(block, maximumTokens);
}
