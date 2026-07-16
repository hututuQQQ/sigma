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
import { runtimeSessionFixture } from "./testkit/runtime-session-fixture.js";

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
      coveredPaths
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

    await new ReviewCoordinator(fake, emit, budgets).maybeReview(target, new AbortController().signal);

    expect(target.durable.state.usage).toHaveLength(0);
    expect(target.durable.state.budget.consumed.modelTurns).toBe(0);
    expect(target.durable.state.evidence.find((item) => item.kind === "review")).toMatchObject({ status: "passed" });
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

  it("deduplicates repeated review requests when no new evidence exists", async () => {
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
    const coordinator = new ReviewCoordinator(reviewer, emit);

    await coordinator.maybeReview(target, new AbortController().signal);
    await coordinator.maybeReview(target, new AbortController().signal, true);
    await coordinator.maybeReview(target, new AbortController().signal, true);

    expect(calls).toBe(2);
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
