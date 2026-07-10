import type { JsonValue, RunMode, ToolEffect } from "agent-protocol";
import type { ChildAgentContext, ChildAgentFactory } from "agent-supervisor";
import type { InProcessRuntimeClient } from "./runtime-client.js";

const CHILD_CLEANUP_DEADLINE_MS = 5_000;

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

async function waitForSafeChildCleanup(
  context: ChildAgentContext,
  runtime: InProcessRuntimeClient,
  sessionId: string
): Promise<void> {
  const deadline = AbortSignal.timeout(CHILD_CLEANUP_DEADLINE_MS);
  try {
    await runtime.waitForQuiescence(sessionId, deadline);
  } catch (error) {
    if (!deadline.aborted) throw error;
    await context.notify({
      kind: "child.cleanup_wait_exceeded",
      childSessionId: sessionId,
      deadlineMs: CHILD_CLEANUP_DEADLINE_MS,
      policy: "The writer lease remains held until every cancelled operation has actually settled."
    }).catch(() => undefined);
    await runtime.waitForQuiescence(sessionId);
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
    let submit: Promise<void> | undefined;
    let cancellation: Promise<void> | undefined;
    const requestCancellation = (): Promise<void> => {
      cancellation ??= (submit ?? Promise.resolve()).catch(() => undefined).then(async () => {
        await runtime.command({ type: "cancel", sessionId: child.sessionId, reason: "Parent cancelled child." });
      }).catch(async (error) => {
        await context.notify({
          kind: "child.cancel_failed",
          childSessionId: child.sessionId,
          message: error instanceof Error ? error.message : String(error)
        }).catch(() => undefined);
      });
      return cancellation;
    };
    const onAbort = (): void => { void requestCancellation(); };
    context.signal.addEventListener("abort", onAbort, { once: true });
    const mailboxForwarding = forwardMailbox(context, runtime, child.sessionId);
    try {
      if (context.signal.aborted) {
        await requestCancellation();
      } else {
        submit = runtime.command({ type: "submit", sessionId: child.sessionId, text: childInstruction(context), mode });
        await submit;
        if (context.signal.aborted) await requestCancellation();
      }
      await runtime.waitForOutcome(child.sessionId);
      if (context.signal.aborted) await requestCancellation();
      await runtime.waitForIdleOutcome(child.sessionId);
      context.settling();
      await mailboxForwarding;
      const outcome = await runtime.waitForIdleOutcome(child.sessionId);
      await waitForSafeChildCleanup(context, runtime, child.sessionId);
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
      context.settling();
      await mailboxForwarding.catch(() => undefined);
      context.signal.removeEventListener("abort", onAbort);
      eventController.abort();
      await childEvents;
    }
  };
}
