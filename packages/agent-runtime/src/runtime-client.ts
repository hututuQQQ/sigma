import { randomUUID } from "node:crypto";
import path from "node:path";
import type { AgentEventEnvelope, AgentEventType, ContextAuthority, JsonValue, RunCommand, RunOutcome } from "agent-protocol";
import type { RuntimeClient, SessionOverview, SessionRef, StartSession } from "agent-protocol";
import { createKernelState, evolve } from "agent-kernel";
import { loadNestedInstructions } from "agent-context";
import { ContentAddressedArtifactStore } from "agent-store";
import { AsyncQueue } from "./async-queue.js";
import { EffectRunner } from "./effect-runner.js";
import { jsonValue } from "./json.js";
import { baseContext } from "./runtime-context.js";
import { persistRuntimeSnapshot } from "./runtime-snapshot.js";
import { recoverInterruptedSession } from "./session-recovery.js";
import { restoreStoredSession } from "./restore-session.js";
import { SessionCommandBus } from "./session-command-bus.js";
import { storedSessionOverview } from "./session-overview.js";
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
      finish: async (session, outcome) => await this.finish(session, outcome),
      createArtifact: async (sessionId, content) => await this.artifacts.put(sessionId, content)
    });
  }
  async createSession(input: StartSession): Promise<SessionRef> {
    const sessionId = randomUUID();
    const runId = randomUUID();
    const now = new Date().toISOString();
    const state = createKernelState({
      sessionId,
      runId,
      mode: input.mode,
      startedAt: now,
      deadlineAt: new Date(Date.now() + this.runDeadlineMs).toISOString()
    });
    const base = baseContext();
    const project = await loadNestedInstructions({ workspacePath: input.workspacePath });
    const session: RuntimeSession = {
      sessionId,
      runId,
      modelTurn: 0,
      workspacePath: path.resolve(input.workspacePath),
      mode: input.mode,
      writeScope: [...(input.writeScope ?? [])],
      strictWriteScope: input.strictWriteScope === true,
      state,
      seq: 0,
      controller: null,
      turnController: null,
      deadlineTimer: null,
      running: null,
      subscribers: new Set(),
      approvals: new Map(),
      alwaysAllowedEffects: new Set(),
      steeringPending: 0,
      followUps: [],
      contextItems: [...base, ...project],
      loadedContextIds: new Set([...base.map((item) => item.id), ...project.map((item) => item.id)]),
      outcomeWaiters: []
    };
    this.sessions.set(sessionId, session);
    await this.commandBus.claim(sessionId);
    try {
      await this.emit(session, "session.created", "runtime", {
        workspacePath: session.workspacePath,
        mode: input.mode,
        title: input.title ?? "",
        writeScope: session.writeScope,
        strictWriteScope: session.strictWriteScope
      });
    } catch (error) {
      this.sessions.delete(sessionId);
      await this.commandBus.release(sessionId);
      throw error;
    }
    return { sessionId, runId };
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
    await this.options.cancelChildren?.(session.sessionId, reason);
    session.controller?.abort(new Error(reason));
    for (const approval of session.approvals.values()) approval.resolve("deny");
    if (!session.running && session.state.phase !== "terminal") await this.finish(session, { kind: "cancelled", reason });
  }
  private async handleApproval(session: RuntimeSession, command: Extract<RunCommand, { type: "approve" }>): Promise<void> {
    const approval = session.approvals.get(command.requestId);
    if (!approval) throw new Error(`Unknown approval '${command.requestId}'.`);
    session.approvals.delete(command.requestId);
    if (command.decision === "always_allow") session.alwaysAllowedEffects.add(approval.effects.slice().sort().join("\0"));
    await this.emit(session, "tool.approval_resolved", "user", { requestId: command.requestId, callId: command.requestId, decision: command.decision });
    approval.resolve(command.decision);
    if (approval.recovered && command.decision === "deny") await this.emitRecoveryDenial(session, command.requestId);
    if (!session.running && session.state.phase !== "terminal") {
      session.lastOutcome = undefined;
      this.startRun(session);
    }
  }
  private async emitRecoveryDenial(session: RuntimeSession, callId: string): Promise<void> {
    const now = new Date().toISOString();
    await this.emit(session, "tool.failed", "runtime", {
      callId, name: "tool", ok: false, output: "Interrupted tool retry denied by user.", observedEffects: [],
      artifacts: [], diagnostics: ["recovery_retry_denied"], startedAt: now, completedAt: now
    });
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
      this.beginNextRun(session, session.mode);
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
      this.beginNextRun(session, command.mode ?? session.mode);
    }
    await this.emit(session, "run.started", "runtime", { mode: session.mode, deadlineAt: session.state.deadlineAt });
    await this.emit(session, "user.message", "user", { text: command.text });
    this.startRun(session);
  }

  async *subscribe(sessionId: string, signal?: AbortSignal): AsyncIterable<AgentEventEnvelope> {
    const session = this.sessions.get(sessionId);
    const queue = new AsyncQueue<AgentEventEnvelope>();
    const onAbort = (): void => queue.close();
    if (signal?.aborted) onAbort(); else signal?.addEventListener("abort", onAbort, { once: true });
    session?.subscribers.add(queue);
    let lastSeq = 0;
    try {
      for await (const event of this.options.store.events(sessionId)) {
        lastSeq = Math.max(lastSeq, event.seq);
        yield event;
      }
      if (!session) return;
      for await (const event of queue) {
        if (event.seq <= lastSeq) continue;
        lastSeq = event.seq;
        yield event;
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
      session?.subscribers.delete(queue);
      queue.close();
    }
  }

  async waitForOutcome(sessionId: string, signal?: AbortSignal): Promise<RunOutcome> {
    const session = this.required(sessionId);
    if (session.lastOutcome && session.state.phase === "terminal") return session.lastOutcome;
    return await new Promise<RunOutcome>((resolve, reject) => {
      const onAbort = (): void => {
        signal?.removeEventListener("abort", onAbort);
        reject(signal?.reason ?? new Error("Outcome wait cancelled."));
      };
      if (signal?.aborted) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
      session.outcomeWaiters.push((outcome) => {
        signal?.removeEventListener("abort", onAbort);
        resolve(outcome);
      });
    });
  }

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

  private async finish(session: RuntimeSession, outcome: RunOutcome): Promise<void> {
    if (outcome.kind !== "completed") {
      await this.options.cancelChildren?.(session.sessionId, `Parent run ended as ${outcome.kind}.`);
    }
    const type: AgentEventType = outcome.kind === "completed" ? "run.completed"
      : outcome.kind === "cancelled" ? "run.cancelled"
        : outcome.kind === "needs_input" ? "run.suspended" : "run.failed";
    await this.emit(session, type, "runtime", outcome);
    session.lastOutcome = outcome;
    await this.writeSnapshot(session);
    await this.commandBus.release(session.sessionId);
    for (const waiter of session.outcomeWaiters.splice(0)) waiter(outcome);
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

  private beginNextRun(session: RuntimeSession, mode: RuntimeSession["mode"]): void {
    const now = new Date().toISOString();
    session.runId = randomUUID();
    session.modelTurn = 0;
    session.mode = mode;
    const state = createKernelState({ sessionId: session.sessionId, runId: session.runId, mode, startedAt: now, deadlineAt: new Date(Date.now() + this.runDeadlineMs).toISOString() });
    session.state = { ...state, messages: session.state.messages, lastSeq: session.seq };
    session.lastOutcome = undefined;
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
      loadedContextIds: new Set([...base, ...project, ...contextItems].map((item) => item.id)), outcomeWaiters: [], lastOutcome: state.outcome
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
    const task = this.run(session);
    session.running = task;
    void task.finally(async () => {
      if (session.running === task) session.running = null;
      const next = session.followUps.shift();
      if (!next) return;
      await this.commandBus.claim(session.sessionId);
      this.beginNextRun(session, session.mode);
      await this.emit(session, "run.started", "runtime", { mode: session.mode, deadlineAt: session.state.deadlineAt });
      await this.emit(session, "user.follow_up", "user", { text: next.text, queueId: next.id, status: "delivered" });
      this.startRun(session);
    });
  }
}
