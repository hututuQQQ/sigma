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
  const running = session.running;
  if (!running || session.state.phase !== "terminal") return;
  await running;
  if (session.running !== running) return;
  await new Promise<void>((resolve, reject) => {
    session.idleWaiters.push({ resolve, reject });
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
  if (decision !== "allow" || !hasPendingTool
    || !approval.effects.some((effect) => effect === "network" || effect === "open_world")) return;
  session.callApprovals.set(requestId, {
    callId: requestId,
    authority: "user",
    networkApproved: approval.effects.includes("network"),
    unsafeHostExecApproved: approval.effects.includes("open_world")
  });
}

async function persistApprovalResolution(
  emit: RuntimeEventEmitter,
  session: RuntimeSession,
  requestId: string,
  approval: ApprovalWaiter,
  pendingTool: RuntimeSession["state"]["pendingTools"][number] | undefined,
  decision: "allow" | "deny" | "always_allow"
): Promise<void> {
  approval.resolving = true;
  try {
    const deadlineAt = session.approvals.size === 1 ? resumedDeadlineAt(session) : undefined;
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
  constructor(private readonly options: RuntimeCommandHandlerOptions) {}

  async cancel(session: RuntimeSession, command: Extract<RunCommand, { type: "cancel" }>): Promise<void> {
    const reason = command.reason ?? "Cancelled by user.";
    session.controller?.abort(new Error(reason));
    for (const approval of session.approvals.values()) approval.resolve("deny");
    session.approvals.clear();
    session.callApprovals.clear();
    await this.options.cancelChildren?.(session.sessionId, reason);
    if (!session.running && session.state.phase !== "terminal") {
      await this.options.finish(session, { kind: "cancelled", reason });
    }
  }

  async approval(session: RuntimeSession, command: Extract<RunCommand, { type: "approve" }>): Promise<void> {
    const approval = session.approvals.get(command.requestId);
    const pendingTool = session.state.pendingTools.find((item) => item.request.callId === command.requestId);
    if (!approval || approval.resolving || (!pendingTool && !approval.external)) {
      throw new Error(`Unknown approval '${command.requestId}'.`);
    }
    const decision = approvalDecision(approval, command.decision);
    await persistApprovalResolution(
      this.options.emit, session, command.requestId, approval, pendingTool, decision
    );
    session.approvals.delete(command.requestId);
    if (session.approvals.size === 0) armRunDeadline(session);
    installCallGrant(session, command.requestId, approval, decision, Boolean(pendingTool));
    if (decision === "always_allow") {
      session.alwaysAllowedEffects.add(approval.effects.slice().sort().join("\0"));
    }
    approval.resolve(decision);
    if (approval.recovered && decision === "deny" && pendingTool) {
      await this.options.emit(
        session,
        "tool.failed",
        "runtime",
        recoveryDenialPayload(command.requestId, pendingTool.modelTurn)
      );
    }
    if (!approval.external && !session.running && session.state.phase !== "terminal") {
      session.lastOutcome = undefined;
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
    if (session.steeringPending >= 256) throw new Error("Steering queue is full (256 messages).");
    session.steeringPending += 1;
    try {
      await this.options.emit(session, "user.steer", "user", { text });
      const reason = Object.assign(new Error("Active model/tool turn was superseded by user steering."), {
        code: "steering_restart"
      });
      session.turnController?.abort(reason);
      session.callApprovals.clear();
    } finally {
      session.steeringPending -= 1;
    }
  }

  async followUp(session: RuntimeSession, text: string): Promise<void> {
    if (session.followUps.length >= 256) throw new Error("Follow-up queue is full (256 messages).");
    await waitForTerminalRunSettlement(session);
    if (session.running) {
      const followUp = { id: randomUUID(), text };
      await this.options.emit(session, "user.follow_up", "user", {
        text, queueId: followUp.id, status: "queued"
      });
      session.followUps.push(followUp);
      return;
    }
    if (session.state.phase === "terminal") {
      await this.options.commandBus.claim(session.sessionId);
      beginNextRun(session, session.mode, this.options.runDeadlineMs);
    } else if (session.state.phase === "needs_input") {
      await this.options.commandBus.claim(session.sessionId);
      session.lastOutcome = undefined;
    }
    await this.options.emit(session, "run.started", "runtime", {
      mode: session.mode, deadlineAt: session.state.deadlineAt
    });
    await this.options.emit(session, "user.follow_up", "user", {
      text, queueId: randomUUID(), status: "delivered"
    });
    this.options.start(session);
  }

  async submit(session: RuntimeSession, command: Extract<RunCommand, { type: "submit" }>): Promise<void> {
    await waitForTerminalRunSettlement(session);
    if (session.running) {
      await this.steer(session, command.text);
      return;
    }
    if (session.state.phase === "terminal") {
      await this.options.commandBus.claim(session.sessionId);
      beginNextRun(session, command.mode ?? session.mode, this.options.runDeadlineMs);
    } else if (session.state.phase === "needs_input") {
      await this.options.commandBus.claim(session.sessionId);
      session.lastOutcome = undefined;
    }
    await this.options.emit(session, "run.started", "runtime", {
      mode: session.mode, deadlineAt: session.state.deadlineAt
    });
    await this.options.emit(session, "user.message", "user", { text: command.text });
    this.options.start(session);
  }
}
