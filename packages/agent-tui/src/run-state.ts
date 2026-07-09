import type { AgentRunResult, PermissionRequest } from "agent-core";

export type TuiRunPhase = "idle" | "running" | "queued" | "approval" | "cancelling" | "completed" | "stopped" | "error";
export type TuiRunStateTone = "danger" | "dim" | "success" | "warning";

export interface BuildTuiRunStateOptions {
  running: boolean;
  cancelling?: boolean;
  result: AgentRunResult | null;
  queuedInstruction?: string | null;
  pendingApproval?: PermissionRequest | null;
  approvalPending?: boolean;
}

export interface TuiRunState {
  phase: TuiRunPhase;
  label: string;
  tone: TuiRunStateTone;
  active: boolean;
  running: boolean;
  cancelling: boolean;
  approvalPending: boolean;
  queuedCount: number;
  queuedInstruction: string | null;
  composerPrompt: ">" | "queue >" | "approval >";
  lastResult: string | null;
}

function resultLabel(result: AgentRunResult | null): string | null {
  if (!result) return null;
  const phase = result.loopDiagnostics?.phase;
  const reason = result.loopDiagnostics?.lastControllerReason;
  return [
    result.finishReason ? `${result.status} ${result.finishReason}` : result.status,
    phase ? `phase=${phase}` : "",
    reason ? `reason=${reason}` : ""
  ].filter(Boolean).join(" ");
}

export function buildTuiRunState(options: BuildTuiRunStateOptions): TuiRunState {
  const approvalPending = Boolean(options.pendingApproval ?? options.approvalPending);
  const queuedInstruction = options.queuedInstruction?.trim() ? options.queuedInstruction : null;
  const queuedCount = queuedInstruction ? 1 : 0;
  const cancelling = Boolean(options.cancelling);
  const running = options.running;
  const active = running || approvalPending || cancelling;
  const lastResult = resultLabel(options.result);

  if (approvalPending) {
    return {
      phase: "approval",
      label: "approval",
      tone: "warning",
      active: true,
      running,
      cancelling,
      approvalPending,
      queuedCount,
      queuedInstruction,
      composerPrompt: "approval >",
      lastResult
    };
  }

  if (cancelling) {
    return {
      phase: "cancelling",
      label: "cancelling",
      tone: "warning",
      active: true,
      running,
      cancelling,
      approvalPending,
      queuedCount,
      queuedInstruction,
      composerPrompt: "queue >",
      lastResult
    };
  }

  if (running) {
    return {
      phase: "running",
      label: "running",
      tone: "warning",
      active: true,
      running,
      cancelling,
      approvalPending,
      queuedCount,
      queuedInstruction,
      composerPrompt: "queue >",
      lastResult
    };
  }

  if (queuedInstruction) {
    return {
      phase: "queued",
      label: "queued",
      tone: "warning",
      active: true,
      running,
      cancelling,
      approvalPending,
      queuedCount,
      queuedInstruction,
      composerPrompt: "queue >",
      lastResult
    };
  }

  if (options.result?.status === "completed") {
    return {
      phase: "completed",
      label: "completed",
      tone: "success",
      active: false,
      running,
      cancelling,
      approvalPending,
      queuedCount,
      queuedInstruction,
      composerPrompt: ">",
      lastResult
    };
  }

  if (options.result?.status === "stopped") {
    return {
      phase: "stopped",
      label: "stopped",
      tone: "warning",
      active: false,
      running,
      cancelling,
      approvalPending,
      queuedCount,
      queuedInstruction,
      composerPrompt: ">",
      lastResult
    };
  }

  if (options.result?.status === "error") {
    return {
      phase: "error",
      label: "error",
      tone: "danger",
      active: false,
      running,
      cancelling,
      approvalPending,
      queuedCount,
      queuedInstruction,
      composerPrompt: ">",
      lastResult
    };
  }

  return {
    phase: "idle",
    label: "idle",
    tone: "dim",
    active,
    running,
    cancelling,
    approvalPending,
    queuedCount,
    queuedInstruction,
    composerPrompt: ">",
    lastResult
  };
}
