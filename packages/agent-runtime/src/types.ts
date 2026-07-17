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
import type { ProcessExecutionPort, RuntimeEnvironment } from "agent-platform";
import type { ProcessHandle } from "agent-execution";
import type { ReviewerPort } from "./reviewer.js";
import type { AsyncQueue } from "./async-queue.js";
import type { ApprovalBinding } from "./approval-binding.js";
import type { SubjectAttestationContextV1 } from "./subject-attestation.js";

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
  /** Outer runtime liveness watchdog. By default it trails a tool's own idle
   * deadline so broker-managed foreground execution remains authoritative.
   * Set false to disable it, or a positive number for an explicit timeout. */
  toolIdleWatchdogMs?: number | false;
  permissionMode?: "ask" | "auto" | "deny";
  /** Whether this runtime surface can answer a human approval prompt. */
  interactiveApprovals?: boolean;
  /** Trusted-launcher authorization for headless open-world calls inside an
   * already disposable container. Never derive this from workspace state. */
  openWorldAuthorization?: "disposable-container";
  outputReserveTokens?: number;
  budgetLimits?: BudgetLimits;
  checkpointMaxFiles?: number;
  checkpointMaxBytes?: number;
  skills?: SkillCatalog;
  hooks?: readonly HookDefinition[];
  hookArtifacts?: readonly RuntimeHookArtifact[];
  hookRunner?: HookRunnerPort;
  agentProfileHookRunner?: HookRunnerPort;
  reviewer?: ReviewerPort;
  reviewerForSession?(session: Pick<RuntimeSession, "identity" | "services">): ReviewerPort;
  profile?: FrozenAgentProfile;
  profileSource?: "home" | "workspace" | "builtin";
  availableProfiles?: readonly RuntimeAgentProfile[];
  gatewayForRole?(role: ModelExecutionRole, profile: FrozenAgentProfile | undefined): ModelGateway;
  execution?: ProcessExecutionPort;
  runtimeEnvironment?: RuntimeEnvironment;
  /** Runtime-authority provenance supplied by a trusted launcher. Never derive
   * this from the workspace being operated on. */
  subjectAttestation?: SubjectAttestationContextV1;
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
  /** Exact durable authority shown to the user for this request. */
  binding?: ApprovalBinding;
  recovered?: boolean;
  resolving?: boolean;
  external?: {
    callId: string;
    toolName: string;
    childId: string;
  };
  resolve(decision: "allow" | "deny" | "always_allow"): void;
}

export interface CallApprovalGrant extends ToolCallApproval, ApprovalBinding {
  /** Committed to the session effect policy only after this exact grant is consumed. */
  alwaysAllowEffectGrant?: string;
}

export interface QueuedFollowUp {
  id: string;
  text: string;
}

export interface OutcomeWaiter {
  runId: string;
  resolve(outcome: RunOutcome): void;
  reject(error: unknown): void;
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

export interface RuntimeSessionIdentity {
  readonly sessionId: string;
  readonly parentSessionId?: string;
  readonly workspacePath: string;
  readonly writeScope: string[];
  readonly strictWriteScope: boolean;
  readonly workspaceLeaseInherited?: boolean;
}

export interface RuntimeSessionDurableState {
  runId: string;
  modelTurn: number;
  mode: RunMode;
  state: KernelState;
  seq: number;
  frozenCustomization?: FrozenSessionCustomization;
}

export interface RuntimeSessionExecutionState {
  controller: AbortController | null;
  turnController: AbortController | null;
  deadlineTimer: ReturnType<typeof setTimeout> | null;
  running: Promise<void> | null;
  /** Runtime-local broker handles; never restored across process restart. */
  processHandles: Map<string, ProcessHandle>;
}

export interface RuntimeSessionInteractionState {
  subscribers: Set<AsyncQueue<AgentEventEnvelope>>;
  approvals: Map<string, ApprovalWaiter>;
  /** One-shot grants, bound to a call and intentionally not restored. */
  callApprovals: Map<string, CallApprovalGrant>;
  alwaysAllowedEffects: Set<string>;
  steeringPending: number;
  followUps: QueuedFollowUp[];
  contextItems: ContextItem[];
  loadedContextIds: Set<string>;
  outcomeWaiters: OutcomeWaiter[];
  idleWaiters: IdleWaiter[];
}

export interface RuntimeSessionRecoveryState {
  lastOutcome?: RunOutcome;
  runError?: Error;
  openCheckpointRecovery?: OpenCheckpointRecovery;
}

export interface RuntimeSessionServices {
  gateway: ModelGateway;
  modelRole: ModelExecutionRole;
  profile?: FrozenAgentProfile;
  profileSource?: "home" | "workspace" | "builtin";
}

export interface RuntimeSession {
  readonly identity: RuntimeSessionIdentity;
  readonly durable: RuntimeSessionDurableState;
  readonly execution: RuntimeSessionExecutionState;
  readonly interaction: RuntimeSessionInteractionState;
  readonly recovery: RuntimeSessionRecoveryState;
  readonly services: RuntimeSessionServices;
}
