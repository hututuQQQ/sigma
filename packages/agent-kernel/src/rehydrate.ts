import type { AgentEventEnvelope } from "agent-protocol";
import { evolve } from "./reducer.js";
import type { KernelState } from "./state.js";

export function rehydrate(initial: KernelState, events: Iterable<AgentEventEnvelope>): KernelState {
  let state = initial;
  for (const event of events) state = evolve(state, event);
  return state;
}

export function assertKernelInvariants(state: KernelState): void {
  const callIds = state.pendingTools.map((item) => item.request.callId);
  if (new Set(callIds).size !== callIds.length) throw new Error("Duplicate pending tool call IDs.");
  if (state.phase === "terminal" && !state.outcome) throw new Error("Terminal kernel state requires an outcome.");
  if (state.phase !== "terminal" && state.outcome?.kind !== "needs_input") {
    if (state.outcome) throw new Error("Non-terminal kernel state cannot have a terminal outcome.");
  }
}
