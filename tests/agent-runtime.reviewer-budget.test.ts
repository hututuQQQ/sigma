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
  type ToolReceipt,
  type ValidationEvidence,
  type WorkspaceDeltaEvidence
} from "../packages/agent-protocol/src/index.js";
import type { ModelRouteConstraints } from "../packages/agent-model/src/index.js";
import { BudgetController } from "../packages/agent-runtime/src/budget-controller.js";
import {
  goalReferencedWorkspaceReads,
  ReviewCoordinator
} from "../packages/agent-runtime/src/review-coordinator.js";
import { normalizeReview } from "../packages/agent-runtime/src/review-normalization.js";
import { ModelReviewer, type ReviewerPort } from "../packages/agent-runtime/src/reviewer.js";
import type {
  ReviewerToolEnvironment,
  ReviewerToolSessionPort
} from "../packages/agent-runtime/src/reviewer-contracts.js";
import type { RuntimeSession } from "../packages/agent-runtime/src/types.js";
import { runtimeSessionFixture } from "./testkit/runtime-session-fixture.js";

const now = "2026-07-11T00:00:00.000Z";

function completeCoverage() {
  return {
    scope: "complete" as const,
    rationale: "Independent current-frontier inspection covers the declared requirement.",
    checkedClaims: ["The current frontier satisfies the declared requirement."],
    limitations: [],
    falsificationAttempt: "Ran an independent check intended to contradict the completion claim."
  };
}

function unavailableCoverage() {
  return {
    scope: "unavailable" as const,
    rationale: "No independent compatibility probe was available.",
    checkedClaims: ["Whether the current frontier preserves compatibility."],
    limitations: ["Compatibility remains unverified."],
    falsificationAttempt: "Looked for an applicable independent compatibility check."
  };
}

function workspaceReadReceipt(
  callId: string,
  requestedPath: string,
  output: string,
  options: {
    sha256?: string;
    offset?: number;
    returnedLines?: number;
    totalLines?: number;
  } = {}
): ToolReceipt {
  const offset = options.offset ?? 0;
  const returnedLines = options.returnedLines ?? 1;
  const totalLines = options.totalLines ?? 1;
  return {
    callId,
    ok: true,
    output,
    result: {
      status: "read",
      path: requestedPath,
      scope: "workspace",
      sha256: options.sha256 ?? "a".repeat(64),
      byteLength: output.length,
      offset,
      returnedLines,
      totalLines
    },
    outcome: { status: "succeeded", output, diagnosticCodes: [] },
    observedEffects: ["filesystem.read"],
    actualEffects: ["filesystem.read"],
    artifacts: [],
    diagnostics: [],
    startedAt: now,
    completedAt: now
  };
}

function workspaceMutationReceipt(callId: string, modifiedPath: string): ToolReceipt {
  return {
    callId,
    ok: true,
    output: "updated",
    outcome: { status: "succeeded", output: "updated", diagnosticCodes: [] },
    observedEffects: ["filesystem.write"],
    actualEffects: ["filesystem.write"],
    workspaceDelta: { added: [], modified: [modifiedPath], deleted: [] },
    artifacts: [],
    diagnostics: [],
    startedAt: now,
    completedAt: now
  };
}

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
    private readonly content = JSON.stringify({
      verdict: "approved",
      findings: [],
      criteria: [{
        criterionIndex: 0,
        status: "satisfied",
        coverage: completeCoverage(),
        evidenceIds: ["delta"]
      }],
      requiredValidations: []
    }),
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

class StructuredReviewerGateway implements ModelGateway {
  readonly provider = "deepseek";
  readonly model = "deepseek-v4-pro";
  readonly capabilities: ModelCapabilities = {
    contextWindowTokens: 32_000,
    maxOutputTokens: 8_192,
    tools: true,
    parallelTools: false,
    reasoning: true,
    structuredOutput: false,
    promptCache: true,
    tokenizer: "approximate",
    strictToolChoice: true,
    strictToolChoiceDisablesReasoning: true
  };
  readonly requests: ModelRequest[] = [];

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    return {
      message: {
        role: "assistant",
        content: "",
        toolCalls: [{
          id: "review-verdict",
          name: "submit_verification",
          arguments: {
            verdict: "approved",
            findings: [],
            criteria: [{
              criterionIndex: 0,
              status: "satisfied",
              coverage: completeCoverage(),
              evidenceIds: ["validation"]
            }],
            requiredValidations: []
          }
        }]
      },
      finishReason: "tool_calls",
      usage: {
        inputTokens: 90,
        outputTokens: 30,
        reasoningTokens: 0,
        cacheReadTokens: 80,
        cacheWriteTokens: 0,
        providerReported: true,
        costMicroUsd: 5,
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

class InspectOnceThenSubmitGateway implements ModelGateway {
  readonly provider = "deepseek";
  readonly model = "deepseek-v4-pro";
  readonly capabilities: ModelCapabilities = {
    contextWindowTokens: 32_000,
    maxOutputTokens: 8_192,
    tools: true,
    parallelTools: false,
    reasoning: true,
    structuredOutput: false,
    promptCache: true,
    tokenizer: "approximate",
    strictToolChoice: true,
    strictToolChoiceDisablesReasoning: true
  };
  readonly requests: ModelRequest[] = [];

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    const canSubmit = request.tools.some((tool) =>
      tool.name === "submit_verification");
    return {
      message: canSubmit
        ? {
            role: "assistant",
            content: "",
            toolCalls: [{
              id: "review-verdict",
              name: "submit_verification",
              arguments: {
                verdict: "approved",
                findings: [],
                criteria: [{
                  criterionIndex: 0,
                  status: "satisfied",
                  coverage: completeCoverage()
                }],
                requiredValidations: []
              }
            }]
          }
        : {
            role: "assistant",
            content: "",
            toolCalls: [{
              id: "inspect-current-frontier",
              name: "read",
              arguments: { path: "source.txt" }
            }]
          },
      finishReason: "tool_calls",
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        reasoningTokens: 0,
        cacheReadTokens: 90,
        cacheWriteTokens: 0,
        providerReported: true,
        costMicroUsd: 5,
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

class InspectThenSubmitGateway implements ModelGateway {
  readonly provider = "deepseek";
  readonly model = "deepseek-v4-pro";
  readonly capabilities: ModelCapabilities = {
    contextWindowTokens: 32_000,
    maxOutputTokens: 8_192,
    tools: true,
    parallelTools: false,
    reasoning: true,
    structuredOutput: false,
    promptCache: true,
    tokenizer: "approximate",
    strictToolChoice: true,
    strictToolChoiceDisablesReasoning: true
  };
  readonly requests: ModelRequest[] = [];
  private lastInspectionId = "";

  constructor(private readonly narrateOnTurn?: number) {}

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    const turn = this.requests.length;
    if (turn === this.narrateOnTurn && request.toolChoice !== "required") {
      return {
        message: {
          role: "assistant",
          content: "The inspected evidence is sufficient; I am ready to submit the verdict."
        },
        finishReason: "stop",
        usage: {
          inputTokens: 100,
          outputTokens: 10,
          reasoningTokens: 0,
          cacheReadTokens: 90,
          cacheWriteTokens: 0,
          providerReported: true,
          costMicroUsd: 5,
          latencyMs: 1,
          retryAttempt: 0
        }
      };
    }
    if (turn < 4) {
      this.lastInspectionId = `inspect-${turn}`;
      return {
        message: {
          role: "assistant",
          content: "",
          toolCalls: [{
            id: this.lastInspectionId,
            name: "read",
            arguments: { path: `source-${turn}.txt` }
          }]
        },
        finishReason: "tool_calls",
        usage: {
          inputTokens: 90,
          outputTokens: 20,
          reasoningTokens: 0,
          cacheReadTokens: 80,
          cacheWriteTokens: 0,
          providerReported: true,
          costMicroUsd: 5,
          latencyMs: 1,
          retryAttempt: 0
        }
      };
    }
    if (!request.messages.at(-1)?.content.includes(
      "[verification_verdict_required]"
    )) {
      return {
        message: {
          role: "assistant",
          content: "I finished inspecting the change."
        },
        finishReason: "stop",
        usage: {
          inputTokens: 100,
          outputTokens: 10,
          reasoningTokens: 0,
          cacheReadTokens: 90,
          cacheWriteTokens: 0,
          providerReported: true,
          costMicroUsd: 5,
          latencyMs: 1,
          retryAttempt: 0
        }
      };
    }
    return {
      message: {
        role: "assistant",
        content: "",
        toolCalls: [{
          id: "review-verdict",
          name: "submit_verification",
          arguments: {
            verdict: "approved",
            findings: [],
            criteria: [{
              criterionIndex: 0,
              status: "satisfied",
              coverage: completeCoverage(),
              evidenceIds: [`review-check:${this.lastInspectionId}`]
            }],
            requiredValidations: []
          }
        }]
      },
      finishReason: "tool_calls",
      usage: {
        inputTokens: 100,
        outputTokens: 30,
        reasoningTokens: 0,
        cacheReadTokens: 90,
        cacheWriteTokens: 0,
        providerReported: true,
        costMicroUsd: 5,
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

class RecoverableVerdictProtocolGateway implements ModelGateway {
  readonly provider = "deepseek";
  readonly model = "deepseek-v4-pro";
  readonly capabilities: ModelCapabilities = {
    contextWindowTokens: 32_000,
    maxOutputTokens: 8_192,
    tools: true,
    parallelTools: false,
    reasoning: true,
    structuredOutput: false,
    promptCache: true,
    tokenizer: "approximate",
    strictToolChoice: true,
    strictToolChoiceDisablesReasoning: true
  };
  readonly requests: ModelRequest[] = [];

  constructor(private readonly failure: "mixed" | "malformed") {}

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    const usage = {
      inputTokens: 100,
      outputTokens: 20,
      reasoningTokens: 0,
      cacheReadTokens: 90,
      cacheWriteTokens: 0,
      providerReported: true,
      costMicroUsd: 5,
      latencyMs: 1,
      retryAttempt: 0
    };
    if (this.requests.length === 1) {
      return {
        message: {
          role: "assistant",
          content: "",
          toolCalls: [{
            id: "inspect-before-verdict",
            name: "read",
            arguments: { path: "source.txt" }
          }]
        },
        finishReason: "tool_calls",
        usage
      };
    }
    if (this.requests.length === 2) {
      const submission = {
        id: "early-verdict",
        name: "submit_verification",
        arguments: this.failure === "malformed"
          ? "not-an-object"
          : {
              verdict: "approved",
              findings: [],
              criteria: [{
                criterionIndex: 0,
                status: "satisfied",
                coverage: completeCoverage(),
                evidenceIds: ["review-check:inspect-before-verdict"]
              }],
              requiredValidations: []
            }
      };
      return {
        message: {
          role: "assistant",
          content: "",
          toolCalls: this.failure === "mixed"
            ? [
                submission,
                {
                  id: "unsafe-parallel-inspection",
                  name: "read",
                  arguments: { path: "another-source.txt" }
                }
              ]
            : [submission]
        },
        finishReason: "tool_calls",
        usage
      };
    }
    return {
      message: {
        role: "assistant",
        content: "",
        toolCalls: [{
          id: "recovered-verdict",
          name: "submit_verification",
          arguments: {
            verdict: "approved",
            findings: [],
            criteria: [{
              criterionIndex: 0,
              status: "satisfied",
              coverage: completeCoverage(),
              evidenceIds: ["review-check:inspect-before-verdict"]
            }],
            requiredValidations: []
          }
        }]
      },
      finishReason: "tool_calls",
      usage
    };
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    yield { type: "done", response: await this.complete(request) };
  }

  async countTokens(): Promise<number> {
    return 100;
  }
}

function inspectionEnvironment(): ReviewerToolEnvironment {
  return {
    definitions: () => [{
      name: "read",
      description: "Read a file for verification.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { path: { type: "string" } },
        required: ["path"]
      }
    }],
    async open(): Promise<ReviewerToolSessionPort> {
      return {
        definitions: () => [],
        async execute(call) {
          return {
            message: {
              role: "tool",
              content: `inspected ${String(
                (call.arguments as Record<string, JsonValue>).path
              )}`,
              toolCallId: call.id
            },
            check: {
              toolName: call.name,
              evidenceIds: [`review-check:${call.id}`],
              summary: "Read completed."
            }
          };
        },
        async close() {}
      };
    }
  };
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
  it("supplies bounded snapshots only for workspace reads named in the goal", () => {
    const target = runtimeSessionFixture();
    target.durable.state.plan.goal = "Update config.txt according to rules.txt.";
    target.durable.state.messages = [{
      role: "assistant",
      content: "",
      toolCalls: [
        { id: "rules-read", name: "read", arguments: { path: "rules.txt" } },
        { id: "notes-read", name: "read", arguments: { path: "notes.txt" } }
      ]
    }];
    target.durable.state.receipts = [
      workspaceReadReceipt("rules-read", "rules.txt", "1: allowed"),
      workspaceReadReceipt("notes-read", "notes.txt", "1: unrelated")
    ];

    expect(goalReferencedWorkspaceReads(target)).toEqual([expect.objectContaining({
      path: "rules.txt",
      complete: true,
      content: "1: allowed"
    })]);
  });

  it("uses current complete snapshots and drops reads invalidated by later mutations", () => {
    const target = runtimeSessionFixture();
    target.durable.state.plan.goal = "Update config.txt according to rules.txt and policy.txt.";
    target.durable.state.messages = [{
      role: "assistant",
      content: "",
      toolCalls: [
        { id: "rules-old", name: "read", arguments: { path: "rules.txt" } },
        { id: "rules-current", name: "read", arguments: { path: "rules.txt" } },
        { id: "rules-partial", name: "read", arguments: { path: "rules.txt" } },
        { id: "policy-stale", name: "read", arguments: { path: "policy.txt" } }
      ]
    }];
    const currentRules = "1: current\n2: retained";
    target.durable.state.receipts = [
      workspaceReadReceipt("rules-old", "rules.txt", "1: obsolete", {
        sha256: "a".repeat(64)
      }),
      workspaceReadReceipt("rules-current", "rules.txt", currentRules, {
        sha256: "b".repeat(64),
        returnedLines: 2,
        totalLines: 2
      }),
      workspaceReadReceipt("rules-partial", "rules.txt", "1: current", {
        sha256: "b".repeat(64),
        returnedLines: 1,
        totalLines: 2
      }),
      workspaceReadReceipt("policy-stale", "policy.txt", "1: stale"),
      workspaceMutationReceipt("policy-write", "policy.txt")
    ];

    expect(goalReferencedWorkspaceReads(target)).toEqual([expect.objectContaining({
      path: "rules.txt",
      sha256: "b".repeat(64),
      complete: true,
      content: currentRules
    })]);
  });

  it("places goal-referenced workspace snapshots in the independent review request", async () => {
    const gateway = new ReviewerGateway();
    await new ModelReviewer(gateway).review({
      sessionId: "session",
      runId: "run",
      goal: "Constrain the change with rules.txt.",
      frontierRevision: 1,
      stateDigest: "a".repeat(64),
      reviewBasisDigest: "b".repeat(64),
      workspaceDeltas: [delta()],
      validations: [validation()],
      goalReferencedWorkspaceReads: [{
        path: "rules.txt",
        sha256: "c".repeat(64),
        byteLength: 9,
        offset: 0,
        returnedLines: 1,
        totalLines: 1,
        complete: true,
        content: "1: allowed"
      }]
    }, new AbortController().signal);

    const request = gateway.requests[0]!;
    const payload = JSON.parse(request.messages[1]!.content) as {
      goalReferencedWorkspaceReads: Array<{ path: string; complete: boolean; content: string }>;
    };
    expect(request.messages[0]!.content).toContain("goal-referenced workspace read snapshots");
    expect(payload.goalReferencedWorkspaceReads).toEqual([expect.objectContaining({
      path: "rules.txt",
      complete: true,
      content: "1: allowed"
    })]);
  });

  it("records typed review unavailability before invoking an unaffordable model", async () => {
    const target = runtimeSession(limits({ inputTokens: 119 }));
    const gateway = new ReviewerGateway();
    const { budgets, emit, events } = harness(target);
    const coordinator = new ReviewCoordinator(new ModelReviewer(gateway), emit, budgets);

    await coordinator.maybeReview(target, new AbortController().signal);
    expect(gateway.calls).toBe(0);
    expect(target.durable.state.evidence.find((item) => item.kind === "review"))
      .toMatchObject({
        status: "failed",
        data: {
          failureKind: "infrastructure",
          failureCode: "review_unavailable"
        }
      });
    expect(events).toContain("review.completed");
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

  it("lets the independent reviewer judge an unvalidated text mutation", async () => {
    const target = runtimeSession();
    target.durable.state.evidence = [delta()];
    const gateway = new ReviewerGateway();
    const { budgets, emit } = harness(target);

    await new ReviewCoordinator(new ModelReviewer(gateway), emit, budgets)
      .maybeReview(target, new AbortController().signal, true, "completion");

    expect(gateway.calls).toBe(1);
    expect(target.durable.state.evidence.find((item) => item.kind === "review")).toMatchObject({
      status: "passed",
      data: {
        schemaVersion: 3,
        verdict: "approved"
      }
    });
  });

  it("does not let runtime coverage or command classifiers override a reviewer verdict", async () => {
    const narrowTarget = runtimeSession();
    narrowTarget.durable.state.evidence = [delta(), validation([])];
    const narrowGateway = new ReviewerGateway();
    const narrowHarness = harness(narrowTarget);
    await new ReviewCoordinator(
      new ModelReviewer(narrowGateway),
      narrowHarness.emit,
      narrowHarness.budgets
    ).maybeReview(narrowTarget, new AbortController().signal, true, "completion");
    expect(narrowTarget.durable.state.evidence.find((item) => item.kind === "review"))
      .toMatchObject({
        status: "passed",
        data: { schemaVersion: 3, verdict: "approved" }
      });

    const failedTarget = runtimeSession();
    const failed = validation();
    failed.status = "failed";
    failed.summary = "Typecheck exited with errors.";
    failed.data = {
      ...failed.data,
      exitCode: 1,
      termination: {
        state: "exited",
        processStarted: true,
        timedOut: false,
        idleTimedOut: false,
        cancelled: false
      },
      claim: { ...failed.data.claim!, status: "failed" }
    };
    failedTarget.durable.state.evidence = [delta(), failed];
    const failedGateway = new ReviewerGateway();
    const failedHarness = harness(failedTarget);
    await new ReviewCoordinator(
      new ModelReviewer(failedGateway),
      failedHarness.emit,
      failedHarness.budgets
    ).maybeReview(failedTarget, new AbortController().signal, true, "completion");
    expect(failedTarget.durable.state.evidence.find((item) => item.kind === "review"))
      .toMatchObject({
        status: "passed",
        data: { schemaVersion: 3, verdict: "approved" }
      });
  });

  it("requires the V3 reviewer to enumerate durable acceptance criteria", async () => {
    const gateway = new ReviewerGateway(
      undefined,
      JSON.stringify({
        verdict: "validation_required",
        findings: [],
        criteria: [{
          criterion: "Preserve compatibility with the documented format.",
          status: "unverified",
          coverage: unavailableCoverage(),
          evidence: [],
          summary: "No compatibility probe was supplied."
        }],
        requiredValidations: [{
          purpose: "Run the compatibility probe.",
          claimKind: "acceptance"
        }]
      })
    );

    const result = await new ModelReviewer(gateway).review({
      sessionId: "session",
      runId: "run",
      goal: "Change the parser and preserve compatibility with the documented format.",
      acceptanceCriteria: ["Preserve compatibility with the documented format."],
      frontierRevision: 1,
      stateDigest: "a".repeat(64),
      reviewBasisDigest: "b".repeat(64),
      reviewMode: "completion",
      workspaceDeltas: [delta()],
      validations: []
    }, new AbortController().signal);

    expect(result).toMatchObject({
      status: "failed",
      data: {
        schemaVersion: 3,
        verdict: "changes_requested",
        criteria: [expect.objectContaining({
          criterion: "Preserve compatibility with the documented format.",
          status: "unverified"
        })]
      }
    });
  });

  it("uses the V3 submit tool without forcing an immediate verdict before inspection", async () => {
    const gateway = new StructuredReviewerGateway();
    const criterion = "Preserve compatibility with the documented format.";
    const result = await new ModelReviewer(gateway).review({
      sessionId: "session",
      runId: "run",
      goal: "Change the parser.",
      acceptanceCriteria: [criterion],
      frontierRevision: 1,
      stateDigest: "a".repeat(64),
      reviewBasisDigest: "b".repeat(64),
      reviewMode: "completion",
      workspaceDeltas: [delta()],
      validations: [validation()]
    }, new AbortController().signal);

    expect(gateway.requests[0]).toMatchObject({
      toolChoice: "auto",
      maxOutputTokens: 2_048,
      tools: [expect.objectContaining({ name: "submit_verification" })]
    });
    expect(JSON.stringify(gateway.requests[0]!.tools)).not.toContain("evidenceIds");
    expect(gateway.requests[0]!.tools[0]!.inputSchema).toMatchObject({
      properties: {
        criteria: {
          items: {
            required: ["criterionIndex", "status", "coverage"],
            properties: {
              coverage: {
                required: [
                  "scope",
                  "rationale",
                  "checkedClaims",
                  "limitations",
                  "falsificationAttempt"
                ]
              }
            }
          }
        }
      }
    });
    expect(result).toMatchObject({
      status: "passed",
      data: {
        verdict: "approved",
        criteria: [{
          criterion,
          status: "satisfied",
          evidence: ["validation"]
        }]
      }
    });
    expect(result.data).not.toHaveProperty("failureKind");
    expect(result.data).not.toHaveProperty("failureCode");
  });

  it("binds authenticated review evidence without asking the model to copy opaque ids", async () => {
    const criterion = "Preserve compatibility with the documented format.";
    const gateway = new ReviewerGateway(undefined, JSON.stringify({
      verdict: "approved",
      findings: [],
      criteria: [{
        criterionIndex: 0,
        status: "satisfied",
        coverage: completeCoverage()
      }],
      requiredValidations: []
    }));
    const result = await new ModelReviewer(gateway).review({
      sessionId: "session",
      runId: "run",
      goal: "Change the parser.",
      acceptanceCriteria: [criterion],
      frontierRevision: 1,
      stateDigest: "a".repeat(64),
      reviewBasisDigest: "b".repeat(64),
      reviewMode: "completion",
      workspaceDeltas: [delta()],
      validations: [validation()]
    }, new AbortController().signal);

    expect(result).toMatchObject({
      status: "passed",
      data: {
        verdict: "approved",
        criteria: [{
          criterion,
          status: "satisfied",
          evidence: ["validation", "delta"]
        }],
        durableEvidenceIds: ["validation", "delta"]
      }
    });
  });

  it.each([
    {
      name: "declared partial coverage",
      coverage: {
        scope: "partial",
        rationale: "Only representative inputs were checked.",
        checkedClaims: ["Representative inputs produce the expected result."],
        limitations: ["Inputs outside the sample were not established."],
        falsificationAttempt: "Checked boundary values within the available sample."
      }
    },
    {
      name: "declared complete coverage with a remaining limitation",
      coverage: {
        scope: "complete",
        rationale: "The main path was checked.",
        checkedClaims: ["The main path produces the expected result."],
        limitations: ["Alternate inputs were not established."],
        falsificationAttempt: "Tried one alternate input."
      }
    }
  ])("keeps Strict verification from promoting $name", async ({ coverage }) => {
    const criterion = "Preserve behavior for all supported inputs.";
    const gateway = new ReviewerGateway(undefined, JSON.stringify({
      verdict: "approved",
      findings: [],
      criteria: [{
        criterionIndex: 0,
        status: "satisfied",
        coverage
      }],
      requiredValidations: []
    }));

    const result = await new ModelReviewer(gateway).review({
      sessionId: "session",
      runId: "run",
      goal: "Change the implementation.",
      acceptanceCriteria: [criterion],
      frontierRevision: 1,
      stateDigest: "a".repeat(64),
      reviewBasisDigest: "b".repeat(64),
      reviewMode: "completion",
      verificationPolicy: "strict",
      workspaceDeltas: [delta()],
      validations: [validation()]
    }, new AbortController().signal);

    expect(result).toMatchObject({
      status: "failed",
      data: {
        verdict: "changes_requested",
        criteria: [{
          criterion,
          status: "unverified",
          coverage: expect.objectContaining({ scope: "partial" })
        }]
      }
    });
    expect(result.data).not.toHaveProperty("failureCode");
  });

  it("keeps Standard approval structurally consistent with declared limitations", async () => {
    const criterion = "Preserve behavior for all supported inputs.";
    const coverage = {
      scope: "partial" as const,
      rationale:
        "Boundary checks plus the implementation invariant cover every material behavior.",
      checkedClaims: [
        "Representative and boundary inputs preserve the documented behavior."
      ],
      limitations: [
        "An inaccessible external reference was not compared byte-for-byte."
      ],
      falsificationAttempt:
        "Tried malformed and boundary inputs and inspected the shared invariant."
    };
    const gateway = new ReviewerGateway(undefined, JSON.stringify({
      verdict: "approved",
      findings: [],
      criteria: [{
        criterionIndex: 0,
        status: "satisfied",
        coverage
      }],
      requiredValidations: []
    }));

    const result = await new ModelReviewer(gateway).review({
      sessionId: "session",
      runId: "run",
      goal: "Change the implementation.",
      acceptanceCriteria: [criterion],
      frontierRevision: 1,
      stateDigest: "a".repeat(64),
      reviewBasisDigest: "b".repeat(64),
      reviewMode: "completion",
      verificationPolicy: "standard",
      workspaceDeltas: [delta()],
      validations: [validation()]
    }, new AbortController().signal);

    expect(result).toMatchObject({
      status: "failed",
      data: {
        verdict: "changes_requested",
        criteria: [{
          criterion,
          status: "unverified",
          coverage: expect.objectContaining({
            scope: "partial",
            limitations: coverage.limitations
          })
        }]
      }
    });
  });

  it("conservatively requests repair when coverage is omitted for the durable user goal", async () => {
    const gateway = new ReviewerGateway(undefined, JSON.stringify({
      verdict: "approved",
      findings: [],
      criteria: [{ criterionIndex: 0, status: "satisfied" }],
      requiredValidations: []
    }));

    const result = await new ModelReviewer(gateway).review({
      sessionId: "session",
      runId: "run",
      goal: "Complete the durable user request.",
      frontierRevision: 1,
      stateDigest: "a".repeat(64),
      reviewBasisDigest: "b".repeat(64),
      reviewMode: "completion",
      workspaceDeltas: [delta()],
      validations: [validation()]
    }, new AbortController().signal);

    expect(result).toMatchObject({
      status: "failed",
      data: {
        verdict: "changes_requested",
        criteria: [{
          criterion: "Complete the durable user request.",
          status: "unverified",
          coverage: expect.objectContaining({ scope: "unavailable" })
        }]
      }
    });
    expect(result.data).not.toHaveProperty("failureCode");
  });

  it("accepts an exact fenced JSON verdict when a provider omits the final tool call", async () => {
    const criterion = "Preserve compatibility with the documented format.";
    const gateway = new ReviewerGateway(undefined, `\`\`\`json
${JSON.stringify({
  verdict: "approved",
  findings: [],
  criteria: [{
    criterionIndex: 0,
    status: "satisfied",
    coverage: completeCoverage()
  }],
  requiredValidations: []
})}
\`\`\``);

    const result = await new ModelReviewer(gateway).review({
      sessionId: "session",
      runId: "run",
      goal: "Change the parser.",
      acceptanceCriteria: [criterion],
      frontierRevision: 1,
      stateDigest: "a".repeat(64),
      reviewBasisDigest: "b".repeat(64),
      reviewMode: "completion",
      workspaceDeltas: [delta()],
      validations: [validation()]
    }, new AbortController().signal);

    expect(result).toMatchObject({
      status: "passed",
      data: {
        verdict: "approved",
        criteria: [{
          criterion,
          status: "satisfied"
        }]
      }
    });
    expect(result.data).not.toHaveProperty("failureCode");
  });

  it("drops unknown legacy evidence references but still fails closed without authentic proof", () => {
    const target = runtimeSession();
    const raw = (evidence: string[]): ReviewEvidence => ({
      evidenceId: "raw-review",
      sessionId: "session",
      runId: "run",
      kind: "review",
      status: "passed",
      createdAt: now,
      producer: { authority: "runtime", id: "reviewer" },
      summary: "approved",
      data: {
        schemaVersion: 3,
        reviewerId: "reviewer",
        verdict: "approved",
        findings: [],
        criteria: [{
          criterion: "Review the change",
          status: "satisfied",
          evidence
        }],
        requiredValidations: [],
        frontierRevision: 1,
        stateDigest: "a".repeat(64),
        reviewBasisDigest: "b".repeat(64),
        durableEvidenceIds: evidence
      }
    });

    const redundant = normalizeReview(
      target,
      raw(["validation", "review-check:mistyped"]),
      "b".repeat(64)
    );
    expect(redundant).toMatchObject({
      status: "passed",
      data: {
        verdict: "approved",
        criteria: [{
          status: "satisfied",
          evidence: ["validation"]
        }],
        durableEvidenceIds: ["validation"],
        evidenceReferenceResolution: { accepted: 1, dropped: 1 }
      }
    });

    const unsupported = normalizeReview(
      target,
      raw(["review-check:mistyped"]),
      "b".repeat(64)
    );
    expect(unsupported).toMatchObject({
      status: "failed",
      data: {
        verdict: "blocked",
        failureKind: "protocol",
        failureCode: "review_protocol_invalid",
        evidenceReferenceResolution: { accepted: 0, dropped: 1 }
      }
    });
  });

  it("reserves the final active-review turn for a verdict after bounded inspection", async () => {
    const gateway = new InspectThenSubmitGateway();
    const criterion = "Preserve compatibility with the documented format.";
    const result = await new ModelReviewer(
      gateway,
      "bounded-active-reviewer",
      inspectionEnvironment(),
      { maxTurns: 4, maxToolCalls: 12 }
    ).review({
      sessionId: "session",
      runId: "run",
      goal: "Change the parser.",
      acceptanceCriteria: [criterion],
      frontierRevision: 1,
      stateDigest: "a".repeat(64),
      reviewBasisDigest: "b".repeat(64),
      reviewMode: "completion",
      workspaceDeltas: [delta()],
      validations: [validation()]
    }, new AbortController().signal);

    expect(gateway.requests).toHaveLength(4);
    expect(gateway.requests.slice(0, 3).every((request) =>
      request.toolChoice === "auto"
      && request.tools.some((tool) => tool.name === "read"))).toBe(true);
    expect(gateway.requests[3]).toMatchObject({
      toolChoice: "required",
      tools: [expect.objectContaining({ name: "submit_verification" })]
    });
    expect(gateway.requests[3]!.tools).toHaveLength(1);
    expect(gateway.requests[3]!.messages.at(-1)).toMatchObject({
      role: "developer",
      content: expect.stringContaining("[verification_verdict_required]")
    });
    expect(result).toMatchObject({
      status: "passed",
      data: {
        verdict: "approved",
        criteria: [{
          criterion,
          status: "satisfied",
          evidence: ["review-check:inspect-3"]
        }]
      }
    });
    expect(result.data.actualChecks).toHaveLength(3);
    expect(result.data).not.toHaveProperty("failureCode");
  });

  it.each(["mixed", "malformed"] as const)(
    "recovers an early %s verdict proposal in the reserved verdict-only turn",
    async (failure) => {
      const gateway = new RecoverableVerdictProtocolGateway(failure);
      const criterion = "Preserve compatibility with the documented format.";
      const result = await new ModelReviewer(
        gateway,
        "protocol-recovery-reviewer",
        inspectionEnvironment(),
        { maxTurns: 4, maxToolCalls: 12 }
      ).review({
        sessionId: "session",
        runId: "run",
        goal: "Change the parser.",
        acceptanceCriteria: [criterion],
        frontierRevision: 1,
        stateDigest: "a".repeat(64),
        reviewBasisDigest: "b".repeat(64),
        reviewMode: "completion",
        workspaceDeltas: [delta()],
        validations: [validation()]
      }, new AbortController().signal);

      expect(gateway.requests).toHaveLength(3);
      expect(gateway.requests[2]).toMatchObject({
        toolChoice: "required",
        tools: [expect.objectContaining({ name: "submit_verification" })]
      });
      expect(gateway.requests[2]!.tools).toHaveLength(1);
      expect(result).toMatchObject({
        status: "passed",
        data: {
          verdict: "approved",
          criteria: [{
            criterion,
            status: "satisfied",
            evidence: ["review-check:inspect-before-verdict"]
          }],
          actualChecks: [{
            toolName: "read",
            evidenceIds: ["review-check:inspect-before-verdict"]
          }]
        }
      });
      expect(result.data.actualChecks).toHaveLength(1);
      expect(result.data).not.toHaveProperty("failureCode");
    }
  );

  it("withholds the active-review verdict tool until one inspection is authenticated", async () => {
    const gateway = new InspectOnceThenSubmitGateway();
    const criterion = "Preserve compatibility with the documented format.";
    const result = await new ModelReviewer(
      gateway,
      "inspection-required-reviewer",
      inspectionEnvironment(),
      { maxTurns: 2, maxToolCalls: 12 }
    ).review({
      sessionId: "session",
      runId: "run",
      goal: "Change the parser.",
      acceptanceCriteria: [criterion],
      frontierRevision: 1,
      stateDigest: "a".repeat(64),
      reviewBasisDigest: "b".repeat(64),
      reviewMode: "completion",
      verificationPolicy: "standard",
      workspaceDeltas: [delta()],
      validations: [validation()]
    }, new AbortController().signal);

    expect(gateway.requests).toHaveLength(2);
    expect(gateway.requests[0]!.tools.map((tool) => tool.name)).toEqual([
      "read"
    ]);
    expect(gateway.requests[0]!.toolChoice).toBe("auto");
    expect(gateway.requests[1]).toMatchObject({
      toolChoice: "required",
      tools: [expect.objectContaining({ name: "submit_verification" })]
    });
    expect(gateway.requests[1]!.tools).toHaveLength(1);
    expect(result).toMatchObject({
      status: "passed",
      data: {
        verdict: "approved",
        actualChecks: [{
          toolName: "read",
          evidenceIds: ["review-check:inspect-current-frontier"]
        }]
      }
    });
  });

  it("does not treat an early natural-language review summary as the final verdict", async () => {
    const gateway = new InspectThenSubmitGateway(3);
    const criterion = "Preserve compatibility with the documented format.";
    const result = await new ModelReviewer(
      gateway,
      "bounded-active-reviewer",
      inspectionEnvironment(),
      { maxTurns: 4, maxToolCalls: 12 }
    ).review({
      sessionId: "session",
      runId: "run",
      goal: "Change the parser.",
      acceptanceCriteria: [criterion],
      frontierRevision: 1,
      stateDigest: "a".repeat(64),
      reviewBasisDigest: "b".repeat(64),
      reviewMode: "completion",
      workspaceDeltas: [delta()],
      validations: [validation()]
    }, new AbortController().signal);

    expect(gateway.requests).toHaveLength(4);
    expect(gateway.requests[2]).toMatchObject({ toolChoice: "auto" });
    expect(gateway.requests[3]).toMatchObject({
      toolChoice: "required",
      tools: [expect.objectContaining({ name: "submit_verification" })]
    });
    expect(gateway.requests[3]!.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: "assistant",
        content: expect.stringContaining("ready to submit")
      })
    ]));
    expect(result).toMatchObject({
      status: "passed",
      data: {
        verdict: "approved",
        criteria: [{
          criterion,
          status: "satisfied",
          evidence: ["review-check:inspect-2"]
        }]
      }
    });
    expect(result.data.actualChecks).toHaveLength(2);
    expect(result.data).not.toHaveProperty("failureCode");
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
      data: { verdict: "blocked", failureKind: "infrastructure" }
    });
  });

  it("reserves every fallback attempt before invocation and commits the attempts actually used", async () => {
    const target = runtimeSession(limits({
      inputTokens: 2_000,
      outputTokens: 2_000,
      costMicroUsd: 2_000
    }));
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

  it("runs one reviewer attempt per model request and leaves infrastructure retries to the model", async () => {
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
    expect(calls).toBe(1);
    await new ReviewCoordinator(reviewer, emit).maybeReview(target, new AbortController().signal, true);
    await new ReviewCoordinator(reviewer, emit).maybeReview(target, new AbortController().signal, true);
    await new ReviewCoordinator(reviewer, emit).maybeReview(target, new AbortController().signal, true);

    // V9 allows at most the initial review and one re-review for the run.
    expect(calls).toBe(2);
  });

  it("refreshes a rejected review only for substantively new validation evidence", async () => {
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

  it("fails closed for decorated JSON and conservatively repairs incomplete review material", async () => {
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
    expect(decorated).toMatchObject({
      status: "failed",
      data: {
        verdict: "blocked",
        failureCode: "review_protocol_invalid"
      }
    });
    expect(decorated.data).not.toHaveProperty("failureKind");
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
    expect(contradictory.data).not.toHaveProperty("failureCode");

    const truncatedDelta = delta();
    truncatedDelta.data.reviewDiff += "\n[review diff truncated]";
    const truncatedGateway = new ReviewerGateway();
    const truncated = await new ModelReviewer(truncatedGateway).review({
      ...input, workspaceDeltas: [truncatedDelta]
    }, new AbortController().signal);
    expect(truncated).toMatchObject({
      status: "passed",
      data: { schemaVersion: 3, verdict: "approved" }
    });
    expect(truncatedGateway.calls).toBe(1);

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
      status: "passed",
      data: { schemaVersion: 3, verdict: "approved" }
    });
    expect(unvalidatedGateway.calls).toBe(1);
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

  it("lets the active reviewer page content-omitted and oversized change material", async () => {
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
      status: "passed",
      data: { schemaVersion: 3, verdict: "approved" }
    });
    expect(blockedGateway.calls).toBe(1);
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
  ])("does not let preflight semantics preempt the active reviewer for %s", async (
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

    expect(result).toMatchObject({
      status: "passed",
      data: { schemaVersion: 3, verdict: "approved" }
    });
    expect(gateway.calls).toBe(1);
  });

  it("leaves incomplete opaque identity semantics to the active reviewer", async () => {
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

    expect(result).toMatchObject({ status: "passed", data: { verdict: "approved" } });
    expect(gateway.calls).toBe(1);
  });

  it("does not let a failed validation automatically override the reviewer", async () => {
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

    expect(result).toMatchObject({ status: "passed", data: { verdict: "approved" } });
    expect(gateway.calls).toBe(1);
  });

  it("does not require a runtime-classified validation before active review", async () => {
    const item = delta();
    item.data.reviewDiffPaths = ["src/code.ts"];
    const gateway = new ReviewerGateway();

    const result = await new ModelReviewer(gateway).review({
      sessionId: "session", runId: "run", goal: "Review safely",
      frontierRevision: 1, stateDigest: "a".repeat(64),
      workspaceDeltas: [item], validations: []
    }, new AbortController().signal);

    expect(result).toMatchObject({
      status: "passed",
      data: { schemaVersion: 3, verdict: "approved" }
    });
    expect(gateway.calls).toBe(1);
  });
});
