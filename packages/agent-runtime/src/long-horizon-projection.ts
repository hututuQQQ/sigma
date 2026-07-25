import type { LongHorizonStateV2, ModelMessage } from "agent-protocol";

export function strategyRebasedHistory(
  messages: readonly ModelMessage[],
  _state: LongHorizonStateV2
): ModelMessage[] {
  // Strategy state is projected through the bounded incremental runtime frame.
  // Re-slicing history around a moving "last four calls" boundary invalidates
  // the provider cache prefix on every subsequent request. Context pressure is
  // handled by the durable token-driven archive and tool-result pruning paths.
  return [...messages];
}
