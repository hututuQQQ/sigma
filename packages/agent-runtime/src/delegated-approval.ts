import type {
  JsonValue,
  ToolEffect
} from "agent-protocol";
import { abortable } from "./effect-helpers.js";
import type { ApprovalWaiter, RuntimeSession } from "./types.js";
import type { RuntimeEventEmitter } from "./runtime-event-emitter.js";

export interface DelegatedApprovalRequest {
  requestId: string;
  childId: string;
  callId: string;
  toolName: string;
  arguments?: JsonValue;
  effects: ToolEffect[];
  reason: string;
}

/** Raises a sensitive child call to the parent session's actual user. */
export async function requestDelegatedApproval(
  session: RuntimeSession,
  request: DelegatedApprovalRequest,
  signal: AbortSignal,
  emit: RuntimeEventEmitter
): Promise<"allow" | "deny"> {
  if (session.state.phase === "terminal") return "deny";
  if (session.approvals.has(request.requestId)) throw new Error(`Duplicate approval '${request.requestId}'.`);
  let resolve!: (value: "allow" | "deny" | "always_allow") => void;
  const pending = new Promise<"allow" | "deny" | "always_allow">((accept) => { resolve = accept; });
  const waiter: ApprovalWaiter = {
    effects: [...request.effects],
    external: {
      callId: request.callId,
      toolName: request.toolName,
      childId: request.childId
    },
    resolve
  };
  session.approvals.set(request.requestId, waiter);
  let completed = false;
  let requestWasDurable = false;
  try {
    await emit(session, "tool.approval_requested", "runtime", {
      requestId: request.requestId,
      callId: request.callId,
      toolName: request.toolName,
      ...(request.arguments === undefined ? {} : { arguments: request.arguments }),
      childId: request.childId,
      effects: request.effects,
      reason: request.reason,
      delegated: true
    });
    requestWasDurable = true;
    const decision = await abortable(pending, signal);
    completed = true;
    return decision === "deny" ? "deny" : "allow";
  } finally {
    if (!completed && session.approvals.get(request.requestId) === waiter) {
      session.approvals.delete(request.requestId);
      if (requestWasDurable) {
        await emit(session, "tool.approval_resolved", "runtime", {
          requestId: request.requestId,
          callId: request.callId,
          childId: request.childId,
          decision: "cancelled",
          delegated: true
        });
      }
    }
  }
}
