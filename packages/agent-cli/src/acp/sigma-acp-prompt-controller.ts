import * as acp from "@agentclientprotocol/sdk";
import {
  cancellationReason,
  cancelResolvedSession
} from "./sigma-acp-cancellation.js";
import { SigmaAcpEventForwarder } from "./sigma-acp-events.js";
import { SigmaAcpSessionRegistry } from "./sigma-acp-session-registry.js";
import {
  SIGMA_RUNTIME_REQUEST_ERROR,
  expectedAbort,
  promptContent,
  promptResponseForOutcome,
  titleFromPrompt,
  type ForwardState,
  type ResolvedSession,
  type SigmaAcpAgentOptions,
  type SigmaPromptContent,
  type SigmaRollbackCommand,
  type SigmaTextCommand
} from "./sigma-acp-shared.js";

interface ActivePrompt {
  readonly controller: AbortController;
  readonly settled: Promise<void>;
  readonly settle: () => void;
}

function createActivePrompt(): ActivePrompt {
  const controller = new AbortController();
  let settlePrompt!: () => void;
  return {
    controller,
    settled: new Promise<void>((resolve) => {
      settlePrompt = resolve;
    }),
    settle: () => settlePrompt()
  };
}

class CheckpointRecoveryCancelled extends Error {}

function checkpointRecoveryDecision(
  response: acp.RequestPermissionResponse
): "keep" | "restore" | undefined {
  if (response.outcome.outcome !== "selected") return undefined;
  if (response.outcome.optionId === "keep" || response.outcome.optionId === "restore") {
    return response.outcome.optionId;
  }
  throw new Error(`Unknown checkpoint recovery option '${response.outcome.optionId}'.`);
}

export class SigmaAcpPromptController {
  private readonly activePrompts = new Map<string, ActivePrompt>();
  private readonly activeRuntimeSessions = new Map<string, ResolvedSession>();

  constructor(
    private readonly options: SigmaAcpAgentOptions,
    private readonly sessions: SigmaAcpSessionRegistry,
    private readonly events: SigmaAcpEventForwarder
  ) {}

  hasActivePrompt(sessionId: string): boolean {
    return this.activePrompts.has(sessionId);
  }

  activeRuntimeSession(sessionId: string): ResolvedSession | undefined {
    return this.activeRuntimeSessions.get(sessionId);
  }

  abortPrompt(sessionId: string, reason: Error): void {
    this.activePrompts.get(sessionId)?.controller.abort(reason);
  }

  async close(): Promise<void> {
    for (const { controller } of this.activePrompts.values()) {
      controller.abort(new Error("ACP connection closed."));
    }
    const cancellations = await Promise.allSettled(
      [...this.activeRuntimeSessions.values()].map(async (resolved) =>
        await cancelResolvedSession(resolved, "ACP connection closed."))
    );
    for (const result of cancellations) {
      if (result.status === "rejected") this.log(result.reason);
    }
    this.activePrompts.clear();
    this.activeRuntimeSessions.clear();
  }

  async prompt(
    params: acp.PromptRequest,
    client: acp.AgentContext,
    signal: AbortSignal
  ): Promise<acp.PromptResponse> {
    const content = promptContent(params.prompt);
    const activeResponse = await this.waitForPromptSlot(params.sessionId, content, signal);
    if (activeResponse) return activeResponse;
    const activePrompt = createActivePrompt();
    const { controller } = activePrompt;
    this.activePrompts.set(params.sessionId, activePrompt);
    let resolved: ResolvedSession | undefined;
    let forwarding: Promise<void> | undefined;
    const onRequestAbort = (): void => {
      controller.abort(signal.reason ?? new Error("ACP prompt request cancelled."));
      if (resolved) {
        void cancelResolvedSession(resolved, "ACP prompt request cancelled.")
          .catch((error: unknown) => this.log(error));
      }
    };
    if (signal.aborted) onRequestAbort();
    else signal.addEventListener("abort", onRequestAbort, { once: true });
    try {
      const promptSession = await this.sessions.resolveSession(params.sessionId);
      resolved = promptSession;
      await this.ensureImageInputSupported(promptSession, content);
      this.activeRuntimeSessions.set(params.sessionId, promptSession);
      await this.sessions.ensureAttached(promptSession);
      controller.signal.throwIfAborted();
      const state: ForwardState = { modelText: new Map(), reasoningText: new Map() };
      forwarding = this.events.forwardLive(promptSession, client, state, controller.signal);
      void forwarding.catch(() => undefined);
      await this.resolveCheckpointRecovery(promptSession, client, controller.signal);
      await this.dispatchPrompt(promptSession, content, controller.signal);
      const outcome = await Promise.race([
        this.waitForPromptOutcome(
          promptSession,
          client,
          state,
          forwarding,
          controller.signal
        ),
        forwarding.then(() => {
          throw new Error("Sigma Runtime event stream ended before the run outcome.");
        })
      ]);
      await this.waitForForwardedOutcome(promptSession, forwarding, controller.signal);
      controller.abort(new Error("Sigma Runtime turn completed."));
      await forwarding.catch((error: unknown) => {
        if (!expectedAbort(error, controller.signal)) throw error;
      });
      resolved.record.updatedAt = new Date().toISOString();
      await this.sessions.upsert(resolved.handle.storeRootDir, resolved.record);
      return promptResponseForOutcome(outcome);
    } catch (error) {
      return await this.promptFailureResponse(error, resolved, controller);
    } finally {
      signal.removeEventListener("abort", onRequestAbort);
      if (this.activePrompts.get(params.sessionId) === activePrompt) {
        this.activePrompts.delete(params.sessionId);
        this.activeRuntimeSessions.delete(params.sessionId);
      }
      if (!controller.signal.aborted) controller.abort(new Error("Sigma ACP prompt finished."));
      if (forwarding) {
        await forwarding.catch((error: unknown) => {
          if (!expectedAbort(error, controller.signal)) this.log(error);
        });
      }
      activePrompt.settle();
    }
  }

  async cancel(params: acp.CancelNotification): Promise<void> {
    this.abortPrompt(params.sessionId, new Error("Cancelled by ACP client."));
    const resolved = this.activeRuntimeSessions.get(params.sessionId)
      ?? await this.sessions.resolveSession(params.sessionId);
    await this.sessions.ensureAttached(resolved);
    await cancelResolvedSession(resolved, "Cancelled by ACP client.");
  }

  async steer(params: SigmaTextCommand): Promise<object> {
    const resolved = await this.sessions.resolveSession(params.sessionId);
    await this.sessions.ensureAttached(resolved);
    await resolved.handle.runtime.command({
      type: "steer",
      sessionId: resolved.record.runtimeSessionId,
      text: params.text
    });
    return {};
  }

  async rollback(params: SigmaRollbackCommand): Promise<object> {
    if (this.activePrompts.has(params.sessionId)) {
      throw new Error("Cannot rollback a Sigma session while a prompt is active.");
    }
    const resolved = await this.sessions.resolveSession(params.sessionId);
    await this.sessions.ensureAttached(resolved);
    if (!resolved.handle.runtime.rollbackTurns) {
      throw new Error("This Sigma runtime does not support conversation rollback.");
    }
    const result = await resolved.handle.runtime.rollbackTurns(
      resolved.record.runtimeSessionId,
      params.numTurns
    );
    resolved.record.lastSeq = Math.max(resolved.record.lastSeq, result.lastSeq);
    resolved.record.updatedAt = new Date().toISOString();
    await this.sessions.upsert(resolved.handle.storeRootDir, resolved.record);
    return { removedTurns: result.removedTurns };
  }

  private async dispatchPrompt(
    resolved: ResolvedSession,
    content: SigmaPromptContent,
    signal: AbortSignal
  ): Promise<void> {
    const firstPrompt = !resolved.record.started;
    resolved.record.started = true;
    resolved.record.title ??= titleFromPrompt(content.text || "Image prompt");
    resolved.record.updatedAt = new Date().toISOString();
    await this.sessions.upsert(resolved.handle.storeRootDir, resolved.record);
    signal.throwIfAborted();
    await resolved.handle.runtime.command(firstPrompt
      ? {
          type: "submit",
          sessionId: resolved.record.runtimeSessionId,
          text: content.text,
          ...(content.images.length > 0 ? { images: content.images } : {}),
          mode: resolved.record.mode
        }
      : {
          type: "follow_up",
          sessionId: resolved.record.runtimeSessionId,
          text: content.text,
          ...(content.images.length > 0 ? { images: content.images } : {})
        });
  }

  private async resolveCheckpointRecovery(
    resolved: ResolvedSession,
    client: acp.AgentContext,
    signal: AbortSignal
  ): Promise<boolean> {
    const recovery = await resolved.handle.runtime.pendingCheckpointRecovery?.(
      resolved.record.runtimeSessionId
    );
    if (!recovery) return false;
    const response = await client.request(acp.methods.client.session.requestPermission, {
      sessionId: resolved.record.sessionId,
      toolCall: {
        toolCallId: `checkpoint:${recovery.checkpointId}`,
        title: "Recover interrupted workspace changes",
        name: "checkpoint_recovery",
        kind: "edit",
        status: "pending",
        rawInput: { checkpointId: recovery.checkpointId }
      },
      options: [
        { optionId: "keep", name: "Keep current changes", kind: "allow_once" },
        { optionId: "restore", name: "Restore pre-interruption state", kind: "reject_once" }
      ],
      _meta: {
        "sigma.permission.requiresExplicitDecision": true,
        "sigma.checkpoint.id": recovery.checkpointId
      }
    }, { cancellationSignal: signal });
    const decision = checkpointRecoveryDecision(response);
    if (!decision) throw new CheckpointRecoveryCancelled("Checkpoint recovery was cancelled.");
    await resolved.handle.runtime.command({
      type: "checkpoint_recovery",
      sessionId: resolved.record.runtimeSessionId,
      checkpointId: recovery.checkpointId,
      decision
    });
    await resolved.handle.runtime.command({
      type: "resume",
      sessionId: resolved.record.runtimeSessionId
    });
    return true;
  }

  private async waitForPromptOutcome(
    resolved: ResolvedSession,
    client: acp.AgentContext,
    state: ForwardState,
    forwarding: Promise<void>,
    signal: AbortSignal
  ): Promise<import("agent-protocol").RunOutcome> {
    while (true) {
      const runtime = resolved.handle.runtime;
      const outcome = runtime.waitForIdleOutcome
        ? await runtime.waitForIdleOutcome(resolved.record.runtimeSessionId, signal)
        : await runtime.waitForOutcome(resolved.record.runtimeSessionId, signal);
      if (await this.resolveCheckpointRecovery(resolved, client, signal)) continue;
      if (outcome.kind !== "needs_input") return outcome;
      await this.waitForForwardedOutcome(resolved, forwarding, signal);
      const continuation = state.userInputContinuation;
      if (!continuation) return outcome;
      const continued = await continuation;
      if (state.userInputContinuation === continuation) delete state.userInputContinuation;
      if (!continued) return outcome;
    }
  }

  private async waitForForwardedOutcome(
    resolved: ResolvedSession,
    forwarding: Promise<void>,
    signal: AbortSignal
  ): Promise<void> {
    const overview = (await resolved.handle.runtime.listSessions(Number.MAX_SAFE_INTEGER))
      .find((candidate) => candidate.sessionId === resolved.record.runtimeSessionId);
    const targetSeq = overview?.lastSeq ?? resolved.record.lastSeq;
    const deadline = performance.now() + 5_000;
    while (resolved.record.lastSeq < targetSeq) {
      signal.throwIfAborted();
      if (performance.now() >= deadline) {
        throw new Error(
          `Sigma Runtime event forwarding stopped at ${resolved.record.lastSeq}; expected ${targetSeq}.`
        );
      }
      await Promise.race([
        forwarding.then(() => {
          throw new Error("Sigma Runtime event stream ended before the terminal event was forwarded.");
        }),
        new Promise<void>((resolve) => setTimeout(resolve, 1))
      ]);
    }
  }

  private async steerActivePrompt(
    sessionId: string,
    text: string
  ): Promise<acp.PromptResponse> {
    const resolved = await this.sessions.resolveSession(sessionId);
    await this.sessions.ensureAttached(resolved);
    await resolved.handle.runtime.command({
      type: "steer",
      sessionId: resolved.record.runtimeSessionId,
      text
    });
    return { stopReason: "end_turn", _meta: { "sigma.command": "steer" } };
  }

  private async waitForPromptSlot(
    sessionId: string,
    content: SigmaPromptContent,
    signal: AbortSignal
  ): Promise<acp.PromptResponse | undefined> {
    while (true) {
      const activePrompt = this.activePrompts.get(sessionId);
      if (!activePrompt) return undefined;
      if (!activePrompt.controller.signal.aborted) {
        if (content.images.length > 0) {
          throw new Error("Sigma cannot add images while steering an active prompt.");
        }
        return await this.steerActivePrompt(sessionId, content.text);
      }
      await activePrompt.settled;
      signal.throwIfAborted();
    }
  }

  private async ensureImageInputSupported(
    resolved: ResolvedSession,
    content: SigmaPromptContent
  ): Promise<void> {
    if (content.images.length === 0) return;
    const catalog = await this.options.modelCatalog(resolved.record.cwd);
    const selected = catalog.options.find((option) => option.id === resolved.record.modelId);
    if (selected?.imageInput !== true) {
      throw new Error(`Sigma model '${resolved.record.modelId}' does not support image input.`);
    }
  }

  private async promptFailureResponse(
    error: unknown,
    resolved: ResolvedSession | undefined,
    controller: AbortController
  ): Promise<acp.PromptResponse> {
    if (error instanceof acp.RequestError && error.code === SIGMA_RUNTIME_REQUEST_ERROR) throw error;
    if (error instanceof CheckpointRecoveryCancelled) {
      controller.abort(error);
      return { stopReason: "cancelled" };
    }
    if (!expectedAbort(error, controller.signal)) throw error;
    if (resolved) {
      await cancelResolvedSession(
        resolved,
        cancellationReason(controller.signal, "ACP prompt request cancelled.")
      );
    }
    return { stopReason: "cancelled" };
  }

  private log(error: unknown): void {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    (this.options.stderr ?? process.stderr).write(`[sigma acp] ${message}\n`);
  }
}
