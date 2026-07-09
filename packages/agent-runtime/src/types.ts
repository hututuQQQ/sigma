import type {
  AgentEventEnvelope,
  ContextItem,
  JsonValue,
  ModelGateway,
  RunMode,
  RunOutcome,
  RunStore,
  ToolEffect,
  ToolExecutor
} from "agent-protocol";
import type { KernelState } from "agent-kernel";
import type { AsyncQueue } from "./async-queue.js";

export interface RuntimeOptions {
  gateway: ModelGateway;
  tools: ToolExecutor;
  store: RunStore;
  runDeadlineMs?: number;
  maxParallelTools?: number;
  permissionMode?: "ask" | "auto" | "deny";
  outputReserveTokens?: number;
  joinChildren?(parentSessionId: string, signal: AbortSignal): Promise<ChildJoinSummary>;
  cancelChildren?(parentSessionId: string, reason: string): Promise<void> | void;
}

export interface ChildJoinSummary {
  evidence: JsonValue[];
  failures: string[];
}

export interface ApprovalWaiter {
  effects: readonly ToolEffect[];
  recovered?: boolean;
  resolve(decision: "allow" | "deny" | "always_allow"): void;
}

export interface QueuedFollowUp {
  id: string;
  text: string;
}

export interface RuntimeSession {
  sessionId: string;
  runId: string;
  modelTurn: number;
  workspacePath: string;
  mode: RunMode;
  writeScope: string[];
  strictWriteScope: boolean;
  state: KernelState;
  seq: number;
  controller: AbortController | null;
  turnController: AbortController | null;
  deadlineTimer: ReturnType<typeof setTimeout> | null;
  running: Promise<void> | null;
  subscribers: Set<AsyncQueue<AgentEventEnvelope>>;
  approvals: Map<string, ApprovalWaiter>;
  alwaysAllowedEffects: Set<string>;
  steeringPending: number;
  followUps: QueuedFollowUp[];
  contextItems: ContextItem[];
  loadedContextIds: Set<string>;
  lastOutcome?: RunOutcome;
  outcomeWaiters: Array<(outcome: RunOutcome) => void>;
}
