import type { ModelMessage, RunOutcome, ToolRequest } from "agent-protocol";
import type { KernelState } from "./state.js";

export type KernelEffect =
  | { type: "request_model"; revision: number; messages: ModelMessage[] }
  | { type: "request_approval"; revision: number; request: ToolRequest }
  | { type: "execute_tool"; revision: number; request: ToolRequest }
  | { type: "finish_run"; revision: number; outcome: RunOutcome }
  | { type: "publish_outcome"; revision: number };

export function decide(state: KernelState): KernelEffect[] {
  if (state.phase === "terminal") return state.outcome ? [{ type: "publish_outcome", revision: state.revision }] : [];
  if (state.phase === "ready_model") return [{ type: "request_model", revision: state.revision, messages: state.messages }];
  if (state.phase === "outcome_pending" && state.proposedOutcome) {
    return [{ type: "finish_run", revision: state.revision, outcome: state.proposedOutcome }];
  }
  if (state.phase === "tool_pending") {
    return state.pendingTools.flatMap((item): KernelEffect[] => {
      if (item.started || item.approval === "denied" || item.approval === "pending") return [];
      if (item.approval === "not_required") return [{ type: "execute_tool", revision: state.revision, request: item.request }];
      return [{ type: "execute_tool", revision: state.revision, request: item.request }];
    });
  }
  return [];
}

export function isStaleEffect(state: KernelState, effect: KernelEffect): boolean {
  return effect.revision !== state.revision || state.phase === "terminal";
}
