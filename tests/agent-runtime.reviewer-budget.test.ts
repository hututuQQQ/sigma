import { describe, expect, it } from "vitest";
import { createKernelState, evolve } from "../packages/agent-kernel/src/index.js";
import {
  EVENT_SCHEMA_VERSION,
  type AgentEventEnvelope,
  type AgentEventType,
  type BudgetLimits,
  type ContextAuthority,
  type JsonValue,
  type ModelCapabilities,
  type ModelGateway,
  type ModelMessage,
  type ModelRequest,
  type ModelResponse,
  type ModelStreamEvent,
  type ModelToolDefinition,
  type ReviewEvidence,
  type ValidationEvidence,
  type WorkspaceDeltaEvidence
} from "../packages/agent-protocol/src/index.js";
import type { ModelRouteConstraints } from "../packages/agent-model/src/index.js";
import { BudgetController, BudgetExceededError } from "../packages/agent-runtime/src/budget-controller.js";
import { ReviewCoordinator } from "../packages/agent-runtime/src/review-coordinator.js";
import { ModelReviewer, type ReviewerPort } from "../packages/agent-runtime/src/reviewer.js";
import type { RuntimeSession } from "../packages/agent-runtime/src/types.js";

const now = "2026-07-11T00:00:00.000Z";

class ReviewerGateway implements ModelGateway {
  readonly provider = "deepseek";
  readonly model = "deepseek-v4-pro";
  readonly capabilities: ModelCapabilities = {
    contextWindowTokens: 16_000,
    maxOutputTokens: 100,
    tools: false,
    parallelTools: false,
    reasoning: false,
    structuredOutput: false,
    promptCache: false,
    tokenizer: "approximate"
  };
  calls = 0;

  constructor(
    private readonly failure?: Error,
    private readonly content = '{"verdict":"approved","findings":[]}'
  ) {}

  async complete(_request: ModelRequest): Promise<ModelResponse> {
    this.calls += 1;
    if (this.failure) throw this.failure;
    return {
      message: { role: "assistant", content: this.content },
      finishReason: "stop",
      usage: {
        inputTokens: 80,
        outputTokens: 10,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        providerReported: true,
        costMicroUsd: 7,
        latencyMs: 1,
        retryAttempt: 0
      }
    };
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    yield { type: "done", response: await this.complete(request) };
  }

  async countTokens(): Promise<number> {
    return 100;
  }
}

class FallbackReviewerGateway extends ReviewerGateway {
  reservedAtInvocation?: RuntimeSession["state"]["budget"]["reserved"];

  constructor(private readonly target: RuntimeSession) {
    super();
  }

  async budgetPlan(
    _messages: ModelMessage[],
    _tools: ModelToolDefinition[],
    _maxOutputTokens: number,
    _remainingBudgetMicroUsd: number
  ): Promise<{
      estimatedInputTokens: number;
      reservedInputTokens: number;
      reservedOutputTokens: number;
      reservedCostMicroUsd: number;
      reservedModelTurns: number;
      attemptReservations: Array<{ inputTokens: number; outputTokens: number; costMicroUsd: number }>;
      constraints: ModelRouteConstraints;
    }> {
    return {
      estimatedInputTokens: 100,
      reservedInputTokens: 240,
      reservedOutputTokens: 240,
      reservedCostMicroUsd: 300,
      reservedModelTurns: 2,
      attemptReservations: [
        { inputTokens: 120, outputTokens: 120, costMicroUsd: 150 },
        { inputTokens: 120, outputTokens: 120, costMicroUsd: 150 }
      ],
      constraints: { estimatedInputTokens: 100, maxOutputTokens: 100, remainingBudgetMicroUsd: 1_000 }
    };
  }

  routingIdentity(): { role: "reviewer"; routeId: string } {
    return { role: "reviewer", routeId: "review-route" };
  }

  async completeWithConstraints(request: ModelRequest, _constraints: ModelRouteConstraints): Promise<ModelResponse> {
    this.reservedAtInvocation = { ...this.target.state.budget.reserved };
    const response = await super.complete(request);
    return {
      ...response,
      usage: { ...response.usage, retryAttempt: 1 },
      routeId: "review-route",
      role: "reviewer",
      modelSpecId: "deepseek/deepseek-v4-pro",
      providerId: "deepseek",
      tokenizerId: "sigma/cjk-byte-v1",
      tokenizerAccuracy: "approximate",
      attempt: 1
    } as ModelResponse;
  }
}

function limits(overrides: Partial<BudgetLimits> = {}): BudgetLimits {
  return {
    inputTokens: 1_000,
    outputTokens: 1_000,
    costMicroUsd: 1_000,
    modelTurns: 10,
    toolCalls: 10,
    children: 1,
    maxDepth: 1,
    ...overrides
  };
}

function delta(): WorkspaceDeltaEvidence {
  return {
    evidenceId: "delta",
    sessionId: "session",
    runId: "run",
    kind: "workspace_delta",
    status: "passed",
    createdAt: now,
    producer: { authority: "runtime", id: "checkpoint" },
    summary: "changed",
    data: {
      checkpointId: "checkpoint",
      delta: { added: [], modified: ["src/code.ts"], deleted: [] },
      reviewDiff: "--- a/src/code.ts\n+++ b/src/code.ts\n[metadata before=file:33188 after=file:33188]"
    }
  };
}

function validation(): ValidationEvidence {
  return {
    evidenceId: "validation",
    sessionId: "session",
    runId: "run",
    kind: "validation",
    status: "passed",
    createdAt: now,
    producer: { authority: "tool", id: "validate" },
    summary: "passed",
    data: {
      validator: "command",
      exitCode: 0,
      artifactIds: [],
      workspaceDeltaEvidenceIds: ["delta"]
    }
  };
}

function runtimeSession(budgetLimits = limits()): RuntimeSession {
  const state = createKernelState({
    sessionId: "session",
    runId: "run",
    mode: "change",
    startedAt: now,
    deadlineAt: "2026-07-12T00:00:00.000Z"
  });
  state.budget.limits = budgetLimits;
  state.evidence = [delta(), validation()];
  state.plan = { revision: 1, goal: "Review the change", nodes: [] };
  return {
    sessionId: "session",
    runId: "run",
    modelTurn: 0,
    workspacePath: ".",
    mode: "change",
    writeScope: [],
    strictWriteScope: false,
    gateway: new ReviewerGateway(),
    modelRole: "orchestrator",
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
    contextItems: [],
    loadedContextIds: new Set(),
    outcomeWaiters: [],
    idleWaiters: []
  };
}

function harness(target: RuntimeSession, crashBeforeUsage = false): {
  budgets: BudgetController;
  emit: (
    session: RuntimeSession,
    type: AgentEventType,
    authority: Exclude<ContextAuthority, "external_verifier">,
    value: unknown
  ) => Promise<AgentEventEnvelope>;
  events: AgentEventType[];
} {
  const events: AgentEventType[] = [];
  let shouldCrash = crashBeforeUsage;
  const emit = async (
    session: RuntimeSession,
    type: AgentEventType,
    authority: Exclude<ContextAuthority, "external_verifier">,
    value: unknown
  ): Promise<AgentEventEnvelope> => {
    if (type === "usage.recorded" && shouldCrash) {
      shouldCrash = false;
      throw new Error("injected crash before usage persistence");
    }
    const event: AgentEventEnvelope = {
      schemaVersion: EVENT_SCHEMA_VERSION,
      seq: ++session.seq,
      eventId: `event-${session.seq}`,
      sessionId: session.sessionId,
      runId: session.runId,
      occurredAt: now,
      type,
      authority,
      payload: value as JsonValue
    };
    events.push(type);
    session.state = evolve(session.state, event);
    return event;
  };
  return { budgets: new BudgetController(emit), emit, events };
}

describe("independent reviewer budget accounting", () => {
  it("rejects exhausted reviewer budget before invoking the model", async () => {
    const target = runtimeSession(limits({ inputTokens: 119 }));
    const gateway = new ReviewerGateway();
    const { budgets, emit, events } = harness(target);
    const coordinator = new ReviewCoordinator(new ModelReviewer(gateway), emit, budgets);

    await expect(coordinator.maybeReview(target, new AbortController().signal))
      .rejects.toBeInstanceOf(BudgetExceededError);
    expect(gateway.calls).toBe(0);
    expect(events).toContain("budget.exhausted");
    expect(events).not.toContain("review.started");
  });

  it("commits actual reviewer usage to the session ledger", async () => {
    const target = runtimeSession();
    const gateway = new ReviewerGateway();
    const { budgets, emit } = harness(target);
    const coordinator = new ReviewCoordinator(new ModelReviewer(gateway), emit, budgets);

    await coordinator.maybeReview(target, new AbortController().signal);

    expect(gateway.calls).toBe(1);
    expect(target.state.budget.reserved).toMatchObject({ inputTokens: 0, outputTokens: 0, modelTurns: 0 });
    expect(target.state.budget.consumed).toMatchObject({
      inputTokens: 80,
      outputTokens: 10,
      costMicroUsd: 7,
      modelTurns: 1
    });
    expect(target.state.usage).toHaveLength(1);
    expect(target.state.usage[0]).toMatchObject({
      role: "reviewer", providerId: "deepseek", modelId: "deepseek-v4-pro"
    });
    expect(target.state.evidence.find((item) => item.kind === "review")).toMatchObject({ status: "passed" });
  });

  it("settles a failed reviewer attempt conservatively without approving it", async () => {
    const target = runtimeSession();
    const gateway = new ReviewerGateway(new Error("provider unavailable"));
    const { budgets, emit } = harness(target);
    const coordinator = new ReviewCoordinator(new ModelReviewer(gateway), emit, budgets);

    await coordinator.maybeReview(target, new AbortController().signal);

    expect(gateway.calls).toBe(1);
    expect(target.state.budget.reserved.inputTokens).toBe(0);
    expect(target.state.budget.consumed).toMatchObject({ inputTokens: 120, outputTokens: 0, modelTurns: 1 });
    expect(target.state.usage[0]).toMatchObject({ role: "reviewer", providerReported: false });
    expect(target.state.evidence.find((item) => item.kind === "review")).toMatchObject({
      status: "failed",
      data: { verdict: "changes_requested" }
    });
  });

  it("reserves every fallback attempt before invocation and commits the attempts actually used", async () => {
    const target = runtimeSession();
    const gateway = new FallbackReviewerGateway(target);
    const { budgets, emit } = harness(target);

    await new ReviewCoordinator(new ModelReviewer(gateway), emit, budgets)
      .maybeReview(target, new AbortController().signal);

    expect(gateway.reservedAtInvocation).toMatchObject({
      inputTokens: 240,
      outputTokens: 240,
      costMicroUsd: 300,
      modelTurns: 2
    });
    expect(target.state.budget.reserved.modelTurns).toBe(0);
    expect(target.state.budget.consumed.modelTurns).toBe(2);
    expect(target.state.usage[0]).toMatchObject({ role: "reviewer", attempt: 2 });
  });

  it("recovers a committed reviewer reservation without replay or double charge", async () => {
    const target = runtimeSession();
    const gateway = new ReviewerGateway();
    const first = harness(target, true);
    const coordinator = new ReviewCoordinator(new ModelReviewer(gateway), first.emit, first.budgets);

    await expect(coordinator.maybeReview(target, new AbortController().signal))
      .rejects.toThrow("injected crash");
    const consumed = structuredClone(target.state.budget.consumed);
    expect(gateway.calls).toBe(1);
    expect(target.state.usage).toHaveLength(0);

    const recovered = harness(target);
    await new ReviewCoordinator(new ModelReviewer(gateway), recovered.emit, recovered.budgets)
      .maybeReview(target, new AbortController().signal);

    expect(gateway.calls).toBe(1);
    expect(target.state.budget.consumed).toEqual(consumed);
    expect(target.state.usage).toHaveLength(1);
    expect(target.state.evidence.find((item) => item.kind === "review")).toMatchObject({ status: "failed" });
  });

  it("keeps non-model reviewer ports compatible without fabricating usage", async () => {
    const target = runtimeSession();
    const fake: ReviewerPort = {
      reviewerId: "fake-port",
      review: async (input): Promise<ReviewEvidence> => ({
        evidenceId: "fake-review",
        sessionId: input.sessionId,
        runId: input.runId,
        kind: "review",
        status: "passed",
        createdAt: now,
        producer: { authority: "runtime", id: "fake-port" },
        summary: "approved",
        data: {
          reviewerId: "fake-port",
          verdict: "approved",
          findings: [],
          workspaceDeltaEvidenceIds: input.workspaceDeltas.map((item) => item.evidenceId)
        }
      })
    };
    const { budgets, emit } = harness(target);

    await new ReviewCoordinator(fake, emit, budgets).maybeReview(target, new AbortController().signal);

    expect(target.state.usage).toHaveLength(0);
    expect(target.state.budget.consumed.modelTurns).toBe(0);
    expect(target.state.evidence.find((item) => item.kind === "review")).toMatchObject({ status: "passed" });
  });

  it("fails closed for non-strict JSON and incomplete review material", async () => {
    const input = {
      sessionId: "session", runId: "run", goal: "Review safely",
      workspaceDeltas: [delta()], validations: [validation()]
    };
    const decorated = await new ModelReviewer(new ReviewerGateway(
      undefined,
      'Here is the result: {"verdict":"approved","findings":[]}'
    )).review(input, new AbortController().signal);
    expect(decorated).toMatchObject({ status: "failed", data: { verdict: "changes_requested" } });

    const truncatedDelta = delta();
    truncatedDelta.data.reviewDiff += "\n[review diff truncated]";
    const truncated = await new ModelReviewer(new ReviewerGateway()).review({
      ...input, workspaceDeltas: [truncatedDelta]
    }, new AbortController().signal);
    expect(truncated).toMatchObject({
      status: "failed",
      data: { verdict: "changes_requested", findings: [expect.stringContaining("truncated")] }
    });
  });
});
