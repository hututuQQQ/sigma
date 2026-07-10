import { randomUUID } from "node:crypto";
import { loadNestedInstructions } from "agent-context";
import type { AgentEventEnvelope, AgentEventType, ContextAuthority, JsonValue, RunCommand, RunOutcome, RuntimeClient, SessionOverview, SessionRef, StartSession } from "agent-protocol";
import { evolve } from "agent-kernel";
import { ContentAddressedArtifactStore } from "agent-store";
import { EffectRunner } from "./effect-runner.js";
import { jsonValue } from "./json.js";
import { newRuntimeSession } from "./new-runtime-session.js";
import { baseContext } from "./runtime-context.js";
import { persistRuntimeSnapshot } from "./runtime-snapshot.js";
import { beginNextRun, recoveryDenialPayload } from "./run-transitions.js";
import { recoverInterruptedSession } from "./session-recovery.js";
import { restoreStoredSession } from "./restore-session.js";
import { SessionCommandBus } from "./session-command-bus.js";
import { storedSessionOverview } from "./session-overview.js";
import { streamSessionEvents } from "./runtime-stream.js";
import {
  resolveOutcomeWaiters,
  settleIdleWaiters,
  waitForSessionIdleOutcome,
  waitForSessionOutcome
} from "./runtime-waiters.js";
import type { RuntimeOptions, RuntimeSession } from "./types.js";
export class InProcessRuntimeClient implements RuntimeClient {
  private readonly sessions = new Map<string, RuntimeSession>();
  private readonly emitQueues = new Map<string, Promise<void>>();
  private readonly artifacts: ContentAddressedArtifactStore;
  private readonly effects: EffectRunner;
  private readonly runDeadlineMs: number;
  private readonly commandBus: SessionCommandBus;

  constructor(private readonly options: RuntimeOptions & { storeRootDir: string }) {
    this.artifacts = new ContentAddressedArtifactStore(options.storeRootDir);
    this.runDeadlineMs = options.runDeadlineMs ?? 900_000;
    this.commandBus = new SessionCommandBus(options.storeRootDir, async (command) => await this.command(command));
    this.effects = new EffectRunner({
      runtime: options,
      maxParallelTools: options.maxParallelTools ?? 4,
      permissionMode: options.permissionMode ?? "ask",
      outputReserveTokens: options.outputReserveTokens ?? Math.min(8_192, options.gateway.capabilities.maxOutputTokens),
      emit: async (session, type, authority, value) => await this.emit(session, type, authority, value),
      finish: async (session, outcome, outcomeRevision) => await this.finish(session, outcome, outcomeRevision),
      createArtifact: async (sessionId, content) => await this.artifacts.put(sessionId, content)
    });
  }
  async createSession(input: StartSession): Promise<SessionRef> {
    const session = await newRuntimeSession(input, this.runDeadlineMs);
    this.sessions.set(session.sessionId, session);
    await this.commandBus.claim(session.sessionId);
    try {
      await this.emit(session, "session.created", "runtime", {
        workspacePath: session.workspacePath,
        mode: input.mode,
        title: input.title ?? "",
        writeScope: session.writeScope,
        strictWriteScope: session.strictWriteScope
      });
    } catch (error) {
      this.sessions.delete(session.sessionId);
      await this.commandBus.release(session.sessionId);
      throw error;
    }
    return { sessionId: session.sessionId, runId: session.runId };
  }
  async command(command: RunCommand): Promise<void> {
    if (command.type === "resume") return await this.handleResume(command);
    const session = this.required(command.sessionId);
    if (command.type === "cancel") return await this.handleCancel(session, command);
    if (command.type === "approve") return await this.handleApproval(session, command);
    if (command.type === "steer") return await this.handleSteer(session, command.text);
    if (command.type === "follow_up") return await this.handleFollowUp(session, command.text);
    await this.handleSubmit(session, command);
  }
  private async handleResume(command: Extract<RunCommand, { type: "resume" }>): Promise<void> {
    await this.commandBus.claim(command.sessionId);
    try {
      await this.resume(command.sessionId);
      if (this.sessions.get(command.sessionId)?.state.phase === "terminal") await this.commandBus.release(command.sessionId);
    } catch (error) {
      await this.commandBus.release(command.sessionId);
      throw error;
    }
  }
  private async handleCancel(session: RuntimeSession, command: Extract<RunCommand, { type: "cancel" }>): Promise<void> {
    const reason = command.reason ?? "Cancelled by user.";
    session.controller?.abort(new Error(reason));
    for (const approval of session.approvals.values()) approval.resolve("deny");
    await this.options.cancelChildren?.(session.sessionId, reason);
    if (!session.running && session.state.phase !== "terminal") await this.finish(session, { kind: "cancelled", reason });
  }
  private async handleApproval(session: RuntimeSession, command: Extract<RunCommand, { type: "approve" }>): Promise<void> {
    const approval = session.approvals.get(command.requestId);
    const pendingTool = session.state.pendingTools.find((item) => item.request.callId === command.requestId);
    if (!approval || !pendingTool) throw new Error(`Unknown approval '${command.requestId}'.`);
    session.approvals.delete(command.requestId);
    if (command.decision === "always_allow") session.alwaysAllowedEffects.add(approval.effects.slice().sort().join("\0"));
    await this.emit(session, "tool.approval_resolved", "user", {
      requestId: command.requestId,
      callId: command.requestId,
      decision: command.decision,
      ...pendingTool.modelTurn
    });
    approval.resolve(command.decision);
    if (approval.recovered && command.decision === "deny") {
      await this.emit(
        session,
        "tool.failed",
        "runtime",
        recoveryDenialPayload(command.requestId, pendingTool.modelTurn)
      );
    }
    if (!session.running && session.state.phase !== "terminal") {
      session.lastOutcome = undefined;
      this.startRun(session);
    }
  }
  private async handleSteer(session: RuntimeSession, text: string): Promise<void> {
    if (session.steeringPending >= 256) throw new Error("Steering queue is full (256 messages).");
    session.steeringPending += 1;
    try {
      await this.emit(session, "user.steer", "user", { text });
      const reason = Object.assign(new Error("Active model/tool turn was superseded by user steering."), {
        code: "steering_restart"
      });
      session.turnController?.abort(reason);
    } finally {
      session.steeringPending -= 1;
    }
  }

  private async handleFollowUp(session: RuntimeSession, text: string): Promise<void> {
    if (session.followUps.length >= 256) throw new Error("Follow-up queue is full (256 messages).");
    if (session.running) {
      const followUp = { id: randomUUID(), text };
      await this.emit(session, "user.follow_up", "user", { text, queueId: followUp.id, status: "queued" });
      session.followUps.push(followUp);
      return;
    }
    if (session.state.phase === "terminal") {
      await this.commandBus.claim(session.sessionId);
      beginNextRun(session, session.mode, this.runDeadlineMs);
    } else if (session.state.phase === "needs_input") {
      await this.commandBus.claim(session.sessionId);
      session.lastOutcome = undefined;
    }
    await this.emit(session, "run.started", "runtime", { mode: session.mode, deadlineAt: session.state.deadlineAt });
    await this.emit(session, "user.follow_up", "user", { text, queueId: randomUUID(), status: "delivered" });
    this.startRun(session);
  }

  private async handleSubmit(session: RuntimeSession, command: Extract<RunCommand, { type: "submit" }>): Promise<void> {
    if (session.running && session.state.phase === "terminal") await session.running;
    if (session.running) {
      await this.handleSteer(session, command.text);
      return;
    }
    if (session.state.phase === "terminal") {
      await this.commandBus.claim(session.sessionId);
      beginNextRun(session, command.mode ?? session.mode, this.runDeadlineMs);
    } else if (session.state.phase === "needs_input") {
      await this.commandBus.claim(session.sessionId);
      session.lastOutcome = undefined;
    }
    await this.emit(session, "run.started", "runtime", { mode: session.mode, deadlineAt: session.state.deadlineAt });
    await this.emit(session, "user.message", "user", { text: command.text });
    this.startRun(session);
  }

  subscribe(sessionId: string, signal?: AbortSignal): AsyncIterable<AgentEventEnvelope> {
    return streamSessionEvents(this.options.store, this.sessions.get(sessionId), sessionId, signal);
  }

  async waitForOutcome(sessionId: string, signal?: AbortSignal): Promise<RunOutcome> {
    return await waitForSessionOutcome(this.required(sessionId), signal);
  }

  async waitForIdleOutcome(sessionId: string, signal?: AbortSignal): Promise<RunOutcome> {
    const session = this.required(sessionId);
    return await waitForSessionIdleOutcome(
      session,
      async (idleSignal) => await this.effects.waitForQuiescence(sessionId, idleSignal),
      signal
    );
  }

  async waitForQuiescence(sessionId: string, signal?: AbortSignal): Promise<void> { this.required(sessionId); await this.effects.waitForQuiescence(sessionId, signal); }
  async listSessions(limit = 20): Promise<SessionOverview[]> {
    const stored = (await this.options.store.listSessions()).slice(0, Math.max(1, limit));
    return await Promise.all(stored.map(async (item) => await storedSessionOverview(this.options.store, item)));
  }

  sessionEvents(sessionId: string, afterSeq = 0): AsyncIterable<AgentEventEnvelope> {
    return this.options.store.events(sessionId, afterSeq);
  }

  async recordChildEvent(
    parentSessionId: string,
    type: "child.spawned" | "child.message" | "child.completed",
    payload: JsonValue
  ): Promise<void> {
    await this.emit(this.required(parentSessionId), type, "runtime", payload);
  }

  private async run(session: RuntimeSession): Promise<void> {
    const controller = new AbortController();
    session.controller = controller;
    const remainingMs = Date.parse(session.state.deadlineAt) - Date.now();
    if (remainingMs <= 0) {
      await this.finish(session, {
        kind: "recoverable_failure",
        code: "budget_exhausted",
        message: `Run deadline ${session.state.deadlineAt} has already elapsed.`
      });
      session.controller = null;
      return;
    }
    session.deadlineTimer = setTimeout(() => {
      const error = new Error(`Run exceeded its durable deadline ${session.state.deadlineAt}.`);
      error.name = "TimeoutError";
      controller.abort(error);
    }, remainingMs);
    try {
      await this.effects.run(session, controller.signal);
    } catch (error) {
      if (controller.signal.aborted) {
        const reason = controller.signal.reason instanceof Error ? controller.signal.reason : new Error("Run cancelled.");
        const outcome: RunOutcome = reason.name === "TimeoutError"
          ? { kind: "recoverable_failure", code: "budget_exhausted", message: reason.message }
          : { kind: "cancelled", reason: reason.message };
        await this.finish(session, outcome);
      } else {
        const code = typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : "runtime_error";
        await this.finish(session, { kind: "recoverable_failure", code, message: error instanceof Error ? error.message : String(error) });
      }
    } finally {
      if (session.deadlineTimer) clearTimeout(session.deadlineTimer);
      session.deadlineTimer = null;
      session.controller = null;
    }
  }

  private async finish(session: RuntimeSession, outcome: RunOutcome, outcomeRevision?: number): Promise<boolean> {
    const type: AgentEventType = outcome.kind === "completed" ? "run.completed"
      : outcome.kind === "cancelled" ? "run.cancelled"
        : outcome.kind === "needs_input" ? "run.suspended" : "run.failed";
    const event = outcomeRevision === undefined
      ? await this.emit(session, type, "runtime", outcome)
      : await this.emitOutcomeIfCurrent(session, type, outcome, outcomeRevision);
    const committed = outcome.kind === "needs_input"
      ? session.state.phase === "needs_input"
      : session.state.phase === "terminal";
    if (!event || session.state.lastSeq !== event.seq || !committed) return false;
    if (outcome.kind !== "completed") {
      await this.options.cancelChildren?.(session.sessionId, `Parent run ended as ${outcome.kind}.`);
    }
    session.lastOutcome = outcome;
    await this.writeSnapshot(session);
    if (session.followUps.length === 0) await this.commandBus.release(session.sessionId);
    resolveOutcomeWaiters(session, event.runId, outcome);
    return true;
  }

  private async emitOutcomeIfCurrent(
    session: RuntimeSession,
    type: AgentEventType,
    outcome: RunOutcome,
    outcomeRevision: number
  ): Promise<AgentEventEnvelope | undefined> {
    const previous = this.emitQueues.get(session.sessionId) ?? Promise.resolve();
    let emitted: AgentEventEnvelope | undefined;
    const current = previous.then(async () => {
      if (session.state.phase !== "outcome_pending" || session.state.revision !== outcomeRevision) return;
      emitted = await this.emitLocked(session, type, "runtime", { ...outcome, outcomeRevision });
    });
    this.emitQueues.set(session.sessionId, current.catch(() => undefined));
    await current;
    return emitted;
  }

  private async emit(
    session: RuntimeSession,
    type: AgentEventType,
    authority: Exclude<ContextAuthority, "external_verifier">,
    value: unknown
  ): Promise<AgentEventEnvelope> {
    const previous = this.emitQueues.get(session.sessionId) ?? Promise.resolve();
    let emitted!: AgentEventEnvelope;
    const current = previous.then(async () => {
      emitted = await this.emitLocked(session, type, authority, value);
    });
    this.emitQueues.set(session.sessionId, current.catch(() => undefined));
    await current;
    return emitted;
  }

  private async emitLocked(
    session: RuntimeSession,
    type: AgentEventType,
    authority: Exclude<ContextAuthority, "external_verifier">,
    value: unknown
  ): Promise<AgentEventEnvelope> {
    const expectedSeq = session.seq;
    const event: AgentEventEnvelope = {
      schemaVersion: 2,
      seq: expectedSeq + 1,
      eventId: randomUUID(),
      sessionId: session.sessionId,
      runId: session.runId,
      occurredAt: new Date().toISOString(),
      type,
      authority,
      payload: jsonValue(value)
    };
    const append = await this.options.store.append(event, expectedSeq);
    session.seq = event.seq;
    session.state = evolve(session.state, event);
    for (const subscriber of session.subscribers) subscriber.push(event);
    if (append.rotated || event.seq % 250 === 0) await this.writeSnapshot(session);
    return event;
  }

  private async writeSnapshot(session: RuntimeSession): Promise<void> {
    await persistRuntimeSnapshot(this.options.store, session);
  }

  private async resume(sessionId: string): Promise<void> {
    if (this.sessions.has(sessionId)) return;
    const restored = await restoreStoredSession(this.options.store, sessionId, this.runDeadlineMs);
    const { workspacePath, state, modelTurn, lastSeq, followUps, writeScope, strictWriteScope, contextItems } = restored;
    const project = await loadNestedInstructions({ workspacePath });
    const base = baseContext();
    const session: RuntimeSession = {
      sessionId, runId: state.runId, modelTurn,
      workspacePath, mode: state.mode, writeScope, strictWriteScope, state, seq: lastSeq,
      controller: null, turnController: null, deadlineTimer: null, running: null, subscribers: new Set(), approvals: new Map(),
      alwaysAllowedEffects: new Set(), steeringPending: 0, followUps, contextItems: [...base, ...project, ...contextItems],
      loadedContextIds: new Set([...base, ...project, ...contextItems].map((item) => item.id)), outcomeWaiters: [], idleWaiters: [], lastOutcome: state.outcome
    };
    this.sessions.set(sessionId, session);
    await this.recoverSession(session);
  }

  private async recoverSession(session: RuntimeSession): Promise<void> {
    await recoverInterruptedSession(session, {
      descriptors: this.options.tools.descriptors(),
      emit: async (type, authority, payload) => await this.emit(session, type, authority, payload),
      start: () => this.startRun(session)
    });
  }

  private required(sessionId: string): RuntimeSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown session '${sessionId}'.`);
    return session;
  }

  private startRun(session: RuntimeSession): void {
    if (session.running) return;
    session.runError = undefined;
    const task = this.drainRuns(session);
    session.running = task;
    void task.then(
      async () => await this.settleRunTask(session, task),
      async (error) => await this.settleRunTask(session, task, error)
    ).catch(() => undefined);
  }

  private async drainRuns(session: RuntimeSession): Promise<void> {
    while (true) {
      await this.run(session);
      const next = session.followUps.shift();
      if (!next) return;
      try {
        await this.commandBus.claim(session.sessionId);
        beginNextRun(session, session.mode, this.runDeadlineMs);
        await this.emit(session, "run.started", "runtime", { mode: session.mode, deadlineAt: session.state.deadlineAt });
        await this.emit(session, "user.follow_up", "user", { text: next.text, queueId: next.id, status: "delivered" });
      } catch (error) {
        if (session.state.phase === "terminal") beginNextRun(session, session.mode, this.runDeadlineMs);
        await this.finish(session, {
          kind: "recoverable_failure",
          code: "follow_up_handoff_failed",
          message: error instanceof Error ? error.message : String(error)
        });
        return;
      }
    }
  }

  private async settleRunTask(session: RuntimeSession, task: Promise<void>, error?: unknown): Promise<void> {
    await this.effects.waitForQuiescence(session.sessionId).catch(() => undefined);
    if (session.running !== task) return;
    session.running = null;
    settleIdleWaiters(session, error);
  }
}
