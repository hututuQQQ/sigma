import type { JsonValue, ModelMessage, RunMode, RunOutcome, ToolRequest, ToolReceipt } from "agent-protocol";

export type KernelPhase =
  | "idle"
  | "ready_model"
  | "model_in_flight"
  | "tool_pending"
  | "tool_in_flight"
  | "needs_input"
  | "outcome_pending"
  | "terminal";

export interface ActiveModelTurn {
  turnId: number;
  effectRevision: number;
}

export interface PendingTool {
  request: ToolRequest;
  modelTurn: ActiveModelTurn;
  approval: "not_required" | "pending" | "allowed" | "denied";
  started: boolean;
}

export interface KernelState {
  schemaVersion: 2;
  sessionId: string;
  runId: string;
  mode: RunMode;
  phase: KernelPhase;
  revision: number;
  lastSeq: number;
  startedAt: string;
  deadlineAt: string;
  activeModelTurn?: ActiveModelTurn;
  messages: ModelMessage[];
  pendingTools: PendingTool[];
  toolCallIds: string[];
  receipts: ToolReceipt[];
  evidence: JsonValue[];
  childIds: string[];
  completionRepairAttempts: number;
  continuationAttempts: number;
  repeatedToolBatchCount: number;
  receiptCountAtLastUserInput: number;
  lastToolBatchSignature?: string;
  proposedOutcome?: RunOutcome;
  outcome?: RunOutcome;
}

export interface CreateKernelStateOptions {
  sessionId: string;
  runId: string;
  mode: RunMode;
  startedAt: string;
  deadlineAt: string;
}

export function createKernelState(options: CreateKernelStateOptions): KernelState {
  return {
    schemaVersion: 2,
    sessionId: options.sessionId,
    runId: options.runId,
    mode: options.mode,
    phase: "idle",
    revision: 0,
    lastSeq: 0,
    startedAt: options.startedAt,
    deadlineAt: options.deadlineAt,
    messages: [],
    pendingTools: [],
    toolCallIds: [],
    receipts: [],
    evidence: [],
    childIds: [],
    completionRepairAttempts: 0,
    continuationAttempts: 0,
    repeatedToolBatchCount: 0,
    receiptCountAtLastUserInput: 0
  };
}

export function isTerminal(state: KernelState): boolean {
  return state.phase === "terminal";
}
