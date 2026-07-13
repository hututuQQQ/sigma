import type {
  AgentEventEnvelope,
  BudgetLimits,
  ContextItem,
  JsonValue,
  ModelExecutionRole,
  ModelGateway,
  RunMode,
  RunOutcome,
  RunStore,
  ToolEffect,
  ToolCallApproval,
  ToolExecutor
} from "agent-protocol";
import type { KernelState } from "agent-kernel";
import type {
  FrozenAgentProfile,
  FrozenSessionCustomization,
  HookDefinition,
  HookRunnerPort,
  RuntimeHookArtifact,
  SkillCatalog
} from "agent-extensions";
import type { ProcessExecutionPort } from "agent-platform";
import type { ProcessHandle } from "agent-execution";
import type { CheckpointRestoreFaultEvent } from "agent-checkpoint";
import type { ReviewerPort } from "./reviewer.js";
import type { AsyncQueue } from "./async-queue.js";

export interface RuntimeAgentProfile {
  profile: FrozenAgentProfile;
  source: "home" | "workspace" | "builtin";
}

export interface RuntimeOptions {
  gateway: ModelGateway;
  tools: ToolExecutor;
  store: RunStore;
  runDeadlineMs?: number;
  maxParallelTools?: number;
  permissionMode?: "ask" | "auto" | "deny";
  outputReserveTokens?: number;
  budgetLimits?: BudgetLimits;
  checkpointMaxFiles?: number;
  checkpointMaxBytes?: number;
  checkpointRestoreFaultInjector?: (event: CheckpointRestoreFaultEvent) => void | Promise<void>;
  skills?: SkillCatalog;
  hooks?: readonly HookDefinition[];
  hookArtifacts?: readonly RuntimeHookArtifact[];
  hookRunner?: HookRunnerPort;
  agentProfileHookRunner?: HookRunnerPort;
  reviewer?: ReviewerPort;
  reviewerForSession?(session: Pick<RuntimeSession, "sessionId" | "modelRole" | "profile">): ReviewerPort;
  profile?: FrozenAgentProfile;
  profileSource?: "home" | "workspace" | "builtin";
  availableProfiles?: readonly RuntimeAgentProfile[];
  gatewayForRole?(role: ModelExecutionRole, profile: FrozenAgentProfile | undefined): ModelGateway;
  execution?: ProcessExecutionPort;
  joinChildren?(parentSessionId: string, signal: AbortSignal): Promise<ChildJoinSummary>;
  cancelChildren?(parentSessionId: string, reason: string): Promise<void> | void;
  hasActiveChildren?(parentSessionId: string): Promise<boolean> | boolean;
}

export interface ChildJoinSummary {
  evidence: JsonValue[];
  failures: string[];
}

export interface ApprovalWaiter {
  effects: readonly ToolEffect[];
  recovered?: boolean;
  resolving?: boolean;
  external?: {
    callId: string;
    toolName: string;
    childId: string;
  };
  resolve(decision: "allow" | "deny" | "always_allow"): void;
}

export interface QueuedFollowUp {
  id: string;
  text: string;
}

export interface OutcomeWaiter {
  runId: string;
  resolve(outcome: RunOutcome): void;
}

export interface IdleWaiter {
  resolve(): void;
  reject(error: unknown): void;
}

export interface ChildCheckpointRecovery {
  checkpointId: string;
  currentManifestDigest: string;
  sourceSessionId: string;
  childId: string;
  checkpointStatus: "open" | "sealed";
  planNodeIds: string[];
  recordedDecision?: "restore" | "keep";
}

export type OpenCheckpointRecovery = {
  checkpointId: string;
  currentManifestDigest: string;
} | ChildCheckpointRecovery;

export interface RuntimeSession {
  sessionId: string;
  /** Durable ancestry marker. Undefined means this is a root user session. */
  parentSessionId?: string;
  runId: string;
  modelTurn: number;
  workspacePath: string;
  mode: RunMode;
  writeScope: string[];
  strictWriteScope: boolean;
  workspaceLeaseInherited?: boolean;
  gateway: ModelGateway;
  modelRole: ModelExecutionRole;
  profile?: FrozenAgentProfile;
  profileSource?: "home" | "workspace" | "builtin";
  frozenCustomization?: FrozenSessionCustomization;
  state: KernelState;
  seq: number;
  controller: AbortController | null;
  turnController: AbortController | null;
  deadlineTimer: ReturnType<typeof setTimeout> | null;
  running: Promise<void> | null;
  subscribers: Set<AsyncQueue<AgentEventEnvelope>>;
  approvals: Map<string, ApprovalWaiter>;
  /** One-shot human grants, bound to a call and intentionally not restored. */
  callApprovals: Map<string, ToolCallApproval>;
  alwaysAllowedEffects: Set<string>;
  /** Runtime-local broker handles; never restored across process restart. */
  processHandles?: Map<string, ProcessHandle>;
  steeringPending: number;
  followUps: QueuedFollowUp[];
  contextItems: ContextItem[];
  loadedContextIds: Set<string>;
  lastOutcome?: RunOutcome;
  outcomeWaiters: OutcomeWaiter[];
  idleWaiters: IdleWaiter[];
  runError?: Error;
  openCheckpointRecovery?: OpenCheckpointRecovery;
}
