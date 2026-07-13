import { type AgentEventEnvelope, type AgentEventOf, type AgentEventPayloadMap, type AgentEventType, type BudgetLedgerState, type ContextAuthority, type JsonValue, type RunCommand, type RunOutcome, type RuntimeClient, type SessionOverview, type SessionRef, type StartSession } from "agent-protocol";
import { ContentAddressedArtifactStore } from "agent-store";
import { EffectRunner } from "./effect-runner.js";
import { newRuntimeSession } from "./new-runtime-session.js";
import { recoverInterruptedSession } from "./session-recovery.js";
import { SessionCommandBus } from "./session-command-bus.js";
import { combinedSessionEvents, ensureSessionPromoted, listCombinedSessions } from "./session-catalog.js";
import { streamSessionEvents } from "./runtime-stream.js";
import { waitForSessionIdleOutcome, waitForSessionOutcome } from "./runtime-waiters.js";
import type { RuntimeOptions, RuntimeSession } from "./types.js";
import { releaseRuntimeSession } from "./release-session.js";
import { BudgetController } from "./budget-controller.js";
import { RuntimeControlService } from "./runtime-control.js";
import { ModelReviewer } from "./reviewer.js";
import { handleChildEvent } from "./child-event-handler.js";
import { reconcileInterruptedChildren } from "./durable-children.js";
import { RuntimeHookCoordinator } from "./runtime-hooks.js";
import { ModelAgentProfileHookRunner } from "./agent-profile-hook-runner.js";
import { runRuntimeSession } from "./runtime-run.js";
import { terminateRunProcesses } from "./process-cleanup.js";
import { requestDelegatedApproval as awaitDelegatedApproval } from "./delegated-approval.js";
import { RuntimeCommandHandler } from "./runtime-command-handler.js";
import { RuntimeEventLog } from "./runtime-event-log.js";
import { hydrateRuntimeSession } from "./runtime-session-restore.js";
import { RuntimeRunScheduler } from "./runtime-run-scheduler.js";
import { initializeRuntimeSession } from "./runtime-session-initialization.js";
import { restoreRuntimeCustomization } from "./runtime-customization-restore.js";
import { finishRuntimeSession } from "./runtime-session-finish.js";
import { RuntimeCheckpointCoordinator } from "./runtime-checkpoint-coordinator.js";
import {
  assertProfileResources,
  constrainBudget,
  resolveHookProfile,
  resolveChildProfile,
  roleForMode,
  type SessionProfileSelection
} from "./session-profile.js";
import { createCheckpointManager } from "./runtime-checkpoint-manager.js";
import { FrozenWorkspaceHookMaterializer } from "./frozen-hook-assets.js";
import { FrozenSkillMaterializer } from "./frozen-skill-assets.js";
import { ChildCheckpointRecoveryCoordinator } from "./child-workspace-recovery.js";
export class InProcessRuntimeClient implements RuntimeClient {
  private readonly sessions = new Map<string, RuntimeSession>();
  private readonly artifacts: ContentAddressedArtifactStore;
  private readonly effects: EffectRunner;
  private readonly runDeadlineMs: number;
  private readonly commandBus: SessionCommandBus;
  private readonly control: RuntimeControlService;
  private readonly budgets: BudgetController;
  private readonly hooks: RuntimeHookCoordinator;
  private readonly commands: RuntimeCommandHandler;
  private readonly events: RuntimeEventLog;
  private readonly runs: RuntimeRunScheduler;
  private readonly checkpoints: RuntimeCheckpointCoordinator;
  private readonly checkpointManager: ReturnType<typeof createCheckpointManager>;
  private readonly childCheckpointRecovery: ChildCheckpointRecoveryCoordinator;
  private readonly profileHookRecovery?: ModelAgentProfileHookRunner;
  constructor(private readonly options: RuntimeOptions & { storeRootDir: string }) {
    assertProfileResources(options, options.profile);
    this.artifacts = new ContentAddressedArtifactStore(options.storeRootDir);
    this.runDeadlineMs = options.runDeadlineMs ?? 900_000;
    this.events = new RuntimeEventLog(options.store);
    this.commandBus = new SessionCommandBus(options.storeRootDir, async (command) => await this.command(command));
    this.commands = new RuntimeCommandHandler({
      runDeadlineMs: this.runDeadlineMs,
      commandBus: this.commandBus,
      cancelChildren: options.cancelChildren,
      emit: async (session, type, authority, value) => await this.emit(session, type, authority, value),
      finish: async (session, outcome) => await this.finish(session, outcome),
      start: (session) => this.startRun(session)
    });
    if (options.hooks?.some((hook) => hook.kind === "command") && !options.hookRunner) {
      throw new Error("A hookRunner is required when command hooks are configured.");
    }
    this.budgets = new BudgetController(async (session, type, authority, value) =>
      await this.emit(session, type, authority, value));
    const productionProfileRunner = options.agentProfileHookRunner ? undefined : new ModelAgentProfileHookRunner({
      session: (sessionId) => this.required(sessionId),
      resolveProfile: (session, profileId) => resolveHookProfile(options, session, profileId),
      gateway: (session, profile) => options.gatewayForRole?.("planner", profile) ?? session.gateway,
      budgets: this.budgets,
      emit: async (session, type, authority, value) => await this.emit(session, type, authority, value)
    });
    this.profileHookRecovery = productionProfileRunner;
    const agentProfileRunner = options.agentProfileHookRunner ?? productionProfileRunner;
    const hookMaterializer = new FrozenWorkspaceHookMaterializer(options.storeRootDir, this.artifacts);
    this.hooks = new RuntimeHookCoordinator({
      definitions: options.hooks ?? [],
      runner: options.hookRunner ?? { run: async () => ({ ok: false, error: "Hook runner is unavailable.", durationMs: 0 }) },
      ...(agentProfileRunner ? { agentProfileRunner } : {}),
      materializeWorkspaceHook: (session, hook) => hookMaterializer.materialize(session.workspacePath, session.sessionId, hook),
      emit: async (session, type, authority, value) => await this.emit(session, type, authority, value)
    });
    this.checkpointManager = createCheckpointManager(options);
    this.control = new RuntimeControlService({
      checkpoints: this.checkpointManager,
      skills: options.skills,
      budgets: this.budgets,
      emit: async (session, type, authority, value) => await this.emit(session, type, authority, value),
      createArtifact: async (sessionId, content) => await this.artifacts.put(sessionId, content),
      readArtifact: async (sessionId, artifactId) => (await this.artifacts.get(sessionId, artifactId)).toString("utf8"),
      skillMaterializer: new FrozenSkillMaterializer(options.storeRootDir, this.artifacts),
      planChanged: async (session, previousRevision, plan) => {
        await this.hooks.dispatch(session, "plan_changed", {
          previousRevision, plan, source: "tool"
        }, session.controller?.signal ?? new AbortController().signal);
      }
    });
    this.effects = new EffectRunner({
      runtime: options,
      maxParallelTools: options.maxParallelTools ?? 4,
      permissionMode: options.permissionMode ?? "ask",
      outputReserveTokens: options.outputReserveTokens ?? Math.min(8_192, options.gateway.capabilities.maxOutputTokens),
      emit: async (session, type, authority, value) => await this.emit(session, type, authority, value),
      finish: async (session, outcome, outcomeRevision) => await this.finish(session, outcome, outcomeRevision),
      createArtifact: async (sessionId, content) => await this.artifacts.put(sessionId, content),
      control: this.control,
      budgets: this.budgets,
      reviewer: options.reviewer ?? new ModelReviewer(options.gateway),
      reviewerForSession: options.reviewerForSession,
      hooks: this.hooks
    });
    this.runs = new RuntimeRunScheduler({
      runDeadlineMs: this.runDeadlineMs,
      commandBus: this.commandBus,
      run: async (session) => await this.run(session),
      emit: async (session, type, authority, value) => await this.emit(session, type, authority, value),
      finish: async (session, outcome) => await this.finish(session, outcome),
      waitForQuiescence: async (sessionId) => await this.effects.waitForQuiescence(sessionId)
    });
    this.checkpoints = new RuntimeCheckpointCoordinator(
      this.effects,
      this.control,
      options.hasActiveChildren
    );
    this.childCheckpointRecovery = new ChildCheckpointRecoveryCoordinator({ store: options.store, checkpoints: this.checkpointManager, coordinator: this.checkpoints, control: this.control, emit: async (session, type, authority, value) => await this.emit(session, type, authority, value) });
  }
  async createSession(input: StartSession, allocatedBudget = this.options.budgetLimits): Promise<SessionRef> {
    return await this.createSessionWithProfile(input, constrainBudget(allocatedBudget, this.options.profile), {
      profile: this.options.profile,
      profileSource: this.options.profileSource
    }, "orchestrator");
  }

  async createChildSession(
    parentSessionId: string,
    input: StartSession,
    allocatedBudget: import("agent-protocol").BudgetLimits | undefined,
    requestedProfileId?: string | null,
    workspaceLeaseInherited = false
  ): Promise<SessionRef> {
    if (input.reviewerWaiverReason?.trim()) {
      throw Object.assign(new Error("Child agents cannot waive independent review."), {
        code: "reviewer_waiver_user_only"
      });
    }
    const selection = resolveChildProfile(this.options, this.required(parentSessionId), requestedProfileId);
    return await this.createSessionWithProfile(
      input,
      constrainBudget(allocatedBudget, selection.profile),
      selection,
      roleForMode(input.mode),
      workspaceLeaseInherited,
      parentSessionId
    );
  }

  private async createSessionWithProfile(
    input: StartSession,
    allocatedBudget: import("agent-protocol").BudgetLimits | undefined,
    selection: SessionProfileSelection,
    modelRole: import("agent-protocol").ModelExecutionRole,
    workspaceLeaseInherited = false,
    parentSessionId?: string
  ): Promise<SessionRef> {
    assertProfileResources(this.options, selection.profile);
    const gateway = this.options.gatewayForRole?.(modelRole, selection.profile) ?? this.options.gateway;
    const session = await newRuntimeSession(input, this.runDeadlineMs, allocatedBudget, {
      gateway,
      modelRole,
      profile: selection.profile,
      profileSource: selection.profileSource,
      workspaceLeaseInherited,
      ...(parentSessionId ? { parentSessionId } : {})
    }, this.options.runtimeEnvironment);
    this.sessions.set(session.sessionId, session);
    await this.commandBus.claim(session.sessionId);
    try {
      await initializeRuntimeSession(session, input, {
        profile: session.profile,
        profileSource: session.profileSource,
        availableProfiles: this.options.availableProfiles,
        skills: this.options.skills,
        hooks: this.options.hooks,
        hookArtifacts: this.options.hookArtifacts,
        putArtifact: async (sessionId, content) => await this.artifacts.put(sessionId, content),
        emit: async (target, type, authority, value) => await this.emit(target, type, authority, value),
        dispatchHook: async (target, event, value, signal) =>
          await this.hooks.dispatch(target, event, value, signal)
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
    if (command.type === "checkpoint_recovery") {
      await this.checkpoints.resolveOpen(session, command.checkpointId, command.decision);
      session.lastOutcome = undefined;
      await this.recoverSession(session);
      return;
    }
    if (command.type === "budget_increase") {
      if (session.parentSessionId || session.modelRole === "child_analyze" || session.modelRole === "child_write") {
        const ancestry = session.parentSessionId ? ` of '${session.parentSessionId}'` : "";
        throw Object.assign(new Error(
          `Only a root session may increase budget limits; '${session.sessionId}' is a child${ancestry}.`
        ), { code: "budget_increase_root_only" });
      }
      await this.budgets.increaseLimits(session, command.increase);
      return;
    }
    if (session.openCheckpointRecovery) {
      throw Object.assign(new Error(
        `Checkpoint ${session.openCheckpointRecovery.checkpointId} requires an explicit user restore or keep decision.`
      ), { code: "checkpoint_recovery_required" });
    }
    if (command.type === "reviewer_waiver") return await this.commands.reviewerWaiver(session, command);
    if (command.type === "cancel") return await this.commands.cancel(session, command);
    if (command.type === "approve") return await this.commands.approval(session, command);
    if (command.type === "steer") return await this.commands.steer(session, command.text);
    if (command.type === "follow_up") return await this.commands.followUp(session, command.text);
    await this.commands.submit(session, command);
  }
  private async handleResume(command: Extract<RunCommand, { type: "resume" }>): Promise<void> {
    await ensureSessionPromoted(this.options.storeRootDir, command.sessionId);
    await this.commandBus.claim(command.sessionId);
    try {
      await this.resume(command.sessionId);
      if (this.sessions.get(command.sessionId)?.state.phase === "terminal") await this.commandBus.release(command.sessionId);
    } catch (error) {
      await this.commandBus.release(command.sessionId);
      throw error;
    }
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
    return await listCombinedSessions(this.options.store, this.options.storeRootDir, limit);
  }
  sessionEvents(sessionId: string, afterSeq = 0): AsyncIterable<AgentEventEnvelope> {
    return combinedSessionEvents(this.options.store, this.options.storeRootDir, sessionId, afterSeq);
  }
  async releaseSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || !await releaseRuntimeSession(session,
      async () => await this.effects.waitForQuiescence(sessionId),
      async () => await this.commandBus.release(sessionId))) return;
    this.sessions.delete(sessionId);
    this.events.forget(sessionId);
  }
  sessionBudget(sessionId: string): BudgetLedgerState {
    return structuredClone(this.required(sessionId).state.budget);
  }
  async undoLatestCheckpoint(sessionId: string): Promise<import("agent-protocol").CheckpointRef> {
    return await this.checkpoints.undoLatest(this.required(sessionId));
  }
  async recordChildEvent(
    parentSessionId: string,
    type: "child.spawned" | "child.message" | "child.completed",
    payload: JsonValue
  ): Promise<void> {
    const session = this.required(parentSessionId);
    await handleChildEvent(
      session,
      type,
      payload,
      this.control,
      async (target, eventType, authority, value) => await this.emit(target, eventType, authority, value)
    );
  }
  async requestDelegatedApproval(
    parentSessionId: string,
    request: import("./delegated-approval.js").DelegatedApprovalRequest,
    signal: AbortSignal
  ): Promise<"allow" | "deny"> {
    return await awaitDelegatedApproval(
      this.required(parentSessionId), request, signal,
      async (session, type, authority, value) => await this.emit(session, type, authority, value)
    );
  }
  private async run(session: RuntimeSession): Promise<void> {
    await runRuntimeSession({
      hooks: this.hooks,
      effects: this.effects,
      finish: async (target, outcome) => await this.finish(target, outcome)
    }, session);
  }
  private async finish(session: RuntimeSession, outcome: RunOutcome, outcomeRevision?: number): Promise<boolean> {
    return await finishRuntimeSession({
      hooks: this.hooks,
      events: this.events,
      commandBus: this.commandBus,
      cancelChildren: this.options.cancelChildren,
      beforeOutcome: async (target, finalOutcome) => await terminateRunProcesses(
        target,
        finalOutcome,
        this.options.execution,
        async (current, type, authority, value) => await this.emit(current, type, authority, value)
      )
    }, session, outcome, outcomeRevision);
  }

  private async emit<TType extends AgentEventType>(
    session: RuntimeSession,
    type: TType,
    authority: Exclude<ContextAuthority, "external_verifier">,
    value: AgentEventPayloadMap[NoInfer<TType>]
  ): Promise<AgentEventOf<TType>> {
    return await this.events.emit(session, type, authority, value);
  }

  private async resume(sessionId: string): Promise<void> {
    if (this.sessions.has(sessionId)) return;
    const session = await hydrateRuntimeSession(this.options.store, sessionId, this.runDeadlineMs, {
      gateway: this.options.gateway,
      profile: this.options.profile,
      profileSource: this.options.profileSource
    }, this.options.runtimeEnvironment);
    await restoreRuntimeCustomization(session, this.artifacts, this.options);
    this.sessions.set(sessionId, session);
    const recovery = await this.control.recoverOpen(session);
    if (recovery.kind === "needs_input") {
      await this.childCheckpointRecovery.suspendOwnCheckpoint(session, {
        checkpointId: recovery.checkpointId,
        currentManifestDigest: recovery.currentManifestDigest
      });
      return;
    }
    await this.recoverSession(session);
  }

  private async recoverSession(session: RuntimeSession): Promise<void> {
    await this.profileHookRecovery?.recoverInterrupted(session);
    const hasLiveChildren = await this.options.hasActiveChildren?.(session.sessionId) ?? false;
    if (!hasLiveChildren) {
      if (await this.childCheckpointRecovery.recover(session)) return;
      await reconcileInterruptedChildren(
        this.options.store,
        session,
        this.control,
        async (target, type, authority, value) => await this.emit(target, type, authority, value)
      );
    }
    await recoverInterruptedSession(session, {
      descriptors: this.options.tools.descriptors(),
      emit: async (type, authority, payload) => await this.emit(session, type, authority, payload),
      settleToolBudget: async (callId, disposition, checkpointId) =>
        await this.budgets.settleInterruptedTool(session, callId, disposition, checkpointId),
      settleEligibleToolBudgets: async () => await this.effects.settleMutationBudgets(session),
      settleModelBudget: async (requestId) =>
        await this.budgets.settleInterruptedModel(session, requestId),
      start: () => this.startRun(session)
    });
  }

  private required(sessionId: string): RuntimeSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown session '${sessionId}'.`);
    return session;
  }
  private startRun(session: RuntimeSession): void {
    this.runs.start(session);
  }
}
