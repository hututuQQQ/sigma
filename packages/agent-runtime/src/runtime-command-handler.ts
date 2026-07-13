import { randomUUID } from "node:crypto";
import type {
  RunCommand,
  RunOutcome
} from "agent-protocol";
import { beginNextRun, recoveryDenialPayload } from "./run-transitions.js";
import type { SessionCommandBus } from "./session-command-bus.js";
import type { ApprovalWaiter, RuntimeOptions, RuntimeSession } from "./types.js";
import type { RuntimeEventEmitter } from "./runtime-event-emitter.js";
import { recordReviewerWaiver } from "./review-waiver-command.js";
import { armRunDeadline, resumedDeadlineAt } from "./run-deadline.js";

export interface RuntimeCommandHandlerOptions {
  runDeadlineMs: number;
  commandBus: SessionCommandBus;
  cancelChildren: RuntimeOptions["cancelChildren"];
  emit: RuntimeEventEmitter;
  finish(session: RuntimeSession, outcome: RunOutcome): Promise<boolean>;
  start(session: RuntimeSession): void;
}

async function waitForTerminalRunSettlement(session: RuntimeSession): Promise<void> {
  const running = session.execution.running;
  if (!running || session.durable.state.phase !== "terminal") return;
  await running;
  if (session.execution.running !== running) return;
  await new Promise<void>((resolve, reject) => {
    session.interaction.idleWaiters.push({ resolve, reject });
  });
}

function approvalDecision(
  approval: ApprovalWaiter,
  requested: "allow" | "deny" | "always_allow"
): "allow" | "deny" | "always_allow" {
  const perCall = approval.effects.some((effect) => effect === "network" || effect === "open_world");
  return perCall && requested === "always_allow" ? "allow" : requested;
}

function installCallGrant(
  session: RuntimeSession,
  requestId: string,
  approval: ApprovalWaiter,
  decision: "allow" | "deny" | "always_allow",
  hasPendingTool: boolean
): void {
  const binding = approval.binding ?? (approval.recovered ? {
    sessionId: session.identity.sessionId,
    runId: session.durable.runId,
    callId: requestId,
    // Legacy approval events without a durable plan deliberately create a
    // non-matching sentinel so the resumed runner must present its fresh plan.
    planEffectsDigest: "unbound"
  } : undefined);
  // Every explicit local approval receives a one-shot, plan-bound grant. The
  // execution gate consumes it before starting a sensitive or mutating call.
  if (decision === "deny" || !hasPendingTool || !binding
    || binding.sessionId !== session.identity.sessionId || binding.runId !== session.durable.runId
    || binding.callId !== requestId) return;
  session.interaction.callApprovals.set(requestId, {
    ...binding,
    callId: requestId,
    authority: "user",
    networkApproved: approval.effects.includes("network"),
    unsafeHostExecApproved: approval.effects.includes("open_world"),
    ...(decision === "always_allow"
      ? { alwaysAllowEffectGrant: approval.effects.slice().sort().join("\0") }
      : {})
  });
}

async function persistApprovalResolution(
  emit: RuntimeEventEmitter,
  session: RuntimeSession,
  requestId: string,
  approval: ApprovalWaiter,
  pendingTool: RuntimeSession["durable"]["state"]["pendingTools"][number] | undefined,
  decision: "allow" | "deny" | "always_allow"
): Promise<void> {
  approval.resolving = true;
  try {
    const deadlineAt = session.interaction.approvals.size === 1 ? resumedDeadlineAt(session) : undefined;
    await emit(session, "tool.approval_resolved", "user", {
      requestId,
      callId: approval.external?.callId ?? requestId,
      decision,
      ...(deadlineAt ? { deadlineAt } : {}),
      ...(pendingTool ? pendingTool.modelTurn : {
        childId: approval.external?.childId,
        delegated: true
      })
    });
  } catch (error) {
    approval.resolving = false;
    throw error;
  }
}

export class RuntimeCommandHandler {
  private readonly approvalResolutions = new Map<string, Promise<void>>();

  constructor(private readonly options: RuntimeCommandHandlerOptions) {}

  async cancel(session: RuntimeSession, command: Extract<RunCommand, { type: "cancel" }>): Promise<void> {
    const reason = command.reason ?? "Cancelled by user.";
    session.execution.controller?.abort(new Error(reason));
    for (const approval of session.interaction.approvals.values()) approval.resolve("deny");
    session.interaction.approvals.clear();
    session.interaction.callApprovals.clear();
    await this.options.cancelChildren?.(session.identity.sessionId, reason);
    if (!session.execution.running && session.durable.state.phase !== "terminal") {
      await this.options.finish(session, { kind: "cancelled", reason });
    }
  }

  async approval(session: RuntimeSession, command: Extract<RunCommand, { type: "approve" }>): Promise<void> {
    const previous = this.approvalResolutions.get(session.identity.sessionId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(async () => {
      await this.resolveApproval(session, command);
    });
    this.approvalResolutions.set(session.identity.sessionId, current);
    try {
      await current;
    } finally {
      if (this.approvalResolutions.get(session.identity.sessionId) === current) {
        this.approvalResolutions.delete(session.identity.sessionId);
      }
    }
  }

  private async resolveApproval(
    session: RuntimeSession,
    command: Extract<RunCommand, { type: "approve" }>
  ): Promise<void> {
    const approval = session.interaction.approvals.get(command.requestId);
    const pendingTool = session.durable.state.pendingTools.find((item) => item.request.callId === command.requestId);
    if (!approval || approval.resolving || (!pendingTool && !approval.external)) {
      throw new Error(`Unknown approval '${command.requestId}'.`);
    }
    const decision = approvalDecision(approval, command.decision);
    await persistApprovalResolution(
      this.options.emit, session, command.requestId, approval, pendingTool, decision
    );
    session.interaction.approvals.delete(command.requestId);
    if (session.interaction.approvals.size === 0) armRunDeadline(session);
    installCallGrant(session, command.requestId, approval, decision, Boolean(pendingTool));
    approval.resolve(decision);
    if (approval.recovered && decision === "deny" && pendingTool) {
      await this.options.emit(
        session,
        "tool.failed",
        "runtime",
        recoveryDenialPayload(command.requestId, pendingTool.modelTurn)
      );
    }
    if (!approval.external && !session.execution.running && session.durable.state.phase !== "terminal") {
      session.recovery.lastOutcome = undefined;
      this.options.start(session);
    }
  }

  async reviewerWaiver(
    session: RuntimeSession,
    command: Extract<RunCommand, { type: "reviewer_waiver" }>
  ): Promise<void> {
    await recordReviewerWaiver(session, command, this.options.emit);
  }

  async steer(session: RuntimeSession, text: string): Promise<void> {
    if (session.interaction.steeringPending >= 256) throw new Error("Steering queue is full (256 messages).");
    session.interaction.steeringPending += 1;
    try {
      await this.options.emit(session, "user.steer", "user", { text });
      const reason = Object.assign(new Error("Active model/tool turn was superseded by user steering."), {
        code: "steering_restart"
      });
      session.execution.turnController?.abort(reason);
      session.interaction.callApprovals.clear();
    } finally {
      session.interaction.steeringPending -= 1;
    }
  }

  async followUp(session: RuntimeSession, text: string): Promise<void> {
    if (session.interaction.followUps.length >= 256) throw new Error("Follow-up queue is full (256 messages).");
    await waitForTerminalRunSettlement(session);
    if (session.execution.running) {
      const followUp = { id: randomUUID(), text };
      await this.options.emit(session, "user.follow_up", "user", {
        text, queueId: followUp.id, status: "queued"
      });
      session.interaction.followUps.push(followUp);
      return;
    }
    if (session.durable.state.phase === "terminal") {
      await this.options.commandBus.claim(session.identity.sessionId);
      beginNextRun(session, session.durable.mode, this.options.runDeadlineMs);
    } else if (session.durable.state.phase === "needs_input") {
      await this.options.commandBus.claim(session.identity.sessionId);
      session.recovery.lastOutcome = undefined;
    }
    await this.options.emit(session, "run.started", "runtime", {
      mode: session.durable.mode, deadlineAt: session.durable.state.deadlineAt
    });
    await this.options.emit(session, "user.follow_up", "user", {
      text, queueId: randomUUID(), status: "delivered"
    });
    this.options.start(session);
  }

  async submit(session: RuntimeSession, command: Extract<RunCommand, { type: "submit" }>): Promise<void> {
    await waitForTerminalRunSettlement(session);
    if (session.execution.running) {
      await this.steer(session, command.text);
      return;
    }
    if (session.durable.state.phase === "terminal") {
      await this.options.commandBus.claim(session.identity.sessionId);
      beginNextRun(session, command.mode ?? session.durable.mode, this.options.runDeadlineMs);
    } else if (session.durable.state.phase === "needs_input") {
      await this.options.commandBus.claim(session.identity.sessionId);
      session.recovery.lastOutcome = undefined;
    }
    await this.options.emit(session, "run.started", "runtime", {
      mode: session.durable.mode, deadlineAt: session.durable.state.deadlineAt
    });
    await this.options.emit(session, "user.message", "user", { text: command.text });
    this.options.start(session);
  }
}
