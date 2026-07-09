import type { AgentEventEnvelope, AgentEventType, ContextAuthority, ToolDescriptor } from "agent-protocol";
import type { RuntimeSession } from "./types.js";

interface RecoveryOptions {
  descriptors: readonly ToolDescriptor[];
  emit(
    type: AgentEventType,
    authority: Exclude<ContextAuthority, "external_verifier">,
    payload: unknown
  ): Promise<AgentEventEnvelope>;
  start(): void;
}

export async function recoverInterruptedSession(session: RuntimeSession, options: RecoveryOptions): Promise<void> {
  if (session.state.phase === "terminal") return;
  if (session.state.phase === "model_in_flight") {
    await options.emit("diagnostic", "runtime", {
      kind: "recovery.retry_model",
      message: "Retrying an interrupted model attempt from the last durable boundary."
    });
  }
  for (const pending of [...session.state.pendingTools]) {
    const descriptor = options.descriptors.find((item) => item.name === pending.request.name);
    if (pending.approval === "pending") {
      session.approvals.set(pending.request.callId, {
        effects: descriptor?.possibleEffects ?? [], recovered: true, resolve: () => undefined
      });
      continue;
    }
    if (!pending.started) continue;
    if (descriptor?.idempotent) {
      await options.emit("diagnostic", "runtime", {
        kind: "recovery.reset_tool", callId: pending.request.callId, approval: "not_required"
      });
      continue;
    }
    await options.emit("diagnostic", "runtime", {
      kind: "recovery.reset_tool", callId: pending.request.callId, approval: "pending"
    });
    await options.emit("tool.approval_requested", "runtime", {
      requestId: pending.request.callId,
      callId: pending.request.callId,
      toolName: pending.request.name,
      effects: descriptor?.possibleEffects ?? [],
      reason: "The process stopped during a non-idempotent tool call. Explicit approval is required before retrying."
    });
    await options.emit("run.suspended", "runtime", {
      requestId: pending.request.callId,
      message: `Decide whether to retry interrupted tool '${pending.request.name}'.`
    });
    session.approvals.set(pending.request.callId, {
      effects: descriptor?.possibleEffects ?? [], recovered: true, resolve: () => undefined
    });
  }
  if (["ready_model", "tool_pending", "outcome_pending"].includes(session.state.phase)) options.start();
}
