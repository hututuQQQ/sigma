import { describe, expect, it } from "vitest";
import { createKernelState, evolve } from "../packages/agent-kernel/src/index.js";
import {
  EVENT_SCHEMA_VERSION,
  type AgentEventEnvelope,
  type AgentEventType,
  type BudgetAmounts,
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
import { BudgetController } from "../packages/agent-runtime/src/budget-controller.js";
import { reviewValidationRequiredPaths } from "../packages/agent-runtime/src/assurance-engine.js";
import { COMPLETION_CANDIDATE_MAX_SERIALIZED_UTF8_BYTES } from "../packages/agent-runtime/src/completion-review-candidate.js";
import { ReviewCoordinator } from "../packages/agent-runtime/src/review-coordinator.js";
import { candidateReviewerBudgetReserve } from "../packages/agent-runtime/src/reviewer-budget-reserve.js";
import {
  fitPreparedBudget,
  maximumAttemptOutputTokens
} from "../packages/agent-runtime/src/model-budget-convergence.js";
import {
  currentFrontierReview,
  currentWorkspaceReview
} from "../packages/agent-runtime/src/mutation-evidence.js";
import {
  completionCandidateDigest,
  isAccountableReviewer,
  ModelReviewer,
  type ReviewerPort
} from "../packages/agent-runtime/src/reviewer.js";
import type { RuntimeSession } from "../packages/agent-runtime/src/types.js";
import { runtimeSessionFixture } from "./testkit/runtime-session-fixture.js";

const now = "2026-07-11T00:00:00.000Z";

class ReviewerGateway implements ModelGateway {
  readonly provider = "deepseek";
  readonly model = "deepseek-v4-pro";
  readonly maxTokensPerUtf8Byte: number = 1;
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
  readonly requests: ModelRequest[] = [];

  constructor(
    private readonly failure?: Error,
    private readonly content = '{"verdict":"approved","findings":[]}',
    private readonly reportedInputTokens = 80
  ) {}

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.calls += 1;
    this.requests.push(request);
    if (this.failure) throw this.failure;
    return {
      message: { role: "assistant", content: this.content },
      finishReason: "stop",
      usage: {
        inputTokens: this.reportedInputTokens,
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

class CrossTokenizerReviewerGateway extends ReviewerGateway {
  override readonly maxTokensPerUtf8Byte: number = 2;
  override readonly capabilities: ModelCapabilities = {
    ...super.capabilities,
    contextWindowTokens: 100_000,
    maxOutputTokens: 2_048,
    tokenizer: "reviewer-byte-tokenizer"
  };

  override async countTokens(messages: ModelMessage[]): Promise<number> {
    return 4_000 + 2 * Buffer.byteLength(messages.map((message) => message.content).join("\n"), "utf8");
  }

  async budgetPlan(
    messages: ModelMessage[],
    _tools: ModelToolDefinition[],
    maxOutputTokens: number,
    remainingBudgetMicroUsd: number,
    minimumInputTokens = 0
  ): Promise<{
      estimatedInputTokens: number;
      reservedInputTokens: number;
      reservedOutputTokens: number;
      reservedCostMicroUsd: number;
      reservedModelTurns: number;
      attemptReservations: Array<{ inputTokens: number; outputTokens: number; costMicroUsd: number }>;
      constraints: ModelRouteConstraints;
    }> {
    const estimatedInputTokens = Math.max(await this.countTokens(messages), minimumInputTokens);
    return {
      estimatedInputTokens,
      reservedInputTokens: estimatedInputTokens,
      reservedOutputTokens: maxOutputTokens,
      reservedCostMicroUsd: 1,
      reservedModelTurns: 1,
      attemptReservations: [{ inputTokens: estimatedInputTokens, outputTokens: maxOutputTokens, costMicroUsd: 1 }],
      constraints: { estimatedInputTokens, maxOutputTokens, remainingBudgetMicroUsd }
    };
  }

  routingIdentity(): { role: "reviewer"; routeId: string } {
    return { role: "reviewer", routeId: "cross-tokenizer-review" };
  }
}

class BoundarySensitiveReviewerGateway extends ReviewerGateway {
  override readonly maxTokensPerUtf8Byte: number = 1;
  override readonly capabilities: ModelCapabilities = {
    ...super.capabilities,
    contextWindowTokens: 100_000,
    maxOutputTokens: 2_048
  };

  override async countTokens(messages: ModelMessage[]): Promise<number> {
    const payload = JSON.parse(messages.at(-1)?.content ?? "{}") as {
      completionCandidate?: { message?: string; summary?: string; warnings?: string[] };
    };
    const candidate = payload.completionCandidate;
    if (candidate?.message === "" && candidate.summary === "" && candidate.warnings?.length === 0) return 1;
    return messages.reduce((total, message) => total + Buffer.byteLength(message.content, "utf8"), 0);
  }
}

class FallbackReviewerGateway extends ReviewerGateway {
  reservedAtInvocation?: RuntimeSession["durable"]["state"]["budget"]["reserved"];

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
    this.reservedAtInvocation = { ...this.target.durable.state.budget.reserved };
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

function validation(coveredPaths = ["src/code.ts"]): ValidationEvidence {
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
      frontierRevision: 1,
      stateDigest: "a".repeat(64),
      coveredPaths,
      claim: {
        kind: "typecheck",
        commandDigest: "c".repeat(64),
        strength: "structural",
        independence: "cross_method",
        assertionMode: "explicit",
        subject: {
          projectId: ".",
          configPaths: [],
          selectedTests: [],
          exactFiles: []
        },
        status: "passed"
      }
    }
  };
}

const beforeDigest = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const afterDigest = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

function completeMixedDelta(): WorkspaceDeltaEvidence {
  return {
    ...delta(),
    data: {
      checkpointId: "checkpoint",
      delta: { added: ["assets/blob.bin"], modified: ["src/code.ts"], deleted: [] },
      reviewDiff: [
        "--- a/src/code.ts",
        "+++ b/src/code.ts",
        "[metadata before=file:33188 after=file:33188]",
        "[before]",
        "export const value = 1;",
        "[after]",
        "export const value = 2;"
      ].join("\n"),
      reviewDiffPaths: ["src/code.ts"],
      opaqueArtifacts: [{
        path: "assets/blob.bin",
        after: { digest: afterDigest, sizeBytes: 512 * 1024 }
      }]
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
  state.deadlineRemainingMs = 60_000;
  state.budget.limits = budgetLimits;
  state.evidence = [delta(), validation()];
  state.mutationFrontier = {
    revision: 1,
    baselineManifestDigest: "0".repeat(64),
    currentStateDigest: "a".repeat(64),
    changedPaths: ["src/code.ts"],
    sourceCheckpointIds: ["checkpoint"]
  };
  state.plan = { revision: 1, goal: "Review the change", nodes: [] };
  return runtimeSessionFixture({ state, services: { gateway: new ReviewerGateway() } });
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
      seq: ++session.durable.seq,
      eventId: `event-${session.durable.seq}`,
      sessionId: session.identity.sessionId,
      runId: session.durable.runId,
      occurredAt: now,
      type,
      authority,
      payload: value as JsonValue
    };
    events.push(type);
    session.durable.state = evolve(session.durable.state, event);
    return event;
  };
  return { budgets: new BudgetController(emit), emit, events };
}

describe("independent reviewer budget accounting", () => {
  it("persists reviewer reserve failure instead of throwing through completion", async () => {
    const target = runtimeSession(limits({ inputTokens: 119 }));
    const gateway = new ReviewerGateway();
    const { budgets, emit, events } = harness(target);
    const coordinator = new ReviewCoordinator(new ModelReviewer(gateway), emit, budgets);

    await expect(coordinator.maybeReview(target, new AbortController().signal)).resolves.toBeUndefined();
    expect(gateway.calls).toBe(0);
    expect(events).toContain("budget.exhausted");
    expect(events).not.toContain("review.started");
    expect(target.durable.state.evidence.find((item) => item.kind === "review")).toMatchObject({
      status: "failed",
      data: { verdict: "changes_requested", failureKind: "infrastructure" }
    });
  });

  it("commits actual reviewer usage to the session ledger", async () => {
    const target = runtimeSession();
    const gateway = new ReviewerGateway();
    const { budgets, emit } = harness(target);
    const coordinator = new ReviewCoordinator(new ModelReviewer(gateway), emit, budgets);

    await coordinator.maybeReview(target, new AbortController().signal);

    expect(gateway.calls).toBe(1);
    expect(target.durable.state.budget.reserved).toMatchObject({ inputTokens: 0, outputTokens: 0, modelTurns: 0 });
    expect(target.durable.state.budget.consumed).toMatchObject({
      inputTokens: 80,
      outputTokens: 10,
      costMicroUsd: 7,
      modelTurns: 1
    });
    expect(target.durable.state.usage).toHaveLength(1);
    expect(target.durable.state.usage[0]).toMatchObject({
      role: "reviewer", providerId: "deepseek", modelId: "deepseek-v4-pro"
    });
    expect(target.durable.state.evidence.find((item) => item.kind === "review")).toMatchObject({ status: "passed" });
  });

  it("deducts the reviewer quote in every model-budget dimension before solver admission", async () => {
    const target = runtimeSession();
    const gateway = new ReviewerGateway();
    const reviewer = new ModelReviewer(gateway);
    const reserve = await candidateReviewerBudgetReserve(target, reviewer, 10_000);
    const solver = {
      estimatedInputTokens: 100,
      reserved: { inputTokens: 100, outputTokens: 50, costMicroUsd: 20, modelTurns: 1 },
      reservedAttempts: 1,
      attemptReservations: [{ inputTokens: 100, outputTokens: 50, costMicroUsd: 20 }]
    };
    const enough: BudgetAmounts = {
      inputTokens: 100 + reserve.inputTokens,
      outputTokens: 50 + reserve.outputTokens,
      costMicroUsd: 20 + reserve.costMicroUsd,
      modelTurns: 1 + reserve.modelTurns,
      toolCalls: 10,
      children: 0
    };
    for (const dimension of ["inputTokens", "outputTokens", "costMicroUsd", "modelTurns"] as const) {
      expect(fitPreparedBudget(solver, {
        ...enough,
        [dimension]: enough[dimension] - 1
      }, 1, reserve), dimension).toBeNull();
    }
    expect(fitPreparedBudget(solver, enough, 1, reserve)).not.toBeNull();

    target.durable.state.budget.limits = { ...enough, maxDepth: 0 };
    const { budgets, emit } = harness(target);
    const solverReservation = await budgets.reserve(target, "solver:completion", solver.reserved);
    await budgets.commitMeasured(target, solverReservation, solver.reserved);
    const candidate = { message: "done", summary: "done", warnings: [] };
    await new ReviewCoordinator(reviewer, emit, budgets)
      .maybeReview(target, new AbortController().signal, false, candidate);

    expect(gateway.calls).toBe(1);
    expect(currentFrontierReview(target, completionCandidateDigest(candidate))?.status).toBe("passed");
  });

  it("honors an attested two-token-per-byte bound through the budget-aware reviewer gateway", async () => {
    const target = runtimeSession(limits({
      inputTokens: 100_000, outputTokens: 100_000, costMicroUsd: 100_000, modelTurns: 10
    }));
    const gateway = new CrossTokenizerReviewerGateway();
    const reviewer = new ModelReviewer(gateway);
    const quote = await candidateReviewerBudgetReserve(target, reviewer, 100_000);
    const candidate = {
      message: `Delivered ${"界".repeat(500)}`,
      summary: `Updated ${"界".repeat(500)}`,
      warnings: []
    };
    const { budgets, emit } = harness(target);

    await new ReviewCoordinator(reviewer, emit, budgets)
      .maybeReview(target, new AbortController().signal, false, candidate);

    const actualReviewerInput = await gateway.countTokens(gateway.requests[0]!.messages);
    expect(quote.inputTokens).toBeGreaterThanOrEqual(actualReviewerInput);
    expect(currentFrontierReview(target, completionCandidateDigest(candidate))?.status).toBe("passed");
  });

  it("covers whole-message re-tokenization when inserting a bounded completion candidate", async () => {
    const target = runtimeSession(limits({
      inputTokens: 100_000, outputTokens: 100_000, costMicroUsd: 100_000, modelTurns: 10
    }));
    const gateway = new BoundarySensitiveReviewerGateway();
    const reviewer = new ModelReviewer(gateway);
    const quote = await candidateReviewerBudgetReserve(target, reviewer, 100_000);
    const candidate = { message: "x".repeat(7_000), summary: "done", warnings: [] };
    const { budgets, emit } = harness(target);

    await new ReviewCoordinator(reviewer, emit, budgets)
      .maybeReview(target, new AbortController().signal, false, candidate);

    const actualReviewerInput = await gateway.countTokens(gateway.requests[0]!.messages);
    expect(actualReviewerInput).toBeGreaterThan(COMPLETION_CANDIDATE_MAX_SERIALIZED_UTF8_BYTES + 1);
    expect(quote.inputTokens).toBeGreaterThanOrEqual(actualReviewerInput);
    expect(currentFrontierReview(target, completionCandidateDigest(candidate))?.status).toBe("passed");
  });

  it("fails closed when a model reviewer has no trusted tokenizer expansion bound", async () => {
    const target = runtimeSession();
    const gateway = new ReviewerGateway();
    Object.defineProperty(gateway, "maxTokensPerUtf8Byte", { value: undefined });

    await expect(candidateReviewerBudgetReserve(target, new ModelReviewer(gateway), 100_000))
      .rejects.toMatchObject({ code: "review_budget_quote_unavailable" });
  });

  it("quotes the largest fallback candidate and keeps normal-stage completion review bounded", async () => {
    expect(maximumAttemptOutputTokens({
      estimatedInputTokens: 1,
      reserved: { inputTokens: 3, outputTokens: 350, costMicroUsd: 3, modelTurns: 3 },
      reservedAttempts: 3,
      attemptReservations: [
        { inputTokens: 1, outputTokens: 50, costMicroUsd: 1 },
        { inputTokens: 1, outputTokens: 200, costMicroUsd: 1 },
        { inputTokens: 1, outputTokens: 100, costMicroUsd: 1 }
      ]
    })).toBe(200);

    const target = runtimeSession(limits({
      inputTokens: 100_000,
      outputTokens: 100_000,
      costMicroUsd: 100_000,
      modelTurns: 10
    }));
    target.durable.state.deadlineRemainingMs = 600_000;
    const gateway = new ReviewerGateway();
    gateway.capabilities.maxOutputTokens = 4_096;
    const { budgets, emit } = harness(target);
    await new ReviewCoordinator(new ModelReviewer(gateway), emit, budgets).maybeReview(
      target,
      new AbortController().signal,
      false,
      { message: "done", summary: "done", warnings: [] }
    );

    expect(gateway.requests[0]?.maxOutputTokens).toBe(2_048);
  });

  it("settles provider-reported reviewer usage above its reservation", async () => {
    const target = runtimeSession();
    const gateway = new ReviewerGateway(undefined, undefined, 175);
    const { budgets, emit } = harness(target);

    await new ReviewCoordinator(new ModelReviewer(gateway), emit, budgets)
      .maybeReview(target, new AbortController().signal);

    expect(target.durable.state.budget.consumed.inputTokens).toBe(175);
    expect(target.durable.state.budget.reserved.inputTokens).toBe(0);
  });

  it("settles a failed reviewer attempt conservatively without approving it", async () => {
    const target = runtimeSession();
    const gateway = new ReviewerGateway(new Error("provider unavailable"));
    const { budgets, emit } = harness(target);
    const coordinator = new ReviewCoordinator(new ModelReviewer(gateway), emit, budgets);

    await coordinator.maybeReview(target, new AbortController().signal);

    expect(gateway.calls).toBe(1);
    expect(target.durable.state.budget.reserved.inputTokens).toBe(0);
    expect(target.durable.state.budget.consumed).toMatchObject({ inputTokens: 150, outputTokens: 0, modelTurns: 1 });
    expect(target.durable.state.usage[0]).toMatchObject({ role: "reviewer", providerReported: false });
    expect(target.durable.state.evidence.find((item) => item.kind === "review")).toMatchObject({
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
    expect(target.durable.state.budget.reserved.modelTurns).toBe(0);
    expect(target.durable.state.budget.consumed.modelTurns).toBe(2);
    expect(target.durable.state.usage[0]).toMatchObject({ role: "reviewer", attempt: 2 });
  });

  it("recovers a committed reviewer reservation without replay or double charge", async () => {
    const target = runtimeSession();
    const gateway = new ReviewerGateway();
    const first = harness(target, true);
    const coordinator = new ReviewCoordinator(new ModelReviewer(gateway), first.emit, first.budgets);

    await expect(coordinator.maybeReview(target, new AbortController().signal))
      .rejects.toThrow("injected crash");
    const consumed = structuredClone(target.durable.state.budget.consumed);
    expect(gateway.calls).toBe(1);
    expect(target.durable.state.usage).toHaveLength(0);

    const recovered = harness(target);
    await new ReviewCoordinator(new ModelReviewer(gateway), recovered.emit, recovered.budgets)
      .maybeReview(target, new AbortController().signal);

    expect(gateway.calls).toBe(1);
    expect(target.durable.state.budget.consumed).toEqual(consumed);
    expect(target.durable.state.usage).toHaveLength(1);
    expect(target.durable.state.evidence.find((item) => item.kind === "review")).toMatchObject({ status: "failed" });
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
          frontierRevision: input.frontierRevision,
          stateDigest: input.stateDigest,
          validationEvidenceIds: input.validations.map((item) => item.evidenceId)
        }
      })
    };
    const { budgets, emit } = harness(target);
    await expect(candidateReviewerBudgetReserve(target, fake, 1_000)).resolves.toMatchObject({
      inputTokens: 0, outputTokens: 0, costMicroUsd: 0, modelTurns: 0
    });

    await new ReviewCoordinator(fake, emit, budgets).maybeReview(target, new AbortController().signal);

    expect(target.durable.state.usage).toHaveLength(0);
    expect(target.durable.state.budget.consumed.modelTurns).toBe(0);
    expect(target.durable.state.evidence.find((item) => item.kind === "review")).toMatchObject({ status: "passed" });
  });

  it("keeps legacy accountable reviewers budgeted but fails closed when completion quoting is unavailable", async () => {
    const target = runtimeSession();
    const gateway = new ReviewerGateway();
    const reviewer = new ModelReviewer(gateway);
    Object.defineProperty(reviewer, "prepareCompletionReserve", { value: undefined });
    expect(isAccountableReviewer(reviewer)).toBe(true);
    await expect(candidateReviewerBudgetReserve(target, reviewer, 1_000)).rejects.toMatchObject({
      code: "review_budget_quote_unavailable"
    });

    const { budgets, emit } = harness(target);
    await new ReviewCoordinator(reviewer, emit, budgets).maybeReview(target, new AbortController().signal);
    expect(target.durable.state.usage).toHaveLength(1);
    expect(target.durable.state.budget.consumed.modelTurns).toBe(1);
  });

  it("fails closed when any reviewer port approves while returning findings", async () => {
    const target = runtimeSession();
    const contradictory: ReviewerPort = {
      reviewerId: "contradictory-port",
      review: async (input): Promise<ReviewEvidence> => ({
        evidenceId: "contradictory-review",
        sessionId: input.sessionId,
        runId: input.runId,
        kind: "review",
        status: "passed",
        createdAt: now,
        producer: { authority: "runtime", id: "contradictory-port" },
        summary: "approved with a finding",
        data: {
          reviewerId: "contradictory-port",
          verdict: "approved",
          findings: ["An unresolved correctness issue remains."],
          frontierRevision: input.frontierRevision,
          stateDigest: input.stateDigest,
          validationEvidenceIds: input.validations.map((item) => item.evidenceId)
        }
      })
    };
    const { budgets, emit } = harness(target);

    await new ReviewCoordinator(contradictory, emit, budgets)
      .maybeReview(target, new AbortController().signal);

    expect(target.durable.state.evidence.find((item) => item.kind === "review")).toMatchObject({
      status: "failed",
      data: {
        verdict: "changes_requested",
        findings: ["An unresolved correctness issue remains."]
      }
    });
  });

  it("keeps structured warnings and positive observations advisory", async () => {
    const target = runtimeSession();
    const advisory: ReviewerPort = {
      reviewerId: "structured-reviewer",
      review: async (input): Promise<ReviewEvidence> => ({
        evidenceId: "structured-review",
        sessionId: input.sessionId,
        runId: input.runId,
        kind: "review",
        status: "failed",
        createdAt: now,
        producer: { authority: "runtime", id: "structured-reviewer" },
        summary: "advisory observations",
        data: {
          reviewerId: "structured-reviewer",
          verdict: "changes_requested",
          findings: [
            { actionable: false, severity: "info", summary: "Validation coverage is strong." },
            { actionable: true, severity: "warning", summary: "Consider a follow-up cleanup." }
          ],
          frontierRevision: input.frontierRevision,
          stateDigest: input.stateDigest,
          validationEvidenceIds: input.validations.map((item) => item.evidenceId)
        }
      })
    };
    const { emit } = harness(target);

    await new ReviewCoordinator(advisory, emit).maybeReview(target, new AbortController().signal);

    expect(target.durable.state.evidence.find((item) => item.kind === "review")).toMatchObject({
      status: "passed",
      data: { verdict: "approved" }
    });
  });

  it("caps explicit infrastructure retries at two per review basis", async () => {
    const target = runtimeSession();
    let calls = 0;
    const reviewer: ReviewerPort = {
      reviewerId: "dedupe-reviewer",
      review: async (input): Promise<ReviewEvidence> => {
        calls += 1;
        return {
          evidenceId: `failed-review-${calls}`,
          sessionId: input.sessionId,
          runId: input.runId,
          kind: "review",
          status: "failed",
          createdAt: now,
          producer: { authority: "runtime", id: "dedupe-reviewer" },
          summary: "reviewer unavailable",
          data: {
            reviewerId: "dedupe-reviewer",
            verdict: "changes_requested",
            findings: ["reviewer unavailable"],
            frontierRevision: input.frontierRevision,
            stateDigest: input.stateDigest,
            validationEvidenceIds: input.validations.map((item) => item.evidenceId),
            failureKind: "infrastructure"
          }
        };
      }
    };
    const { emit } = harness(target);
    await new ReviewCoordinator(reviewer, emit).maybeReview(target, new AbortController().signal);
    await new ReviewCoordinator(reviewer, emit).maybeReview(target, new AbortController().signal, true);
    await new ReviewCoordinator(reviewer, emit).maybeReview(target, new AbortController().signal, true);
    await new ReviewCoordinator(reviewer, emit).maybeReview(target, new AbortController().signal, true);

    expect(calls).toBe(3);
  });

  it("caps automatic retries for one completion candidate at the same review limit", async () => {
    const target = runtimeSession();
    const candidate = { message: "done", summary: "done", warnings: [] };
    let calls = 0;
    const reviewer: ReviewerPort = {
      reviewerId: "candidate-retry-reviewer",
      review: async (input): Promise<ReviewEvidence> => {
        calls += 1;
        return {
          evidenceId: `candidate-failure-${calls}`,
          sessionId: input.sessionId,
          runId: input.runId,
          kind: "review",
          status: "failed",
          createdAt: now,
          producer: { authority: "runtime", id: "candidate-retry-reviewer" },
          summary: "reviewer unavailable",
          data: {
            reviewerId: "candidate-retry-reviewer",
            verdict: "changes_requested",
            findings: ["reviewer unavailable"],
            frontierRevision: input.frontierRevision,
            stateDigest: input.stateDigest,
            validationEvidenceIds: input.validations.map((item) => item.evidenceId),
            failureKind: "infrastructure"
          }
        };
      }
    };
    const { emit } = harness(target);
    const coordinator = new ReviewCoordinator(reviewer, emit);

    await coordinator.maybeReview(target, new AbortController().signal, false, candidate);
    await coordinator.maybeReview(target, new AbortController().signal, false, candidate);
    await coordinator.maybeReview(target, new AbortController().signal, false, candidate);
    await coordinator.maybeReview(target, new AbortController().signal, false, candidate);

    expect(calls).toBe(3);
  });

  it("uses the stop-stage reserve only for a candidate-bound review", async () => {
    const target = runtimeSession();
    target.durable.state.deadlineRemainingMs = 1;
    const candidate = { message: "done", summary: "done", warnings: [] };
    let calls = 0;
    const reviewer: ReviewerPort = {
      reviewerId: "finishing-reviewer",
      review: async (input): Promise<ReviewEvidence> => {
        calls += 1;
        return {
          evidenceId: "finishing-review",
          sessionId: input.sessionId,
          runId: input.runId,
          kind: "review",
          status: "passed",
          createdAt: now,
          producer: { authority: "runtime", id: "finishing-reviewer" },
          summary: "approved",
          data: {
            reviewerId: "finishing-reviewer",
            verdict: "approved",
            findings: [],
            frontierRevision: input.frontierRevision,
            stateDigest: input.stateDigest,
            validationEvidenceIds: input.validations.map((item) => item.evidenceId)
          }
        };
      }
    };
    const { emit } = harness(target);
    const coordinator = new ReviewCoordinator(reviewer, emit);

    await coordinator.maybeReview(target, new AbortController().signal, true);
    expect(calls).toBe(0);
    await coordinator.maybeReview(target, new AbortController().signal, false, candidate);

    expect(calls).toBe(1);
    expect(currentFrontierReview(target, completionCandidateDigest(candidate))?.status).toBe("passed");
  });

  it("keeps request_review workspace mode isolated from candidate-bound review", async () => {
    const target = runtimeSession();
    const candidate = { message: "done", summary: "done", warnings: [] };
    const candidateDigest = completionCandidateDigest(candidate);
    const modes: string[] = [];
    const reviewer: ReviewerPort = {
      reviewerId: "mode-isolation-reviewer",
      review: async (input): Promise<ReviewEvidence> => {
        modes.push(input.reviewMode ?? "workspace");
        return {
          evidenceId: `review-${modes.length}`,
          sessionId: input.sessionId,
          runId: input.runId,
          kind: "review",
          status: "passed",
          createdAt: now,
          producer: { authority: "runtime", id: "mode-isolation-reviewer" },
          summary: "approved",
          data: {
            reviewerId: "mode-isolation-reviewer",
            verdict: "approved",
            findings: [],
            frontierRevision: input.frontierRevision,
            stateDigest: input.stateDigest,
            validationEvidenceIds: input.validations.map((item) => item.evidenceId)
          }
        };
      }
    };
    const { emit } = harness(target);
    const coordinator = new ReviewCoordinator(reviewer, emit);

    await coordinator.maybeReview(target, new AbortController().signal, false, candidate);
    expect(currentFrontierReview(target, candidateDigest)?.status).toBe("passed");
    expect(currentWorkspaceReview(target)).toBeUndefined();

    await coordinator.maybeReview(target, new AbortController().signal, true);

    expect(modes).toEqual(["completion", "workspace"]);
    expect(currentWorkspaceReview(target)?.status).toBe("passed");
    expect(currentFrontierReview(target, candidateDigest)?.status).toBe("passed");
  });

  it("ignores duplicate validation records and refreshes when semantic validation changes", async () => {
    const target = runtimeSession();
    let calls = 0;
    const reviewer: ReviewerPort = {
      reviewerId: "freshness-reviewer",
      review: async (input): Promise<ReviewEvidence> => {
        calls += 1;
        return {
          evidenceId: `review-${calls}`,
          sessionId: input.sessionId,
          runId: input.runId,
          kind: "review",
          status: calls === 1 ? "failed" : "passed",
          createdAt: now,
          producer: { authority: "runtime", id: "freshness-reviewer" },
          summary: calls === 1 ? "add stronger validation" : "approved",
          data: {
            reviewerId: "freshness-reviewer",
            verdict: calls === 1 ? "changes_requested" : "approved",
            findings: calls === 1
              ? [{ actionable: true, severity: "error", summary: "Add a runtime check." }]
              : [],
            frontierRevision: input.frontierRevision,
            stateDigest: input.stateDigest,
            validationEvidenceIds: input.validations.map((item) => item.evidenceId)
          }
        };
      }
    };
    const { emit } = harness(target);
    const coordinator = new ReviewCoordinator(reviewer, emit);

    await coordinator.maybeReview(target, new AbortController().signal);
    const duplicate = { ...validation(), evidenceId: "duplicate-validation" };
    target.durable.state.evidence.push(duplicate);
    await coordinator.maybeReview(target, new AbortController().signal);
    expect(calls).toBe(1);

    const stronger = {
      ...validation(),
      evidenceId: "runtime-validation",
      data: { ...validation().data, command: "pnpm test -- --integration" }
    };
    target.durable.state.evidence.push(stronger);
    await coordinator.maybeReview(target, new AbortController().signal);

    expect(calls).toBe(2);
    expect(target.durable.state.evidence.at(-1)).toMatchObject({
      kind: "review",
      status: "passed",
      data: {
        verdict: "approved",
        reviewBasisDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
        validationEvidenceIds: ["validation", "duplicate-validation", "runtime-validation"]
      }
    });
  });

  it("passes a bounded projection of post-validation observations to the reviewer model", async () => {
    const target = runtimeSession();
    target.durable.state.evidence.push(...Array.from({ length: 20 }, (_, index) => ({
      evidenceId: `observation-${index}`,
      sessionId: "session",
      runId: "run",
      kind: "diagnostic" as const,
      status: "informational" as const,
      createdAt: `2026-07-11T00:00:${String(index).padStart(2, "0")}.000Z`,
      producer: { authority: "tool" as const, id: `inspection-${index}` },
      summary: `generic post-validation observation ${index}`,
      data: {
        source: `inspection-${index}`,
        diagnostic: { output: `observation-${index}:${"x".repeat(3_000)}` }
      }
    })));
    const gateway = new ReviewerGateway();
    const { emit } = harness(target);

    await new ReviewCoordinator(new ModelReviewer(gateway), emit)
      .maybeReview(target, new AbortController().signal);

    expect(gateway.calls).toBe(1);
    const reviewerInput = JSON.parse(gateway.requests[0]!.messages[1]!.content) as {
      observations: {
        items: Array<{ evidenceId: string; outputExcerpt?: string }>;
        totalCount: number;
        omittedCount: number;
        contentSha256: string;
      };
    };
    expect(reviewerInput.observations.totalCount).toBe(20);
    expect(reviewerInput.observations.items.length).toBeLessThanOrEqual(8);
    expect(reviewerInput.observations.omittedCount)
      .toBe(20 - reviewerInput.observations.items.length);
    expect(reviewerInput.observations.contentSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(Buffer.byteLength(JSON.stringify(reviewerInput.observations), "utf8"))
      .toBeLessThanOrEqual(4 * 1_024);
  });

  it("fails closed when completion-relevant validation changes while review is in flight", async () => {
    const target = runtimeSession();
    let requestedBasis: string | undefined;
    const reviewer: ReviewerPort = {
      reviewerId: "racing-reviewer",
      review: async (input): Promise<ReviewEvidence> => {
        requestedBasis = input.reviewBasisDigest;
        target.durable.state.evidence.push({
          ...validation(),
          evidenceId: "validation-arriving-during-review",
          data: { ...validation().data, command: "pnpm test -- --integration" }
        });
        return {
          evidenceId: "approval-for-stale-basis",
          sessionId: input.sessionId,
          runId: input.runId,
          kind: "review",
          status: "passed",
          createdAt: now,
          producer: { authority: "runtime", id: "racing-reviewer" },
          summary: "approved",
          data: {
            reviewerId: "racing-reviewer",
            verdict: "approved",
            findings: [],
            frontierRevision: input.frontierRevision,
            stateDigest: input.stateDigest,
            validationEvidenceIds: input.validations.map((item) => item.evidenceId)
          }
        };
      }
    };
    const { emit } = harness(target);

    await new ReviewCoordinator(reviewer, emit).maybeReview(target, new AbortController().signal);

    expect(requestedBasis).toMatch(/^[a-f0-9]{64}$/u);
    expect(target.durable.state.evidence.at(-1)).toMatchObject({
      kind: "review",
      status: "failed",
      data: {
        verdict: "changes_requested",
        failureKind: "interrupted",
        reviewBasisVersion: 3,
        frontierRevision: 1,
        stateDigest: "a".repeat(64),
        reviewBasisDigest: requestedBasis
      }
    });
    expect(currentFrontierReview(target)).toBeUndefined();
  });

  it("fails closed for non-strict JSON and incomplete review material", async () => {
    const input = {
      sessionId: "session", runId: "run", goal: "Review safely",
      frontierRevision: 1, stateDigest: "a".repeat(64),
      workspaceDeltas: [delta()], validations: [validation()]
    };
    const decoratedGateway = new ReviewerGateway(
      undefined,
      'Here is the result: {"verdict":"approved","findings":[]}'
    );
    const decorated = await new ModelReviewer(decoratedGateway).review(input, new AbortController().signal);
    expect(decorated).toMatchObject({ status: "failed", data: { verdict: "changes_requested" } });
    expect(decoratedGateway.calls).toBe(1);

    const contradictoryGateway = new ReviewerGateway(
      undefined,
      '{"verdict":"approved","findings":["Fix the missing authorization check."]}'
    );
    const contradictory = await new ModelReviewer(contradictoryGateway)
      .review(input, new AbortController().signal);
    expect(contradictory).toMatchObject({
      status: "failed",
      data: {
        verdict: "changes_requested",
        findings: ["Fix the missing authorization check."]
      }
    });

    const truncatedDelta = delta();
    truncatedDelta.data.reviewDiff += "\n[review diff truncated]";
    const truncatedGateway = new ReviewerGateway();
    const truncated = await new ModelReviewer(truncatedGateway).review({
      ...input, workspaceDeltas: [truncatedDelta]
    }, new AbortController().signal);
    expect(truncated).toMatchObject({
      status: "failed",
      data: { verdict: "changes_requested", findings: [expect.stringContaining("truncated")] }
    });
    expect(truncatedGateway.calls).toBe(0);

    const binaryDelta = delta();
    binaryDelta.data.delta.modified = ["bin/tool"];
    binaryDelta.data.reviewDiff = [
      "--- a/bin/tool",
      "+++ b/bin/tool",
      "[metadata before=file:33188 after=file:33188]",
      "[before]",
      "[binary sha256=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef size=4]",
      "[after]",
      "[binary sha256=abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789 size=8]"
    ].join("\n");
    const binaryGateway = new ReviewerGateway();
    const binary = await new ModelReviewer(binaryGateway).review({
      ...input, workspaceDeltas: [binaryDelta], validations: [validation(["bin/tool"])]
    }, new AbortController().signal);
    expect(binary).toMatchObject({ status: "passed", data: { verdict: "approved" } });
    expect(binaryGateway.calls).toBe(1);

    const opaqueDelta = delta();
    opaqueDelta.data.delta.modified = ["bin/tool"];
    opaqueDelta.data.reviewDiff = "[review diff truncated]";
    opaqueDelta.data.opaqueArtifacts = [{
      path: "bin/tool",
      before: { digest: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", sizeBytes: 4 },
      after: { digest: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789", sizeBytes: 8 }
    }];
    const opaqueGateway = new ReviewerGateway();
    const opaque = await new ModelReviewer(opaqueGateway).review({
      ...input, workspaceDeltas: [opaqueDelta], validations: [validation(["bin/tool"])]
    }, new AbortController().signal);
    expect(opaque).toMatchObject({ status: "passed", data: { verdict: "approved" } });
    expect(opaqueGateway.calls).toBe(1);

    const unvalidatedGateway = new ReviewerGateway();
    const unvalidated = await new ModelReviewer(unvalidatedGateway).review({
      ...input, workspaceDeltas: [binaryDelta], validations: []
    }, new AbortController().signal);
    expect(unvalidated).toMatchObject({
      status: "failed",
      data: { verdict: "changes_requested", findings: [expect.stringContaining("passed validation")] }
    });
    expect(unvalidatedGateway.calls).toBe(0);
  });

  it("reviews complete mixed evidence and preserves the full semantic goal", async () => {
    const gateway = new ReviewerGateway();
    const goal = `${"Explain the general change clearly. ".repeat(4)}Keep the final compatibility constraint.`;
    const result = await new ModelReviewer(gateway).review({
      sessionId: "session",
      runId: "run",
      goal,
      workspaceDeltas: [completeMixedDelta()],
      validations: [validation()]
    }, new AbortController().signal);

    expect(result).toMatchObject({ status: "passed", data: { verdict: "approved" } });
    expect(gateway.calls).toBe(1);
    const reviewerInput = JSON.parse(gateway.requests[0]!.messages[1]!.content) as { goal: string };
    expect(reviewerInput.goal).toBe(goal);
  });

  it("reviews separately checkpointed source and documentation without demanding validation for ordinary text", async () => {
    const source = {
      ...delta(),
      data: { ...delta().data, reviewDiffPaths: ["src/code.ts"] }
    };
    const documentation: WorkspaceDeltaEvidence = {
      ...delta(),
      evidenceId: "docs-delta",
      producer: { authority: "runtime", id: "docs-checkpoint" },
      data: {
        checkpointId: "docs-checkpoint",
        delta: { added: [], modified: ["README.md"], deleted: [] },
        reviewDiff: "--- a/README.md\n+++ b/README.md\n[metadata before=file:33188 after=file:33188]\n-old\n+new",
        reviewDiffPaths: ["README.md"]
      }
    };
    const candidate = {
      message: "Implemented the requested change and updated README.md.",
      summary: "Implemented the requested change.",
      warnings: []
    };
    const gateway = new ReviewerGateway();
    const result = await new ModelReviewer(gateway).review({
      sessionId: "session",
      runId: "run",
      goal: "Change the implementation and document it.",
      frontierRevision: 1,
      stateDigest: "a".repeat(64),
      reviewBasisDigest: "b".repeat(64),
      workspaceDeltas: [source, documentation],
      validations: [validation(["src/code.ts"])],
      validationRequiredPaths: ["src/code.ts"],
      reviewMode: "completion",
      completionCandidate: candidate,
      completionCandidateDigest: completionCandidateDigest(candidate)
    }, new AbortController().signal);

    expect(result).toMatchObject({
      status: "passed",
      data: {
        verdict: "approved",
        reviewBasisVersion: 3,
        completionCandidateDigest: completionCandidateDigest(candidate)
      }
    });
    const reviewerInput = JSON.parse(gateway.requests[0]!.messages[1]!.content) as {
      reviewMode: string;
      validationRequiredPaths: string[];
      completionCandidate: { message: string };
    };
    expect(reviewerInput).toMatchObject({
      reviewMode: "completion",
      validationRequiredPaths: ["src/code.ts"],
      completionCandidate: { message: candidate.message }
    });
  });

  it("retains passed validation for an opaque artifact with a reviewable-text extension", async () => {
    const target = runtimeSession();
    const readmeDelta: WorkspaceDeltaEvidence = {
      ...delta(),
      data: {
        checkpointId: "checkpoint",
        delta: { added: [], modified: ["README.md"], deleted: [] },
        reviewDiff: "",
        reviewDiffPaths: [],
        opaqueArtifacts: [{
          path: "README.md",
          before: { digest: beforeDigest, sizeBytes: 4 },
          after: { digest: afterDigest, sizeBytes: 8 }
        }]
      }
    };
    const acceptance = validation(["README.md"]);
    acceptance.data.claim = {
      ...acceptance.data.claim!,
      kind: "acceptance",
      strength: "behavioral"
    };
    target.durable.state.evidence = [readmeDelta, acceptance];
    target.durable.state.mutationFrontier = {
      ...target.durable.state.mutationFrontier,
      changedPaths: ["README.md"]
    };
    const gateway = new ReviewerGateway();
    const { emit } = harness(target);

    await new ReviewCoordinator(new ModelReviewer(gateway), emit)
      .maybeReview(target, new AbortController().signal);

    expect(gateway.calls).toBe(1);
    const reviewerInput = JSON.parse(gateway.requests[0]!.messages[1]!.content) as {
      validationRequiredPaths: string[];
      validations: Array<{ data: { coveredPaths: string[] } }>;
    };
    expect(reviewerInput.validationRequiredPaths).toEqual(["README.md"]);
    expect(reviewerInput.validations).toHaveLength(1);
    expect(reviewerInput.validations[0]?.data.coveredPaths).toContain("README.md");
  });

  it.each([
    ["opaque to text", true, false],
    ["text to opaque", false, true]
  ] as const)("uses the latest path representation for %s", async (_label, opaqueFirst, expectedOpaque) => {
    const target = runtimeSession();
    const representation = (evidenceId: string, opaque: boolean): WorkspaceDeltaEvidence => ({
      ...delta(),
      evidenceId,
      data: {
        checkpointId: evidenceId,
        delta: { added: [], modified: ["README.md"], deleted: [] },
        reviewDiff: opaque ? "" : "--- a/README.md\n+++ b/README.md\n-old\n+new",
        reviewDiffPaths: opaque ? [] : ["README.md"],
        ...(opaque ? { opaqueArtifacts: [{
          path: "README.md",
          before: { digest: beforeDigest, sizeBytes: 4 },
          after: { digest: afterDigest, sizeBytes: 8 }
        }] } : {})
      }
    });
    target.durable.state.mutationFrontier = {
      ...target.durable.state.mutationFrontier,
      changedPaths: ["README.md"]
    };
    target.durable.state.mutationEvidence = [];
    const workspaceDeltas = [
      representation("first", opaqueFirst),
      representation("last", !opaqueFirst)
    ];
    target.durable.state.evidence = workspaceDeltas;

    const validationRequiredPaths = reviewValidationRequiredPaths(target);
    expect(validationRequiredPaths.includes("README.md")).toBe(expectedOpaque);
    const gateway = new ReviewerGateway();
    const result = await new ModelReviewer(gateway).review({
      sessionId: "session",
      runId: "run",
      goal: "Update README.md",
      frontierRevision: 1,
      stateDigest: "a".repeat(64),
      reviewBasisDigest: "b".repeat(64),
      workspaceDeltas,
      validations: [],
      validationRequiredPaths
    }, new AbortController().signal);
    expect(result.status).toBe(expectedOpaque ? "failed" : "passed");
    expect(gateway.calls).toBe(expectedOpaque ? 0 : 1);
  });

  it.each([
    ["added", { added: ["assets/blob.bin"], modified: [], deleted: [] }, {
      path: "assets/blob.bin", after: { digest: afterDigest, sizeBytes: 8 }
    }],
    ["deleted", { added: [], modified: [], deleted: ["assets/blob.bin"] }, {
      path: "assets/blob.bin", before: { digest: beforeDigest, sizeBytes: 4 }
    }],
    ["modified", { added: [], modified: ["assets/blob.bin"], deleted: [] }, {
      path: "assets/blob.bin",
      before: { digest: beforeDigest, sizeBytes: 4 },
      after: { digest: afterDigest, sizeBytes: 8 }
    }]
  ])("accepts fully opaque %s evidence with the required directional identity", async (
    _kind,
    changed,
    artifact
  ) => {
    const item = delta();
    item.data.delta = changed;
    item.data.reviewDiff = "";
    item.data.reviewDiffPaths = [];
    item.data.opaqueArtifacts = [artifact];
    const gateway = new ReviewerGateway();

    const result = await new ModelReviewer(gateway).review({
      sessionId: "session", runId: "run", goal: "Review safely",
      frontierRevision: 1, stateDigest: "a".repeat(64),
      workspaceDeltas: [item], validations: [validation(Object.values(changed).flat())]
    }, new AbortController().signal);

    expect(result).toMatchObject({ status: "passed", data: { verdict: "approved" } });
    expect(gateway.calls).toBe(1);
  });

  it("accepts content-omitted identities and returns a typed oversized-scope blocker", async () => {
    const item = delta();
    item.data.reviewDiff = "";
    item.data.reviewDiffPaths = [];
    item.data.opaqueArtifacts = [{
      path: "src/code.ts",
      representation: "content_omitted",
      before: { digest: beforeDigest, sizeBytes: 300_000 },
      after: { digest: afterDigest, sizeBytes: 300_001 }
    }];
    const gateway = new ReviewerGateway();
    const approved = await new ModelReviewer(gateway).review({
      sessionId: "session", runId: "run", goal: "Review safely",
      frontierRevision: 1, stateDigest: "a".repeat(64), reviewBasisDigest: "b".repeat(64),
      workspaceDeltas: [item], validations: [validation()]
    }, new AbortController().signal);
    expect(approved).toMatchObject({ status: "passed", data: { verdict: "approved" } });

    item.data.reviewProblem = {
      code: "review_scope_too_large",
      message: "Changed-path identity metadata exceeds the bounded review scope.",
      action: "Remove temporary artifacts or split the change."
    };
    const blockedGateway = new ReviewerGateway();
    const blocked = await new ModelReviewer(blockedGateway).review({
      sessionId: "session", runId: "run", goal: "Review safely",
      frontierRevision: 1, stateDigest: "a".repeat(64), reviewBasisDigest: "c".repeat(64),
      workspaceDeltas: [item], validations: [validation()]
    }, new AbortController().signal);
    expect(blocked).toMatchObject({
      status: "failed",
      data: { verdict: "changes_requested", failureCode: "review_scope_too_large" }
    });
    expect(blockedGateway.calls).toBe(0);
  });

  it.each([
    ["missing text coverage", (item: WorkspaceDeltaEvidence) => { item.data.reviewDiffPaths = []; }, true],
    ["duplicate text coverage", (item: WorkspaceDeltaEvidence) => {
      item.data.reviewDiffPaths = ["src/code.ts", "src\\code.ts"];
    }, true],
    ["opaque path falsely declared as textual coverage", (item: WorkspaceDeltaEvidence) => {
      item.data.reviewDiffPaths = ["src/code.ts", "assets/blob.bin"];
    }, true],
    ["wrong added direction", (item: WorkspaceDeltaEvidence) => {
      item.data.opaqueArtifacts = [{ path: "assets/blob.bin", before: { digest: beforeDigest, sizeBytes: 1 } }];
    }, true],
    ["duplicate opaque path", (item: WorkspaceDeltaEvidence) => {
      item.data.opaqueArtifacts = [item.data.opaqueArtifacts![0]!, item.data.opaqueArtifacts![0]!];
    }, true],
    ["opaque path outside the delta", (item: WorkspaceDeltaEvidence) => {
      item.data.opaqueArtifacts = [{ path: "assets/other.bin", after: { digest: afterDigest, sizeBytes: 1 } }];
    }, true],
    ["invalid opaque digest", (item: WorkspaceDeltaEvidence) => {
      item.data.opaqueArtifacts = [{ path: "assets/blob.bin", after: { digest: "invalid", sizeBytes: 1 } }];
    }, true],
    ["invalid opaque size", (item: WorkspaceDeltaEvidence) => {
      item.data.opaqueArtifacts = [{ path: "assets/blob.bin", after: { digest: afterDigest, sizeBytes: -1 } }];
    }, true],
    ["missing validation", (_item: WorkspaceDeltaEvidence) => undefined, false]
  ])("fails closed for %s", async (
    _label,
    mutate: (item: WorkspaceDeltaEvidence) => void,
    includeValidation: boolean
  ) => {
    const item = completeMixedDelta();
    mutate(item);
    const gateway = new ReviewerGateway();

    const result = await new ModelReviewer(gateway).review({
      sessionId: "session",
      runId: "run",
      goal: "Review safely",
      frontierRevision: 1,
      stateDigest: "a".repeat(64),
      workspaceDeltas: [item],
      validations: includeValidation ? [validation(["src/code.ts", "assets/blob.bin"])] : []
    }, new AbortController().signal);

    expect(result).toMatchObject({ status: "failed", data: { verdict: "changes_requested" } });
    expect(gateway.calls).toBe(0);
  });

  it("requires both identities before treating a modified opaque path as fully covered", async () => {
    const item = completeMixedDelta();
    item.data.delta = { added: [], modified: ["assets/blob.bin"], deleted: [] };
    item.data.reviewDiff = "";
    item.data.reviewDiffPaths = [];
    item.data.opaqueArtifacts = [{
      path: "assets/blob.bin",
      before: { digest: beforeDigest, sizeBytes: 4 }
    }];
    const gateway = new ReviewerGateway();

    const result = await new ModelReviewer(gateway).review({
      sessionId: "session", runId: "run", goal: "Review safely",
      frontierRevision: 1, stateDigest: "a".repeat(64),
      workspaceDeltas: [item], validations: [validation(["assets/blob.bin"])]
    }, new AbortController().signal);

    expect(result).toMatchObject({ status: "failed", data: { verdict: "changes_requested" } });
    expect(gateway.calls).toBe(0);
  });

  it("does not accept failed validation as the opaque evidence binding", async () => {
    const failedValidation = validation();
    failedValidation.status = "failed";
    const gateway = new ReviewerGateway();

    const result = await new ModelReviewer(gateway).review({
      sessionId: "session", runId: "run", goal: "Review safely",
      frontierRevision: 1, stateDigest: "a".repeat(64),
      workspaceDeltas: [completeMixedDelta()],
      validations: [{ ...failedValidation, data: {
        ...failedValidation.data, coveredPaths: ["src/code.ts", "assets/blob.bin"]
      } }]
    }, new AbortController().signal);

    expect(result).toMatchObject({ status: "failed", data: { verdict: "changes_requested" } });
    expect(gateway.calls).toBe(0);
  });

  it("requires passed validation for complete text-only review material", async () => {
    const item = delta();
    item.data.reviewDiffPaths = ["src/code.ts"];
    const gateway = new ReviewerGateway();

    const result = await new ModelReviewer(gateway).review({
      sessionId: "session", runId: "run", goal: "Review safely",
      frontierRevision: 1, stateDigest: "a".repeat(64),
      workspaceDeltas: [item], validations: []
    }, new AbortController().signal);

    expect(result).toMatchObject({
      status: "failed",
      data: { verdict: "changes_requested", findings: [expect.stringContaining("passed validation")] }
    });
    expect(gateway.calls).toBe(0);
  });
});
