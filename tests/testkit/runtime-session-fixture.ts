import { createKernelState, type KernelState } from "../../packages/agent-kernel/src/index.js";
import type {
  ModelGateway,
  ModelRequest,
  ModelResponse,
  ModelStreamEvent,
  RunMode
} from "../../packages/agent-protocol/src/index.js";
import {
  createRuntimeSessionAggregate,
  type RuntimeSession,
  type RuntimeSessionDurableState,
  type RuntimeSessionExecutionState,
  type RuntimeSessionIdentity,
  type RuntimeSessionInteractionState,
  type RuntimeSessionRecoveryState,
  type RuntimeSessionServices
} from "../../packages/agent-runtime/src/testing.js";

class FixtureGateway implements ModelGateway {
  readonly provider = "test";
  readonly model = "fixture";
  readonly capabilities = {
    contextWindowTokens: 32_000,
    maxOutputTokens: 4_096,
    tools: true,
    parallelTools: true,
    reasoning: false,
    structuredOutput: false,
    promptCache: false,
    tokenizer: "approximate" as const
  };
  async complete(_request: ModelRequest): Promise<ModelResponse> {
    throw new Error("Fixture gateway must not execute a model request.");
  }
  async *stream(_request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    yield await Promise.reject(new Error("Fixture gateway must not stream a model request."));
  }
  async countTokens(): Promise<number> { return 1; }
}

export interface RuntimeSessionFixtureOptions {
  sessionId?: string;
  runId?: string;
  workspacePath?: string;
  mode?: RunMode;
  state?: KernelState;
  seq?: number;
  identity?: Partial<RuntimeSessionIdentity>;
  durable?: Partial<RuntimeSessionDurableState>;
  execution?: Partial<RuntimeSessionExecutionState>;
  interaction?: Partial<RuntimeSessionInteractionState>;
  recovery?: Partial<RuntimeSessionRecoveryState>;
  services?: Partial<RuntimeSessionServices>;
}

export function runtimeSessionFixture(options: RuntimeSessionFixtureOptions = {}): RuntimeSession {
  const sessionId = options.sessionId ?? options.identity?.sessionId ?? options.state?.sessionId ?? "session";
  const runId = options.runId ?? options.state?.runId ?? "run";
  const mode = options.mode ?? options.state?.mode ?? "change";
  const state = options.state ?? createKernelState({
    sessionId,
    ...(options.identity?.parentSessionId ? { parentSessionId: options.identity.parentSessionId } : {}),
    runId,
    mode,
    startedAt: "2026-01-01T00:00:00.000Z",
    deadlineAt: "2026-01-01T00:01:00.000Z"
  });
  const session = createRuntimeSessionAggregate({
    sessionId,
    runId,
    modelTurn: 0,
    workspacePath: options.workspacePath ?? options.identity?.workspacePath ?? process.cwd(),
    mode,
    writeScope: [...(options.identity?.writeScope ?? [])],
    strictWriteScope: options.identity?.strictWriteScope ?? false,
    ...(options.identity?.workspaceLeaseInherited ? { workspaceLeaseInherited: true } : {}),
    gateway: new FixtureGateway(),
    modelRole: "orchestrator",
    state,
    seq: options.seq ?? 0,
    controller: null,
    turnController: null,
    deadlineTimer: null,
    running: null,
    subscribers: new Set(),
    approvals: new Map(),
    callApprovals: new Map(),
    alwaysAllowedEffects: new Set(),
    processHandles: new Map(),
    steeringPending: 0,
    followUps: [],
    contextItems: [],
    loadedContextIds: new Set(),
    outcomeWaiters: [],
    idleWaiters: []
  });
  Object.assign(session.durable, options.durable);
  Object.assign(session.execution, options.execution);
  Object.assign(session.interaction, options.interaction);
  Object.assign(session.recovery, options.recovery);
  Object.assign(session.services, options.services);
  return session;
}
