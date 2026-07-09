import type { JsonValue, RunMode, ToolEffect } from "agent-protocol";
import type { ChildAgentContext, ChildAgentFactory } from "agent-supervisor";
import type { InProcessRuntimeClient } from "./runtime-client.js";

function childMode(metadata: JsonValue): RunMode {
  const values = metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? metadata as Record<string, JsonValue> : {};
  return values.mode === "change" ? "change" : "analyze";
}

function childInstruction(context: ChildAgentContext): string {
  if (context.writeScope.length === 0) return context.instruction;
  return `${context.instruction}\n\nWrite scope: only modify ${context.writeScope.join(", ")}.`;
}

async function forwardMailbox(context: ChildAgentContext, runtime: InProcessRuntimeClient, sessionId: string): Promise<void> {
  for await (const message of context.mailbox) {
    if (message.type === "cancel") await runtime.command({ type: "cancel", sessionId, reason: message.text });
    else if (message.text) await runtime.command({ type: "follow_up", sessionId, text: message.text });
  }
}

async function forwardChildEvents(
  context: ChildAgentContext,
  runtime: InProcessRuntimeClient,
  sessionId: string,
  signal: AbortSignal
): Promise<void> {
  for await (const event of runtime.subscribe(sessionId, signal)) {
    if (event.type !== "tool.approval_requested" || !event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) continue;
    const payload = event.payload as Record<string, JsonValue>;
    if (typeof payload.requestId !== "string") continue;
    const effects = Array.isArray(payload.effects)
      ? payload.effects.filter((effect): effect is ToolEffect => typeof effect === "string") : [];
    const delegated = new Set(context.delegatedEffects);
    const decision = effects.every((effect) => delegated.has(effect)) ? "allow" : "deny";
    await context.notify({
      kind: "delegated_approval_resolved",
      childSessionId: sessionId,
      requestId: payload.requestId,
      toolName: typeof payload.toolName === "string" ? payload.toolName : "tool",
      reason: typeof payload.reason === "string" ? payload.reason : "",
      effects,
      decision,
      policy: decision === "allow"
        ? "The parent explicitly granted these effects when approving the child spawn."
        : "The child requested effects outside its delegated capability set."
    });
    await runtime.command({ type: "approve", sessionId, requestId: payload.requestId, decision });
  }
}

export function createChildAgentFactory(runtimeProvider: () => InProcessRuntimeClient): ChildAgentFactory {
  return async (context) => {
    const runtime = runtimeProvider();
    const mode = childMode(context.metadata);
    const child = await runtime.createSession({
      workspacePath: context.workspacePath,
      mode,
      title: context.instruction.slice(0, 80),
      writeScope: context.writeScope,
      strictWriteScope: mode === "change" && context.isolation.kind === "exclusive_workspace"
    });
    await context.started(child.sessionId);
    const eventController = new AbortController();
    const childEvents = forwardChildEvents(context, runtime, child.sessionId, eventController.signal);
    const onAbort = (): void => { void runtime.command({ type: "cancel", sessionId: child.sessionId, reason: "Parent cancelled child." }); };
    context.signal.addEventListener("abort", onAbort, { once: true });
    void forwardMailbox(context, runtime, child.sessionId);
    try {
      await runtime.command({ type: "submit", sessionId: child.sessionId, text: childInstruction(context), mode });
      const outcome = await runtime.waitForOutcome(child.sessionId, context.signal);
      return {
        childId: context.childId,
        outcome,
        report: {
          sessionId: child.sessionId,
          sourceWorkspacePath: context.sourceWorkspacePath,
          executionWorkspacePath: context.workspacePath,
          isolation: context.isolation.kind
        }
      };
    } finally {
      context.signal.removeEventListener("abort", onAbort);
      eventController.abort();
      await childEvents;
    }
  };
}
