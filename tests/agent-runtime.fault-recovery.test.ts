import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CheckpointManager, type CheckpointRecord } from "../packages/agent-checkpoint/src/index.js";
import {
  EVENT_SCHEMA_VERSION,
  createBudgetLedger,
  type BudgetAmounts,
  type AgentEventEnvelope,
  type AgentEventType,
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
  type UsageRecord
} from "../packages/agent-protocol/src/index.js";
import { createRuntime } from "../packages/agent-runtime/src/testing.js";
import type {
  AccountableReviewerPort,
  PreparedReviewerCall,
  ReviewerInput
} from "../packages/agent-runtime/src/reviewer.js";
import { SegmentedJsonlStore } from "../packages/agent-store/src/index.js";
import { EffectToolRegistry, registerBuiltinTools } from "../packages/agent-tools/src/index.js";
import { completeAgentEventPayload } from "./testkit/agent-event-fixtures.js";

type Boundary =
  | "plan"
  | "budget"
  | "checkpoint"
  | "mutation"
  | "seal_record"
  | "checkpoint_event"
  | "checkpoint_evidence"
  | "delta_evidence"
  | "validation_evidence"
  | "review_started"
  | "review_completed"
  | "completion";

const BOUNDARIES: Boundary[] = [
  "plan", "budget", "checkpoint", "mutation", "seal_record", "checkpoint_event",
  "checkpoint_evidence", "delta_evidence", "validation_evidence", "review_started", "review_completed"
  , "completion"
];

function reached(boundary: Boundary, target: Boundary): boolean {
  return BOUNDARIES.indexOf(boundary) >= BOUNDARIES.indexOf(target);
}

function usage(): ModelResponse["usage"] {
  return {
    inputTokens: 1,
    outputTokens: 1,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    providerReported: true,
    costMicroUsd: 0,
    latencyMs: 1,
    retryAttempt: 0
  };
}

class RecoveryGateway implements ModelGateway {
  readonly provider = "test";
  readonly model = "recovery";
  readonly capabilities: ModelCapabilities = {
    contextWindowTokens: 16_000,
    maxOutputTokens: 2_000,
    tools: true,
    parallelTools: true,
    reasoning: false,
    structuredOutput: false,
    promptCache: false,
    tokenizer: "approximate"
  };
  private turn = 0;
  calls = 0;

  constructor(
    private readonly tryCompletion: boolean,
    private readonly completionEvidence: Array<{ evidenceId: string; kind: "validation" }> = []
  ) {}

  async complete(_request: ModelRequest): Promise<ModelResponse> {
    this.calls += 1;
    this.turn += 1;
    if (this.tryCompletion && this.turn === 1) {
      return {
        message: {
          role: "assistant",
          content: "",
          toolCalls: [{
            id: "recovered-completion",
            name: "complete_task",
            arguments: {
              summary: "Recovered mutation is complete.",
              criteria: [{
              criterion: "The durable mutation was recovered safely.",
              status: "met",
              evidence: this.completionEvidence
              }]
            }
          }]
        },
        finishReason: "tool_calls",
        usage: usage()
      };
    }
    return {
      message: {
        role: "assistant",
        content: "",
        toolCalls: [{
          id: `recovery-input-${this.turn}`,
          name: "request_user_input",
          arguments: { message: "Recovery stopped without replaying the mutation." }
        }]
      },
      finishReason: "tool_calls",
      usage: usage()
    };
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    yield { type: "done", response: await this.complete(request) };
  }

  async countTokens(_messages: ModelMessage[], _tools: ModelToolDefinition[] = []): Promise<number> {
    return 1;
  }
}

class CountingReviewer implements AccountableReviewerPort {
  readonly reviewerId = "fault-injection-reviewer";
  calls = 0;

  async review(input: ReviewerInput): Promise<ReviewEvidence> {
    this.calls += 1;
    return this.evidence(input);
  }

  async prepareReview(_input: ReviewerInput, _remainingBudgetMicroUsd: number): Promise<PreparedReviewerCall> {
    return {
      messages: [],
      maxOutputTokens: 1,
      budget: {
        estimatedInputTokens: 1,
        reserved: { inputTokens: 1, outputTokens: 1, costMicroUsd: 0, modelTurns: 1 },
        reservedAttempts: 1
      }
    };
  }

  async reviewPrepared(
    input: ReviewerInput,
    requestId: string,
    _prepared: PreparedReviewerCall,
    _signal: AbortSignal
  ): Promise<{ evidence: ReviewEvidence; usage: UsageRecord }> {
    this.calls += 1;
    return { evidence: this.evidence(input), usage: this.usage(input, requestId, {
      inputTokens: 1, outputTokens: 1, costMicroUsd: 0, modelTurns: 1,
      toolCalls: 0, children: 0
    }) };
  }

  failedUsage(
    input: ReviewerInput,
    requestId: string,
    _prepared: PreparedReviewerCall,
    _latencyMs: number,
    _error: unknown
  ): UsageRecord {
    return this.usage(input, requestId, {
      inputTokens: 1, outputTokens: 0, costMicroUsd: 0, modelTurns: 1,
      toolCalls: 0, children: 0
    });
  }

  recoveredUsage(input: ReviewerInput, requestId: string, consumed: BudgetAmounts): UsageRecord {
    return this.usage(input, requestId, consumed);
  }

  private evidence(input: ReviewerInput): ReviewEvidence {
    return {
      evidenceId: randomUUID(),
      sessionId: input.sessionId,
      runId: input.runId,
      kind: "review",
      status: "passed",
      createdAt: new Date().toISOString(),
      producer: { authority: "runtime", id: this.reviewerId },
      summary: "Recovered durable delta approved.",
      data: {
        reviewerId: this.reviewerId,
        verdict: "approved",
        findings: [],
        workspaceDeltaEvidenceIds: input.workspaceDeltas.map((item) => item.evidenceId)
      }
    };
  }

  private usage(input: ReviewerInput, requestId: string, consumed: BudgetAmounts): UsageRecord {
    return {
      usageId: `${requestId}:raw-usage`,
      requestId,
      sessionId: input.sessionId,
      runId: input.runId,
      role: "reviewer",
      routeId: "review-route",
      providerId: "test",
      modelId: "reviewer",
      tokenizerId: "test/approximate",
      tokenizerAccuracy: "approximate",
      providerReported: false,
      inputTokens: consumed.inputTokens,
      outputTokens: consumed.outputTokens,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costMicroUsd: consumed.costMicroUsd,
      latencyMs: 0,
      attempt: Math.max(1, consumed.modelTurns),
      occurredAt: new Date().toISOString()
    };
  }
}

function checkpointPayload(record: CheckpointRecord): JsonValue {
  return {
    checkpointId: record.checkpointId,
    sessionId: record.sessionId,
    runId: record.runId,
    status: record.status,
    createdAt: record.createdAt,
    preManifestDigest: record.preManifestDigest,
    ...(record.sealedAt ? { sealedAt: record.sealedAt } : {}),
    ...(record.postManifestDigest ? { postManifestDigest: record.postManifestDigest } : {}),
    ...(record.delta ? { delta: {
      added: [...record.delta.added],
      modified: [...record.delta.modified],
      deleted: [...record.delta.deleted]
    } } : {})
  };
}

interface SeededRecovery {
  workspace: string;
  storeRootDir: string;
  store: SegmentedJsonlStore;
  sessionId: string;
  runId: string;
  checkpoint?: CheckpointRecord;
}

async function seedRecovery(boundary: Boundary): Promise<SeededRecovery> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), `sigma-fault-${boundary}-`));
  const storeRootDir = path.join(workspace, ".agent");
  const store = new SegmentedJsonlStore({ rootDir: storeRootDir });
  const sessionId = `session-${randomUUID()}`;
  const runId = `run-${randomUUID()}`;
  let seq = 0;
  const append = async (
    type: AgentEventType,
    payload: JsonValue,
    authority: Exclude<ContextAuthority, "external_verifier"> = "runtime"
  ): Promise<void> => {
    seq += 1;
    await store.append({
      schemaVersion: EVENT_SCHEMA_VERSION,
      seq,
      eventId: randomUUID(),
      sessionId,
      runId,
      occurredAt: new Date(1_800_000_000_000 + seq).toISOString(),
      type,
      authority,
      payload: completeAgentEventPayload(type, payload) as JsonValue
    }, seq - 1);
  };

  await writeFile(path.join(workspace, "target.ts"), "before\n", "utf8");
  await append("session.created", { workspacePath: workspace, mode: "change" });
  await append("run.started", { mode: "change", deadlineAt: new Date(Date.now() + 60_000).toISOString() });
  await append("plan.updated", {
    previousRevision: 0,
    plan: {
      revision: 1,
      goal: "Exercise durable recovery.",
      activeNodeId: "root",
      nodes: [{
        id: "root",
        title: "Perform one mutation",
        dependencies: [],
        status: "in_progress",
        owner: { kind: "root" },
        acceptanceCriteria: ["Mutation occurs at most once"],
        evidence: []
      }]
    }
  });
  await append("user.message", { text: "Mutate target.ts exactly once." }, "user");
  const turn = { turnId: 1, effectRevision: 4 };
  await append("model.started", turn);
  const toolCalls = [
    { id: "mutation-call", name: "mutate_once", arguments: { path: "target.ts" } },
    { id: "read-proof", name: "list", arguments: { path: ".", limit: 20 } }
  ];
  await append("model.completed", {
    ...turn,
    message: { role: "assistant", content: "", toolCalls },
    toolCalls,
    finishReason: "tool_calls"
  });
  const now = new Date().toISOString();
  await append("tool.completed", {
    callId: "read-proof",
    name: "list",
    ok: true,
    output: "inspected",
    observedEffects: ["filesystem.read"],
    artifacts: [],
    diagnostics: [],
    startedAt: now,
    completedAt: now,
    ...turn
  }, "tool");
  if (!reached(boundary, "budget")) return { workspace, storeRootDir, store, sessionId, runId };

  await append("tool.requested", {
    callId: "mutation-call", name: "mutate_once", arguments: { path: "target.ts" }, ...turn
  });
  await append("execution.planned", {
    executionId: "mutation-call",
    toolCallId: "mutation-call",
    plan: {
      exactEffects: ["filesystem.write"],
      readPaths: [],
      writePaths: ["target.ts"],
      network: "none",
      processMode: "none",
      checkpointScope: ["target.ts"],
      idempotence: "non_replayable"
    }
  });
  const ledger = createBudgetLedger();
  const amount = {
    inputTokens: 0,
    outputTokens: 0,
    costMicroUsd: 0,
    modelTurns: 0,
    toolCalls: 1,
    children: 0
  };
  const reservationId = `reservation-${randomUUID()}`;
  ledger.reserved.toolCalls = 1;
  ledger.reservations.push({
    reservationId,
    ownerId: "tool:mutation-call",
    status: "reserved",
    requested: amount,
    consumed: { ...amount, toolCalls: 0 },
    createdAt: now
  });
  await append("budget.reserved", { reservationId, ledger });
  if (!reached(boundary, "checkpoint")) return { workspace, storeRootDir, store, sessionId, runId };

  const manager = new CheckpointManager({ rootDir: storeRootDir });
  let checkpoint = await manager.create({
    sessionId,
    runId,
    workspacePath: workspace,
    scopePaths: ["target.ts"],
    baseSeq: seq
  });
  await append("checkpoint.created", checkpointPayload(checkpoint));
  const boundOwner = `mutation-tool:${Buffer.from(JSON.stringify({
    callId: "mutation-call", checkpointId: checkpoint.checkpointId
  }), "utf8").toString("base64url")}`;
  ledger.reservations[0] = { ...ledger.reservations[0]!, ownerId: boundOwner };
  await append("budget.reservation_bound", { reservationId, ownerId: boundOwner, ledger });
  if (!reached(boundary, "mutation")) return { workspace, storeRootDir, store, sessionId, runId, checkpoint };

  await append("execution.started", { executionId: "mutation-call" });
  await append("tool.started", { callId: "mutation-call", name: "mutate_once", ...turn });
  await writeFile(path.join(workspace, "target.ts"), "mutated-once\n", "utf8");
  if (!reached(boundary, "seal_record")) return { workspace, storeRootDir, store, sessionId, runId, checkpoint };

  checkpoint = await manager.seal(sessionId, checkpoint.checkpointId);
  if (!reached(boundary, "checkpoint_event")) return { workspace, storeRootDir, store, sessionId, runId, checkpoint };
  await append("checkpoint.sealed", checkpointPayload(checkpoint));
  if (!reached(boundary, "checkpoint_evidence")) return { workspace, storeRootDir, store, sessionId, runId, checkpoint };

  await append("evidence.recorded", {
    evidenceId: `checkpoint:${checkpoint.checkpointId}`,
    sessionId,
    runId,
    kind: "checkpoint",
    status: "passed",
    createdAt: now,
    producer: { authority: "runtime", id: "checkpoint-manager" },
    summary: "Checkpoint sealed.",
    data: {
      checkpointId: checkpoint.checkpointId,
      checkpointStatus: "sealed",
      preManifestDigest: checkpoint.preManifestDigest,
      postManifestDigest: checkpoint.postManifestDigest
    }
  });
  if (!reached(boundary, "delta_evidence")) return { workspace, storeRootDir, store, sessionId, runId, checkpoint };

  const deltaId = `workspace-delta:${checkpoint.checkpointId}`;
  await append("evidence.recorded", {
    evidenceId: deltaId,
    sessionId,
    runId,
    kind: "workspace_delta",
    status: "passed",
    createdAt: now,
    producer: { authority: "runtime", id: "checkpoint-manager" },
    summary: "Workspace delta sealed.",
    data: {
      checkpointId: checkpoint.checkpointId,
      delta: checkpoint.delta!,
      reviewDiff: "--- a/target.ts\n+++ b/target.ts\n@@\n-before\n+executed-1"
    }
  });
  await append("execution.completed", {
    executionId: "mutation-call",
    evidenceIds: [deltaId]
  });
  await append("tool.completed", {
    callId: "mutation-call",
    name: "mutate_once",
    ok: true,
    output: "mutation executed before validation",
    observedEffects: ["filesystem.write"],
    artifacts: [],
    diagnostics: [],
    startedAt: now,
    completedAt: now,
    ...turn
  }, "tool");
  if (!reached(boundary, "validation_evidence")) return { workspace, storeRootDir, store, sessionId, runId, checkpoint };

  await append("evidence.recorded", {
    evidenceId: `command-validation:${checkpoint.checkpointId}`,
    sessionId,
    runId,
    kind: "validation",
    status: "passed",
    createdAt: now,
    producer: { authority: "runtime", id: "command-validator" },
    summary: "Project validation command passed.",
    data: { validator: "command", artifactIds: [], workspaceDeltaEvidenceIds: [deltaId] }
  });
  if (!reached(boundary, "review_started")) return { workspace, storeRootDir, store, sessionId, runId, checkpoint };

  const reviewerId = "fault-injection-reviewer";
  const reviewRequestId = `review:${createHash("sha256").update(JSON.stringify({
    sessionId,
    runId,
    reviewerId,
    ids: [deltaId],
    attempt: 1
  })).digest("hex")}`;
  const reviewerAmount = {
    inputTokens: 1,
    outputTokens: 1,
    costMicroUsd: 0,
    modelTurns: 1,
    toolCalls: 0,
    children: 0
  };
  const reviewerReservationId = `reservation-${randomUUID()}`;
  const reviewReserved = structuredClone(ledger);
  reviewReserved.reserved = { ...reviewerAmount, toolCalls: 1 };
  reviewReserved.reservations.push({
    reservationId: reviewerReservationId,
    ownerId: `reviewer:${reviewRequestId}`,
    status: "reserved",
    requested: reviewerAmount,
    consumed: { ...reviewerAmount, inputTokens: 0, outputTokens: 0, modelTurns: 0 },
    createdAt: now
  });
  await append("budget.reserved", { reservationId: reviewerReservationId, ledger: reviewReserved });
  await append("review.started", {
    reviewerId,
    requestId: reviewRequestId,
    workspaceDeltaEvidenceIds: [deltaId]
  });
  if (!reached(boundary, "review_completed")) return { workspace, storeRootDir, store, sessionId, runId, checkpoint };
  const reviewCommitted = structuredClone(reviewReserved);
  reviewCommitted.reserved = {
    inputTokens: 0, outputTokens: 0, costMicroUsd: 0, modelTurns: 0, toolCalls: 1, children: 0
  };
  reviewCommitted.consumed = {
    ...ledger.consumed,
    inputTokens: 1,
    outputTokens: 1,
    modelTurns: 1
  };
  reviewCommitted.reservations[1] = {
    ...reviewCommitted.reservations[1]!,
    status: "committed",
    consumed: reviewerAmount,
    settledAt: now
  };
  await append("budget.committed", { reservationId: reviewerReservationId, ledger: reviewCommitted });
  await append("usage.recorded", {
    usageId: `${reviewRequestId}:usage`,
    requestId: reviewRequestId,
    sessionId,
    runId,
    role: "reviewer",
    routeId: "review-route",
    providerId: "test",
    modelId: "reviewer",
    tokenizerId: "test/approximate",
    tokenizerAccuracy: "approximate",
    providerReported: false,
    inputTokens: 1,
    outputTokens: 1,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costMicroUsd: 0,
    latencyMs: 1,
    attempt: 1,
    occurredAt: now
  });
  await append("review.completed", {
    evidenceId: `review:${checkpoint.checkpointId}`,
    sessionId,
    runId,
    kind: "review",
    status: "passed",
    createdAt: now,
    producer: { authority: "runtime", id: "fault-injection-reviewer" },
    summary: "Recovered delta approved.",
    data: {
      reviewerId: "fault-injection-reviewer",
      verdict: "approved",
      findings: [],
      workspaceDeltaEvidenceIds: [deltaId]
    }
  });
  const mutationCommitted = structuredClone(reviewCommitted);
  mutationCommitted.reserved.toolCalls = 0;
  mutationCommitted.consumed.toolCalls = 1;
  mutationCommitted.reservations[0] = {
    ...mutationCommitted.reservations[0]!,
    status: "committed",
    consumed: { ...amount },
    settledAt: now
  };
  await append("budget.committed", { reservationId, ledger: mutationCommitted });
  if (!reached(boundary, "completion")) return { workspace, storeRootDir, store, sessionId, runId, checkpoint };

  const completionTurn = { turnId: 2, effectRevision: seq };
  await append("model.started", completionTurn);
  const completionCall = {
    id: "durable-completion",
    name: "complete_task",
    arguments: {
      summary: "Durable recovery completed.",
      criteria: [{
        criterion: "The recovered change is evidence-backed.",
        status: "met",
        evidence: [{
          evidenceId: `command-validation:${checkpoint.checkpointId}`,
          kind: "validation"
        }]
      }]
    }
  };
  await append("model.completed", {
    ...completionTurn,
    message: { role: "assistant", content: "", toolCalls: [completionCall] },
    toolCalls: [completionCall],
    finishReason: "tool_calls"
  });
  await append("plan.updated", {
    previousRevision: 1,
    plan: {
      revision: 2,
      goal: "Exercise durable recovery.",
      nodes: [{
        id: "root",
        title: "Perform one mutation",
        dependencies: [],
        status: "completed",
        owner: { kind: "root" },
        acceptanceCriteria: ["Mutation occurs at most once"],
        evidence: [
          { evidenceId: deltaId, kind: "workspace_delta" },
          { evidenceId: `command-validation:${checkpoint.checkpointId}`, kind: "validation" },
          { evidenceId: `review:${checkpoint.checkpointId}`, kind: "review" }
        ]
      }]
    }
  });
  const completionReservationId = `reservation-${randomUUID()}`;
  const completionReserved = structuredClone(mutationCommitted);
  completionReserved.reserved.toolCalls = 1;
  completionReserved.reservations.push({
    reservationId: completionReservationId,
    ownerId: "tool:durable-completion",
    status: "reserved",
    requested: amount,
    consumed: { ...amount, toolCalls: 0 },
    createdAt: now
  });
  await append("budget.reserved", { reservationId: completionReservationId, ledger: completionReserved });
  await append("tool.started", { callId: "durable-completion", name: "complete_task", ...completionTurn });
  const completionCommitted = structuredClone(completionReserved);
  completionCommitted.reserved.toolCalls = 0;
  completionCommitted.consumed.toolCalls = 2;
  completionCommitted.reservations[2] = {
    ...completionCommitted.reservations[2]!,
    status: "committed",
    consumed: { ...amount },
    settledAt: now
  };
  await append("budget.committed", { reservationId: completionReservationId, ledger: completionCommitted });
  await append("tool.completed", {
    callId: "durable-completion",
    name: "complete_task",
    ok: true,
    output: JSON.stringify(completionCall.arguments),
    observedEffects: ["outcome.propose"],
    artifacts: [],
    diagnostics: [],
    startedAt: now,
    completedAt: now,
    ...completionTurn
  }, "tool");
  return { workspace, storeRootDir, store, sessionId, runId, checkpoint };
}

async function events(store: SegmentedJsonlStore, sessionId: string): Promise<AgentEventEnvelope[]> {
  const result: AgentEventEnvelope[] = [];
  for await (const item of store.events(sessionId)) result.push(item);
  return result;
}

function mutationReservationIds(stored: AgentEventEnvelope[]): Set<string> {
  const result = new Set<string>();
  for (const item of stored.filter((event) => event.type === "budget.reserved")) {
    const payload = item.payload as { ledger?: { reservations?: Array<{ reservationId?: string; ownerId?: string }> } };
    for (const reservation of payload.ledger?.reservations ?? []) {
      if (reservation.ownerId === "tool:mutation-call" && reservation.reservationId) {
        result.add(reservation.reservationId);
      }
    }
  }
  return result;
}

function settledMutationReservations(stored: AgentEventEnvelope[], type: "budget.committed" | "budget.released"): number {
  const reservationIds = mutationReservationIds(stored);
  return stored.filter((item) => item.type === type
    && reservationIds.has((item.payload as { reservationId?: string }).reservationId ?? "")).length;
}

function recoveryRuntime(
  fixture: SeededRecovery,
  tryCompletion: boolean
): {
  runtime: ReturnType<typeof createRuntime>;
  executions: { count: number };
  reviewer: CountingReviewer;
  gateway: RecoveryGateway;
} {
  const executions = { count: 0 };
  const reviewer = new CountingReviewer();
  const gateway = new RecoveryGateway(tryCompletion, fixture.checkpoint ? [{
    evidenceId: `command-validation:${fixture.checkpoint.checkpointId}`,
    kind: "validation"
  }] : []);
  const tools = registerBuiltinTools(new EffectToolRegistry());
  tools.register({
    descriptor: {
      name: "mutate_once",
      description: "Mutation counter used to prove generic restart idempotence.",
      inputSchema: { type: "object" },
      possibleEffects: ["filesystem.write"],
      executionMode: "exclusive",
      resourceKeys: ["workspace:mutation"],
      writePathArguments: ["path"],
      approval: "auto",
      idempotent: false,
      timeoutMs: 5_000
    },
    async execute(request) {
      executions.count += 1;
      await writeFile(path.join(fixture.workspace, "target.ts"), `executed-${executions.count}\n`, "utf8");
      const timestamp = new Date().toISOString();
      return {
        callId: request.callId,
        ok: true,
        output: "mutation executed",
        observedEffects: ["filesystem.write"],
        actualEffects: ["filesystem.write"],
        artifacts: [],
        diagnostics: [],
        startedAt: timestamp,
        completedAt: timestamp
      };
    }
  });
  return {
    executions,
    reviewer,
    gateway,
    runtime: createRuntime({
      gateway,
      tools,
      store: fixture.store,
      storeRootDir: fixture.storeRootDir,
      reviewer,
      permissionMode: "auto",
      runDeadlineMs: 10_000
    })
  };
}

describe("durable transaction fault-injection recovery", () => {
  for (const boundary of ["plan", "budget", "checkpoint"] as const) {
    it(`restarts once without duplicate execution after the ${boundary} boundary`, async () => {
      const fixture = await seedRecovery(boundary);
      const { runtime, executions, reviewer } = recoveryRuntime(fixture, false);
      await runtime.command({ type: "resume", sessionId: fixture.sessionId });
      await expect(runtime.waitForOutcome(fixture.sessionId)).resolves.toMatchObject({ kind: "needs_input" });
      expect(executions.count).toBe(1);
      await expect(readFile(path.join(fixture.workspace, "target.ts"), "utf8")).resolves.toBe("executed-1\n");
      expect(reviewer.calls).toBe(0);
      const stored = await events(fixture.store, fixture.sessionId);
      expect(settledMutationReservations(stored, "budget.committed")).toBe(0);
      expect(stored.filter((item) => item.type === "run.completed")).toHaveLength(0);
    });
  }

  it("never replays an open mutation and resumes only after the user keeps its sealed delta", async () => {
    const fixture = await seedRecovery("mutation");
    const { runtime, executions, reviewer } = recoveryRuntime(fixture, true);
    await runtime.command({ type: "resume", sessionId: fixture.sessionId });
    await expect(runtime.waitForOutcome(fixture.sessionId)).resolves.toMatchObject({
      kind: "needs_input",
      requestId: `checkpoint:${fixture.checkpoint!.checkpointId}`
    });
    expect(executions.count).toBe(0);
    await runtime.command({
      type: "checkpoint_recovery",
      sessionId: fixture.sessionId,
      checkpointId: fixture.checkpoint!.checkpointId,
      decision: "keep"
    });
    await runtime.command({ type: "resume", sessionId: fixture.sessionId });
    await expect(runtime.waitForOutcome(fixture.sessionId)).resolves.toMatchObject({ kind: "needs_input" });
    expect(executions.count).toBe(0);
    expect(reviewer.calls).toBe(0);
    const stored = await events(fixture.store, fixture.sessionId);
    expect(stored.filter((item) => item.type === "tool.failed"
      && JSON.stringify(item.payload).includes("recovery_result_lost_no_replay"))).toHaveLength(1);
    expect(settledMutationReservations(stored, "budget.committed")).toBe(0);
    expect(stored.filter((item) => item.type === "run.completed")).toHaveLength(0);
  });

  it("restores an open mutation without replay, duplicate charge, or false completion", async () => {
    const fixture = await seedRecovery("mutation");
    const { runtime, executions, reviewer } = recoveryRuntime(fixture, false);
    await runtime.command({ type: "resume", sessionId: fixture.sessionId });
    await runtime.waitForOutcome(fixture.sessionId);
    await runtime.command({
      type: "checkpoint_recovery",
      sessionId: fixture.sessionId,
      checkpointId: fixture.checkpoint!.checkpointId,
      decision: "restore"
    });
    await runtime.command({ type: "resume", sessionId: fixture.sessionId });
    await expect(runtime.waitForOutcome(fixture.sessionId)).resolves.toMatchObject({ kind: "needs_input" });
    expect(executions.count).toBe(0);
    expect(reviewer.calls).toBe(0);
    await expect(readFile(path.join(fixture.workspace, "target.ts"), "utf8")).resolves.toBe("before\n");
    const stored = await events(fixture.store, fixture.sessionId);
    expect(settledMutationReservations(stored, "budget.committed")).toBe(1);
    expect(stored.filter((item) => item.type === "run.completed")).toHaveLength(0);
  });

  for (const boundary of [
    "seal_record", "checkpoint_event", "checkpoint_evidence", "delta_evidence",
    "validation_evidence", "review_started", "review_completed"
  ] as const) {
    it(`backfills ${boundary} idempotently without replay or gate bypass`, async () => {
      const fixture = await seedRecovery(boundary);
      const { runtime, executions, reviewer } = recoveryRuntime(fixture, true);
      await runtime.command({ type: "resume", sessionId: fixture.sessionId });
      const outcome = await runtime.waitForOutcome(fixture.sessionId);
      const stored = await events(fixture.store, fixture.sessionId);
      expect(executions.count).toBe(0);
      expect(reviewer.calls).toBe(boundary === "validation_evidence" ? 1 : 0);
      expect(outcome.kind).toBe(boundary === "review_completed" ? "completed" : "needs_input");

      const checkpointId = fixture.checkpoint!.checkpointId;
      for (const evidenceId of [
        `checkpoint:${checkpointId}`,
        `workspace-delta:${checkpointId}`,
        `checkpoint-validation:${checkpointId}`
      ]) {
        expect(stored.filter((item) => item.type === "evidence.recorded"
          && (item.payload as { evidenceId?: string }).evidenceId === evidenceId)).toHaveLength(1);
      }
      const mutationCommitted = boundary === "validation_evidence" || boundary === "review_completed";
      expect(settledMutationReservations(stored, "budget.committed")).toBe(mutationCommitted ? 1 : 0);
      if (mutationCommitted) {
        const reservationIds = mutationReservationIds(stored);
        const reviewIndex = stored.findIndex((item) => item.type === "review.completed");
        const commitIndex = stored.findIndex((item) => item.type === "budget.committed"
          && reservationIds.has((item.payload as { reservationId?: string }).reservationId ?? ""));
        expect(commitIndex).toBeGreaterThan(reviewIndex);
      }
      expect(stored.filter((item) => item.type === "tool.approval_requested"
        && JSON.stringify(item.payload).includes("mutation-call"))).toHaveLength(0);
      expect(stored.filter((item) => item.type === "run.completed")).toHaveLength(
        boundary === "review_completed" ? 1 : 0
      );
      if (boundary === "review_started" || boundary === "review_completed") {
        const reviewerReservationIds = new Set(stored.flatMap((item) => {
          if (item.type !== "budget.reserved") return [];
          const payload = item.payload as {
            ledger?: { reservations?: Array<{ reservationId?: string; ownerId?: string }> };
          };
          return (payload.ledger?.reservations ?? []).flatMap((reservation) =>
            reservation.ownerId?.startsWith("reviewer:") && reservation.reservationId
              ? [reservation.reservationId] : []);
        }));
        expect(stored.filter((item) => item.type === "budget.committed"
          && reviewerReservationIds.has((item.payload as { reservationId?: string }).reservationId ?? "")))
          .toHaveLength(1);
        expect(stored.filter((item) => item.type === "usage.recorded"
          && (item.payload as { role?: string }).role === "reviewer")).toHaveLength(1);
        expect(stored.filter((item) => item.type === "review.completed")).toHaveLength(1);
      }
    });
  }

  it("publishes a durable outcome-pending completion exactly once after restart", async () => {
    const fixture = await seedRecovery("completion");
    const { runtime, executions, reviewer, gateway } = recoveryRuntime(fixture, true);
    await runtime.command({ type: "resume", sessionId: fixture.sessionId });
    await expect(runtime.waitForOutcome(fixture.sessionId)).resolves.toMatchObject({ kind: "completed" });
    expect(executions.count).toBe(0);
    expect(reviewer.calls).toBe(0);
    expect(gateway.calls).toBe(0);
    const stored = await events(fixture.store, fixture.sessionId);
    expect(stored.filter((item) => item.type === "run.completed")).toHaveLength(1);
    expect(settledMutationReservations(stored, "budget.committed")).toBe(1);
  });
});
