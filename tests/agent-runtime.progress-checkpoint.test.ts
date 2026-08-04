import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROFILE_ASSURANCE,
  DEFAULT_PROFILE_BUDGET,
  freezeAgentProfile
} from "../packages/agent-extensions/src/index.js";
import {
  EVENT_SCHEMA_VERSION,
  isLongHorizonState,
  type AgentEventEnvelope,
  type ContextAuthority,
  type JsonValue,
  type ModelCapabilities,
  type ModelGateway,
  type ModelMessage,
  type ModelRequest,
  type ModelResponse,
  type ModelStreamEvent,
  type ModelToolDefinition,
  type ToolReceipt
} from "../packages/agent-protocol/src/index.js";
import type { ModelRouteConstraints } from "../packages/agent-model/src/index.js";
import { evolve } from "../packages/agent-kernel/src/index.js";
import { BudgetController } from "../packages/agent-runtime/src/budget-controller.js";
import {
  evidenceAttentionWindow,
  LongHorizonCoordinator,
  nextLongHorizonState,
  strategyRebasedHistory
} from "../packages/agent-runtime/src/long-horizon-coordinator.js";
import {
  strategistTrigger
} from "../packages/agent-runtime/src/long-horizon-strategy.js";
import { longHorizonLedger } from "../packages/agent-runtime/src/long-horizon-ledger.js";
import { progressCheckpoints } from "../packages/agent-runtime/src/progress-checkpoint.js";
import {
  emptyMarginalProgressHistory,
  marginalProgressSignals
} from "../packages/agent-runtime/src/long-horizon-progress.js";
import type { RuntimeSession } from "../packages/agent-runtime/src/types.js";
import { runtimeSessionFixture } from "./testkit/runtime-session-fixture.js";

function addBatch(
  session: ReturnType<typeof runtimeSessionFixture>,
  index: number,
  options: {
    name?: string;
    arguments?: JsonValue;
    output?: string;
    ok?: boolean;
    reasoningContent?: string;
    actualEffects?: ToolReceipt["actualEffects"];
    workspaceDelta?: ToolReceipt["workspaceDelta"];
    artifacts?: string[];
    evidence?: ToolReceipt["evidence"];
  } = {}
): void {
  const callId = `call-${index}`;
  const name = options.name ?? "read";
  const argumentsValue = options.arguments ?? { path: `file-${index}.ts` };
  const output = options.output ?? `observed-${index}`;
  const ok = options.ok ?? true;
  session.durable.state.messages.push({
    role: "assistant",
    content: "",
    ...(options.reasoningContent
      ? { reasoningContent: options.reasoningContent }
      : {}),
    toolCalls: [{ id: callId, name, arguments: argumentsValue }]
  }, {
    role: "tool",
    toolCallId: callId,
    content: `Successful tool receipt ID: ${callId}`
  });
  const receipt: ToolReceipt = {
    callId,
    ok,
    output,
    outcome: {
      status: ok ? "succeeded" : "failed",
      output,
      diagnosticCodes: []
    },
    observedEffects: ["filesystem.read"],
    actualEffects: options.actualEffects ?? ["filesystem.read"],
    artifacts: options.artifacts ?? [],
    diagnostics: [],
    evidence: options.evidence ?? [],
    ...(options.workspaceDelta ? { workspaceDelta: options.workspaceDelta } : {}),
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:01.000Z"
  };
  session.durable.state.receipts.push(receipt);
}

function refresh(session: ReturnType<typeof runtimeSessionFixture>): void {
  session.durable.state.longHorizon = nextLongHorizonState(session);
}

function requiredReviewSession() {
  return runtimeSessionFixture({
    services: {
      profile: freezeAgentProfile({
        id: "fixture-required",
        roleRoutes: {},
        toolAllow: null,
        toolDeny: [],
        skills: [],
        hooks: [],
        permissionMode: "auto",
        budget: { ...DEFAULT_PROFILE_BUDGET },
        mutationPolicy: {
          requirePlanBeforeMutation: false,
          checkpointBeforeMutation: true,
          reviewMode: "required"
        },
        assurancePolicy: { ...DEFAULT_PROFILE_ASSURANCE },
        allowedChildProfiles: []
      })
    }
  });
}

function consumeModelTurns(
  session: ReturnType<typeof runtimeSessionFixture>,
  count: number
): void {
  const zero = {
    inputTokens: 0,
    outputTokens: 0,
    costMicroUsd: 0,
    modelTurns: 0,
    toolCalls: 0,
    children: 0
  };
  const consumed = { ...zero, modelTurns: count };
  session.durable.state.budget = {
    ...session.durable.state.budget,
    consumed,
    reservations: [{
      reservationId: "prior-model-work",
      ownerId: "model:prior",
      status: "committed",
      requested: consumed,
      consumed,
      createdAt: "2026-01-01T00:00:00.000Z",
      settledAt: "2026-01-01T00:00:01.000Z"
    }]
  };
}

function consumeInputTokens(
  session: ReturnType<typeof runtimeSessionFixture>,
  count: number
): void {
  const zero = {
    inputTokens: 0,
    outputTokens: 0,
    costMicroUsd: 0,
    modelTurns: 0,
    toolCalls: 0,
    children: 0
  };
  const consumed = { ...zero, inputTokens: count };
  session.durable.state.budget = {
    ...session.durable.state.budget,
    consumed,
    reservations: [{
      reservationId: "prior-token-work",
      ownerId: "model:prior",
      status: "committed",
      requested: consumed,
      consumed,
      createdAt: "2026-01-01T00:00:00.000Z",
      settledAt: "2026-01-01T00:00:01.000Z"
    }]
  };
}

class StrategistGateway implements ModelGateway {
  readonly provider = "fake";
  readonly model = "strategist";
  readonly capabilities: ModelCapabilities = {
    contextWindowTokens: 32_000,
    maxOutputTokens: 4_096,
    tools: false,
    parallelTools: false,
    reasoning: false,
    structuredOutput: false,
    promptCache: true,
    tokenizer: "approximate"
  };
  calls = 0;
  requests: ModelRequest[] = [];

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.calls += 1;
    this.requests.push(request);
    return {
      message: {
        role: "assistant",
        content: JSON.stringify({
          establishedFacts: ["The exact action and result repeated three times."],
          falsifiedApproaches: ["Repeating that exact action."],
          hypothesis: "A different observation can distinguish the remaining cases.",
          decision: "revise_plan",
          decisionRationale: "The repeated route has stopped adding evidence.",
          nextDiscriminatingAction: "Inspect the nearest independent boundary.",
          expectedSignal: "The result rules the hypothesis in or out.",
          validationTarget: "Run the strongest practical check after mutation."
        })
      },
      finishReason: "stop",
      inputTokens: 100,
      outputTokens: 50
    };
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    yield { type: "done", response: await this.complete(request) };
  }

  async countTokens(): Promise<number> { return 100; }
}

class RetryChainStrategistGateway extends StrategistGateway {
  async budgetPlan(
    _messages: ModelMessage[],
    _tools: ModelToolDefinition[],
    _maxOutputTokens: number,
    remainingBudgetMicroUsd: number
  ) {
    const attemptReservations = Array.from({ length: 11 }, () => ({
      inputTokens: 100,
      outputTokens: 4_096,
      costMicroUsd: 0
    }));
    return {
      estimatedInputTokens: 100,
      reservedInputTokens: 1_100,
      reservedOutputTokens: 45_056,
      reservedCostMicroUsd: 0,
      reservedModelTurns: 11,
      attemptReservations,
      constraints: {
        estimatedInputTokens: 100,
        maxOutputTokens: 4_096,
        remainingBudgetMicroUsd
      } satisfies ModelRouteConstraints
    };
  }

  routingIdentity(): { role: "planner"; routeId: string } {
    return { role: "planner", routeId: "retry-chain" };
  }
}

function coordinatorHarness(
  session: RuntimeSession,
  gateway: StrategistGateway,
  events: AgentEventEnvelope[] = []
) {
  const emit = async (
    target: RuntimeSession,
    type: AgentEventEnvelope["type"],
    authority: Exclude<ContextAuthority, "external_verifier">,
    payload: unknown
  ): Promise<AgentEventEnvelope> => {
    const event: AgentEventEnvelope = {
      schemaVersion: EVENT_SCHEMA_VERSION,
      seq: ++target.durable.seq,
      eventId: `event-${target.durable.seq}`,
      sessionId: target.identity.sessionId,
      runId: target.durable.runId,
      occurredAt: "2026-01-01T00:00:00.000Z",
      type,
      authority,
      payload: payload as JsonValue
    };
    events.push(event);
    target.durable.state = evolve(target.durable.state, event);
    return event;
  };
  return new LongHorizonCoordinator({
    runtime: { gatewayForRole: () => gateway } as never,
    emit,
    budgets: new BudgetController(emit)
  });
}

describe("objective long-horizon triggers", () => {
  it("forms marginal progress only from durable vector components", () => {
    const calls = [{ id: "progress-call", name: "update_plan", arguments: {} }];
    const assistant: ModelMessage = { role: "assistant", content: "", toolCalls: calls };
    const receipt: ToolReceipt = {
      callId: "progress-call",
      ok: true,
      output: "same result",
      outcome: { status: "succeeded", output: "same result", diagnosticCodes: [] },
      observedEffects: ["filesystem.read"],
      actualEffects: ["filesystem.read"],
      workspaceDelta: { added: [], modified: ["src/current.ts"], deleted: [] },
      artifacts: ["artifact-1"],
      diagnostics: [],
      evidence: [{
        evidenceId: "validation-1",
        sessionId: "session",
        runId: "run",
        kind: "validation",
        status: "failed",
        createdAt: "2026-01-01T00:00:01.000Z",
        producer: { authority: "runtime" },
        summary: "Validation failed.",
        data: {
          schemaVersion: 1,
          validator: "test",
          exitCode: 1,
          frontierRevision: 1,
          stateDigest: "a".repeat(64),
          coveredPaths: ["src/current.ts"]
        }
      }],
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:00:01.000Z"
    };
    const seen = emptyMarginalProgressHistory();
    seen.resultDigests.add("seen");
    expect(marginalProgressSignals(
      { assistant, calls, receipts: [receipt] },
      { batch: 1, toolNames: ["update_plan"], callDigest: "call", resultDigest: "seen", summary: "" },
      seen
    )).toEqual([
      "workspace_revision", "plan_revision", "validation_evidence", "artifact"
    ]);
    seen.validationEvidenceIds.add("validation-1");
    seen.artifactIds.add("artifact-1");
    expect(marginalProgressSignals(
      { assistant, calls, receipts: [receipt] },
      { batch: 2, toolNames: ["update_plan"], callDigest: "call", resultDigest: "seen", summary: "" },
      seen
    )).toEqual(["workspace_revision", "plan_revision"]);
    expect(marginalProgressSignals(
      {
        assistant,
        calls: [{ id: "progress-call", name: "read", arguments: {} }],
        receipts: [{
          ...receipt,
          workspaceDelta: { added: [], modified: [], deleted: [] },
          artifacts: [],
          evidence: []
        }]
      },
      { batch: 3, toolNames: ["read"], callDigest: "next", resultDigest: "new", summary: "" },
      seen
    )).toEqual(["discriminating_result"]);
  });

  it("keeps pure settled-batch telemetry out of the model-visible prompt identity", () => {
    const session = runtimeSessionFixture();
    const before = longHorizonLedger(session);
    session.durable.state.longHorizon = {
      ...session.durable.state.longHorizon,
      settledBatchCount: session.durable.state.longHorizon.settledBatchCount + 1
    };
    const after = longHorizonLedger(session);

    expect(after.cacheKey).toBe(before.cacheKey);
    expect(after.content).toBe(before.content);
    expect(after.content).not.toContain("settled tool batches");
  });

  it("allows a bounded pair of diverse diagnostic results before requesting a pivot", () => {
    const session = runtimeSessionFixture();
    session.durable.state.messages.push({ role: "user", content: "Investigate." });
    refresh(session);
    for (let index = 0; index < 2; index += 1) {
      addBatch(session, index);
      refresh(session);
    }
    expect(session.durable.state.longHorizon).toMatchObject({
      schemaVersion: 1,
      settledBatchCount: 2,
      duplicateStreak: 0,
      strategyRequested: false
    });
    expect(strategistTrigger(session)).toBeUndefined();
    expect(progressCheckpoints(session)).toEqual([]);
    expect(session.durable.state.outcome).toBeUndefined();
  });

  it("does not let an unbounded stream of distinct diagnostics manufacture progress", () => {
    const session = runtimeSessionFixture();
    session.durable.state.messages.push({ role: "user", content: "Investigate." });
    refresh(session);
    for (let index = 0; index < 4; index += 1) {
      addBatch(session, index, {
        arguments: { command: `inspect --candidate ${index}` },
        output: `distinct-result-${index}`
      });
      refresh(session);
    }

    const attention = evidenceAttentionWindow(session);
    expect(attention).toMatchObject({
      saturated: false,
      batchCount: 2
    });
    expect(attention.tokenCount).toBeGreaterThan(0);
    expect(session.durable.state.longHorizon.duplicateStreak).toBe(2);
    expect(strategistTrigger(session)).toBe("duplicate_result");
    expect(progressCheckpoints(session)).toEqual([]);
    expect(session.durable.state.outcome).toBeUndefined();
  });

  it("resets evidence attention after an objective plan, mutation, or validation commitment", () => {
    const plan = runtimeSessionFixture();
    plan.durable.state.messages.push({ role: "user", content: "Investigate." });
    refresh(plan);
    addBatch(plan, 0, {
      reasoningContent: "reason about evidence ".repeat(600)
    });
    addBatch(plan, 1, {
      name: "update_plan",
      output: "{\"status\":\"accepted\"}"
    });
    addBatch(plan, 2, {
      output: "observed-0",
      reasoningContent: "reason about different evidence ".repeat(600)
    });
    refresh(plan);
    expect(evidenceAttentionWindow(plan)).toMatchObject({
      saturated: false,
      batchCount: 1
    });

    const mutation = runtimeSessionFixture();
    mutation.durable.state.messages.push({ role: "user", content: "Investigate." });
    refresh(mutation);
    addBatch(mutation, 0, {
      name: "shell",
      actualEffects: ["filesystem.write"],
      output: "same mutation result",
      reasoningContent: "reason about evidence ".repeat(600)
    });
    addBatch(mutation, 1, {
      name: "shell",
      actualEffects: ["filesystem.write"],
      output: "same mutation result",
      workspaceDelta: { added: [], modified: ["src/current.ts"], deleted: [] }
    });
    addBatch(mutation, 2, {
      name: "shell",
      actualEffects: ["filesystem.write"],
      output: "same mutation result",
      reasoningContent: "reason about different evidence ".repeat(600)
    });
    refresh(mutation);
    expect(evidenceAttentionWindow(mutation)).toMatchObject({
      saturated: false,
      batchCount: 1
    });

    const validation = runtimeSessionFixture();
    validation.durable.state.messages.push({ role: "user", content: "Investigate." });
    refresh(validation);
    addBatch(validation, 0, {
      reasoningContent: "reason about evidence ".repeat(600)
    });
    addBatch(validation, 1, {
      name: "validate",
      output: "failed validation",
      ok: false,
      evidence: [{
        evidenceId: "validation-commitment",
        sessionId: "session",
        runId: "run",
        kind: "validation",
        status: "failed",
        createdAt: "2026-01-01T00:00:01.000Z",
        producer: { authority: "runtime" },
        summary: "Validation failed.",
        data: {
          schemaVersion: 1,
          validator: "test",
          exitCode: 1,
          frontierRevision: 1,
          stateDigest: "a".repeat(64),
          coveredPaths: ["src/current.ts"]
        }
      }]
    });
    addBatch(validation, 2, {
      output: "observed-0",
      reasoningContent: "reason about different evidence ".repeat(600)
    });
    refresh(validation);
    expect(evidenceAttentionWindow(validation)).toMatchObject({
      saturated: false,
      batchCount: 1
    });
  });

  it("does not let a declared write effect without a workspace revision manufacture progress", () => {
    const session = runtimeSessionFixture();
    session.durable.state.messages.push({ role: "user", content: "Implement the plan." });
    session.durable.state.plan = {
      revision: 1,
      goal: "Produce and verify the requested result.",
      activeNodeId: "investigate",
      nodes: [{
        id: "investigate",
        title: "Resolve the first uncertainty.",
        dependencies: [],
        status: "in_progress",
        owner: { kind: "root" },
        acceptanceCriteria: [],
        evidence: []
      }, {
        id: "deliver",
        title: "Produce the result.",
        dependencies: [],
        status: "pending",
        owner: { kind: "root" },
        acceptanceCriteria: [],
        evidence: []
      }]
    };
    refresh(session);
    for (let index = 0; index < 3; index += 1) {
      addBatch(session, index, {
        name: "shell",
        arguments: { command: `generate-probe ${index}` },
        actualEffects: ["process.spawn", "filesystem.write"],
        output: "no observable workspace revision",
        reasoningContent: `${String(index)}:${"reason about evidence ".repeat(700)}`
      });
      refresh(session);
    }

    expect(evidenceAttentionWindow(session)).toMatchObject({
      saturated: false,
      batchCount: 2
    });
    expect(session.durable.state.longHorizon.duplicateStreak).toBe(2);
    expect(strategistTrigger(session)).toBe("duplicate_result");
  });

  it("triggers after two post-baseline batches make no marginal progress", () => {
    const repeated = runtimeSessionFixture();
    repeated.durable.state.messages.push({ role: "user", content: "Investigate." });
    refresh(repeated);
    for (let index = 0; index < 3; index += 1) {
      addBatch(repeated, index, {
        arguments: { path: "same.ts", offset: 0 },
        output: "byte-identical result"
      });
      refresh(repeated);
    }
    expect(repeated.durable.state.longHorizon.duplicateStreak).toBe(2);
    expect(strategistTrigger(repeated)).toBe("duplicate_result");

    const merelySimilar = runtimeSessionFixture();
    merelySimilar.durable.state.messages.push({ role: "user", content: "Investigate." });
    refresh(merelySimilar);
    for (let index = 0; index < 2; index += 1) {
      addBatch(merelySimilar, index, {
        arguments: { path: "same.ts", offset: 0 },
        output: `same-looking result with objective revision ${index}`
      });
      refresh(merelySimilar);
    }
    expect(merelySimilar.durable.state.longHorizon.duplicateStreak).toBe(0);
    expect(strategistTrigger(merelySimilar)).toBeUndefined();
  });

  it("accepts an explicit low-friction strategy request without forcing an action", () => {
    const session = runtimeSessionFixture();
    session.durable.state.messages.push({ role: "user", content: "Solve this." });
    refresh(session);
    addBatch(session, 0, {
      name: "request_strategy",
      arguments: { reason: "Two plausible approaches remain." },
      output: "strategy requested"
    });
    refresh(session);
    expect(session.durable.state.longHorizon.strategyRequested).toBe(true);
    expect(strategistTrigger(session)).toBe("model_request");
    expect(progressCheckpoints(session)).toEqual([]);
  });

  it("audits one proposed input suspension with a fresh strategist while work remains open", async () => {
    const session = runtimeSessionFixture();
    session.durable.state.messages.push({ role: "user", content: "Complete the active work." });
    session.durable.state.plan = {
      revision: 1,
      goal: "Complete the active work.",
      activeNodeId: "active",
      nodes: [{
        id: "active",
        title: "Resolve the remaining fact.",
        dependencies: [],
        status: "in_progress",
        owner: { kind: "root" },
        acceptanceCriteria: [],
        evidence: []
      }]
    };
    refresh(session);
    addBatch(session, 0, {
      name: "request_user_input",
      arguments: { message: "Please provide the missing fact." },
      output: "{\"message\":\"Please provide the missing fact.\"}"
    });
    const gateway = new StrategistGateway();
    const events: AgentEventEnvelope[] = [];
    const coordinator = coordinatorHarness(session, gateway, events);

    await expect(coordinator.deferInputRequestForStrategy(
      session,
      "Please provide the missing fact."
    )).resolves.toBe(true);
    expect(session.durable.state.longHorizon.strategyRequested).toBe(true);
    expect(events).toContainEqual(expect.objectContaining({
      type: "diagnostic",
      payload: expect.objectContaining({ kind: "completion.advisory" })
    }));
    await expect(coordinator.deferInputRequestForStrategy(
      session,
      "Please provide the missing fact."
    )).resolves.toBe(false);

    await coordinator.prepareForMainModel(session, new AbortController().signal);

    expect(gateway.calls).toBe(1);
    expect(session.durable.state.longHorizon.strategy).toMatchObject({
      trigger: "input_request",
      decision: "revise_plan"
    });
    const strategistInput = gateway.requests[0]!.messages.at(-1)?.content ?? "";
    expect(strategistInput).toContain("Please provide the missing fact.");
    await expect(coordinator.deferInputRequestForStrategy(
      session,
      "Please provide the missing fact."
    )).resolves.toBe(false);
  });

  it("invokes one fresh strategist, appends durable strategy state, and leaves history intact", async () => {
    const session = runtimeSessionFixture();
    session.durable.state.messages.push({ role: "user", content: "Primary constraint." });
    refresh(session);
    for (let index = 0; index < 3; index += 1) {
      addBatch(session, index, {
        arguments: { path: "same.ts" },
        output: "same result"
      });
      refresh(session);
    }
    const durableBefore = structuredClone(session.durable.state.messages);
    const gateway = new StrategistGateway();
    const coordinator = coordinatorHarness(session, gateway);

    await coordinator.prepareForMainModel(session, new AbortController().signal);
    await coordinator.prepareForMainModel(session, new AbortController().signal);

    expect(gateway.calls).toBe(1);
    expect(gateway.requests[0]).toMatchObject({ tools: [], toolChoice: "none" });
    expect(JSON.stringify(gateway.requests[0]!.messages)).not.toMatch(
      /deadline|remainingMs|verifier|benchmark/iu
    );
    expect(session.durable.state.longHorizon).toMatchObject({
      schemaVersion: 1,
      strategyRequested: false,
      assurance: { strategistCalls: 1 },
      strategy: {
        schemaVersion: 1,
        trigger: "duplicate_result",
        decision: "revise_plan",
        nextDiscriminatingAction: "Inspect the nearest independent boundary."
      }
    });
    expect(session.durable.state.messages).toEqual(durableBefore);
    expect(strategyRebasedHistory(
      session.durable.state.messages,
      session.durable.state.longHorizon
    )).toEqual(durableBefore);
    expect(progressCheckpoints(session)).toEqual([]);
  });

  it("stops projecting strategy facts after newer objective receipts change their basis", async () => {
    const session = runtimeSessionFixture();
    session.durable.state.messages.push({ role: "user", content: "Investigate." });
    refresh(session);
    for (let index = 0; index < 3; index += 1) {
      addBatch(session, index, {
        arguments: { path: "same.ts" },
        output: "same result"
      });
      refresh(session);
    }
    const coordinator = coordinatorHarness(session, new StrategistGateway());
    await coordinator.prepareForMainModel(session, new AbortController().signal);
    expect(longHorizonLedger(session).content).toContain("Fresh-context strategy reset:");

    addBatch(session, 4, {
      arguments: { path: "new.ts" },
      output: "newer result"
    });
    refresh(session);

    const projected = longHorizonLedger(session).content;
    expect(projected).toContain("prior fresh-context strategy reset is historical");
    expect(projected).not.toContain("Inspect the nearest independent boundary.");
    expect(session.durable.state.longHorizon.strategy).toBeDefined();
  });

  it("runs the attention-triggered strategist once and exposes bounded action context", async () => {
    const session = runtimeSessionFixture();
    session.durable.state.messages.push({ role: "user", content: "Investigate." });
    refresh(session);
    for (let index = 0; index < 2; index += 1) {
      addBatch(session, index, {
        name: "shell",
        arguments: {
          command: `inspect --candidate ${index}`,
          env: { API_TOKEN: "do-not-project-secret-values" }
        },
        output: "same signal",
        reasoningContent: `${String(index)}:${"reason about evidence ".repeat(index === 0 ? 10 : 3_000)}`
      });
      refresh(session);
    }
    const gateway = new StrategistGateway();
    const events: AgentEventEnvelope[] = [];
    const coordinator = coordinatorHarness(session, gateway, events);

    await coordinator.prepareForMainModel(session, new AbortController().signal);

    expect(gateway.calls).toBe(1);
    const reset = events.filter((event) =>
      event.type === "long_horizon.updated"
      && (event.payload as { reason?: unknown }).reason === "strategy_reset").at(-1);
    expect(reset?.payload).toMatchObject({
      state: {
        strategy: {
          trigger: "evidence_window",
          decision: "revise_plan"
        }
      }
    });
    expect(isLongHorizonState(
      (reset?.payload as { state?: unknown } | undefined)?.state
    )).toBe(true);
    expect(session.durable.state.longHorizon).toMatchObject({
      strategy: {
        trigger: "evidence_window",
        decision: "revise_plan"
      }
    });
    await coordinator.prepareForMainModel(session, new AbortController().signal);
    expect(gateway.calls).toBe(1);
    expect(session.durable.state.longHorizon.strategy).toMatchObject({
      trigger: "evidence_window",
      decision: "revise_plan"
    });
    const strategistInput = gateway.requests[0]!.messages.at(-1)?.content ?? "";
    expect(strategistInput).toContain("inspect --candidate");
    expect(strategistInput).toContain("\"evidenceAttention\"");
    expect(strategistInput).not.toContain("do-not-project-secret-values");
    expect(strategistInput).not.toMatch(/deadline|remainingMs|verifier|benchmark/iu);
  });

  it("derives the same attention boundary after snapshot-style recovery and ignores deadline changes", () => {
    const session = runtimeSessionFixture();
    session.durable.state.messages.push({ role: "user", content: "Investigate." });
    refresh(session);
    for (let index = 0; index < 2; index += 1) {
      addBatch(session, index, {
        arguments: { query: `independent-${index}` },
        output: `result-${index}`,
        reasoningContent: "bounded deliberation ".repeat(900)
      });
      refresh(session);
    }
    const before = evidenceAttentionWindow(session);
    const recovered = runtimeSessionFixture({
      state: structuredClone(session.durable.state)
    });
    recovered.durable.state.deadlineAt = "2099-12-31T23:59:59.000Z";

    expect(evidenceAttentionWindow(recovered)).toEqual(before);
    expect(strategistTrigger(recovered)).toBe(strategistTrigger(session));
  });

  it("uses the 25% resource band only when work remains active", async () => {
    const inactive = runtimeSessionFixture();
    consumeModelTurns(
      inactive,
      Math.floor(inactive.durable.state.budget.limits.modelTurns * 0.8)
    );
    const inactiveGateway = new StrategistGateway();
    await coordinatorHarness(inactive, inactiveGateway)
      .prepareForMainModel(inactive, new AbortController().signal);
    expect(inactiveGateway.calls).toBe(0);

    const active = runtimeSessionFixture();
    active.durable.state.plan = {
      revision: 1,
      goal: "Finish the active work.",
      activeNodeId: "active",
      nodes: [{
        id: "active",
        title: "Finish",
        dependencies: [],
        status: "in_progress",
        owner: { kind: "root" },
        acceptanceCriteria: [],
        evidence: []
      }]
    };
    consumeModelTurns(
      active,
      Math.floor(active.durable.state.budget.limits.modelTurns * 0.8)
    );
    const activeGateway = new StrategistGateway();
    await coordinatorHarness(active, activeGateway)
      .prepareForMainModel(active, new AbortController().signal);
    expect(activeGateway.calls).toBe(1);
    expect(active.durable.state.longHorizon.strategy?.trigger).toBe("resource_band");
  });

  it("measures the required-review resource band against main capacity after assurance reserve", async () => {
    const session = requiredReviewSession();
    session.durable.state.plan = {
      revision: 1,
      goal: "Finish the active work.",
      activeNodeId: "active",
      nodes: [{
        id: "active",
        title: "Finish",
        dependencies: [],
        status: "in_progress",
        owner: { kind: "root" },
        acceptanceCriteria: [],
        evidence: []
      }]
    };
    const limit = session.durable.state.budget.limits.inputTokens;
    // With a 20% assurance pool, consuming 60% of the raw input budget leaves
    // 25% of the main loop's 80% allocation. The old raw-ledger calculation
    // incorrectly saw 40% remaining and delayed strategy until repair time.
    consumeInputTokens(session, Math.floor(limit * 0.6));
    const gateway = new StrategistGateway();

    await coordinatorHarness(session, gateway)
      .prepareForMainModel(session, new AbortController().signal);

    expect(gateway.calls).toBe(1);
    expect(session.durable.state.longHorizon.strategy?.trigger).toBe("resource_band");
  });

  it("does not advance the Standard resource band for an optional assurance pool", async () => {
    const session = runtimeSessionFixture();
    session.durable.state.plan = {
      revision: 1,
      goal: "Finish the active work.",
      activeNodeId: "active",
      nodes: [{
        id: "active",
        title: "Finish",
        dependencies: [],
        status: "in_progress",
        owner: { kind: "root" },
        acceptanceCriteria: [],
        evidence: []
      }]
    };
    const limit = session.durable.state.budget.limits.inputTokens;
    consumeInputTokens(session, Math.floor(limit * 0.6));
    const gateway = new StrategistGateway();

    await coordinatorHarness(session, gateway)
      .prepareForMainModel(session, new AbortController().signal);

    expect(gateway.calls).toBe(0);
    expect(session.durable.state.longHorizon.strategy).toBeUndefined();
  });

  it("honors strategist_mode=off for every objective trigger", async () => {
    const session = runtimeSessionFixture();
    session.durable.state.longHorizon = {
      ...session.durable.state.longHorizon,
      duplicateStreak: 3,
      strategyRequested: true,
      assurance: {
        ...session.durable.state.longHorizon.assurance,
        strategistMode: "off",
        maxAuxiliaryCalls:
          session.durable.state.longHorizon.assurance.reviewRounds
          * session.durable.state.longHorizon.assurance.reviewerMaxTurns
      }
    };
    const gateway = new StrategistGateway();
    await coordinatorHarness(session, gateway)
      .prepareForMainModel(session, new AbortController().signal);
    expect(gateway.calls).toBe(0);
    expect(session.durable.state.longHorizon.strategy).toBeUndefined();
  });

  it("skips the lower-priority strategist when protected review capacity cannot fit", async () => {
    const session = runtimeSessionFixture();
    session.durable.state.budget.limits = {
      ...session.durable.state.budget.limits,
      inputTokens: 1_000,
      outputTokens: 1_000,
      costMicroUsd: 1_000,
      modelTurns: 4
    };
    session.durable.state.messages.push({ role: "user", content: "Investigate." });
    refresh(session);
    for (let index = 0; index < 3; index += 1) {
      addBatch(session, index, {
        arguments: { path: "same.ts" },
        output: "same result"
      });
      refresh(session);
    }
    const gateway = new StrategistGateway();
    await coordinatorHarness(session, gateway)
      .prepareForMainModel(session, new AbortController().signal);
    expect(gateway.calls).toBe(0);
    expect(session.durable.state.longHorizon.strategy).toBeUndefined();
    expect(session.durable.state.longHorizon.assurance.strategistCalls).toBe(0);
  });

  it("fits one strategist attempt instead of charging the full route retry chain", async () => {
    const session = runtimeSessionFixture();
    session.durable.state.messages.push({ role: "user", content: "Investigate." });
    refresh(session);
    for (let index = 0; index < 3; index += 1) {
      addBatch(session, index, {
        arguments: { path: "same.ts" },
        output: "same result"
      });
      refresh(session);
    }
    const gateway = new RetryChainStrategistGateway();

    await coordinatorHarness(session, gateway)
      .prepareForMainModel(session, new AbortController().signal);

    expect(gateway.calls).toBe(1);
    expect(session.durable.state.longHorizon.assurance.strategistCalls).toBe(1);
    expect(session.durable.state.longHorizon.strategy).toMatchObject({
      trigger: "duplicate_result",
      decision: "revise_plan"
    });
  });
});
