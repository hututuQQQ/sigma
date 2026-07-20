import { describe, expect, it } from "vitest";
import { evolve, type ActiveModelTurn } from "../packages/agent-kernel/src/index.js";
import {
  EVENT_SCHEMA_VERSION,
  type AgentEventEnvelope,
  type AgentEventType,
  type ContextAuthority,
  type JsonValue,
  type ReviewEvidence,
  type ToolReceipt,
  type ValidationEvidence,
  type WorkspaceDeltaEvidence
} from "../packages/agent-protocol/src/index.js";
import {
  EffectRunner,
  type EffectRunnerOptions
} from "../packages/agent-runtime/src/effect-runner.js";
import type { RuntimeSession } from "../packages/agent-runtime/src/types.js";
import { reviewBasisDigest } from "../packages/agent-runtime/src/mutation-evidence.js";
import {
  completionCandidateDigest,
  type CompletionReviewCandidateV1
} from "../packages/agent-runtime/src/reviewer.js";
import { COMPLETION_CANDIDATE_MAX_SERIALIZED_UTF8_BYTES } from "../packages/agent-runtime/src/completion-review-candidate.js";
import { runtimeSessionFixture } from "./testkit/runtime-session-fixture.js";

interface EffectRunnerInternals {
  reviews: {
    maybeReview(
      session: RuntimeSession,
      signal: AbortSignal,
      explicitlyRequested?: boolean,
      completionCandidate?: CompletionReviewCandidateV1
    ): Promise<void>;
  };
  transactions: {
    settleBudgetsAfterReceipt(session: RuntimeSession): Promise<void>;
  };
  emitReceipt(session: RuntimeSession, receipt: ToolReceipt, modelTurn: ActiveModelTurn): Promise<void>;
}

function attachReviewableDocumentationSubject(session: RuntimeSession): void {
  session.durable.state.mutationFrontier = {
    ...session.durable.state.mutationFrontier,
    revision: 1,
    currentStateDigest: "a".repeat(64),
    changedPaths: ["README.md"],
    sourceCheckpointIds: ["checkpoint"]
  };
  const delta: WorkspaceDeltaEvidence = {
    evidenceId: "delta", sessionId: session.identity.sessionId, runId: session.durable.runId,
    kind: "workspace_delta", status: "passed", createdAt: "2026-01-01T00:00:00.000Z",
    producer: { authority: "runtime", id: "checkpoint" }, summary: "updated documentation",
    data: {
      checkpointId: "checkpoint",
      delta: { added: [], modified: ["README.md"], deleted: [] },
      reviewDiff: "--- a/README.md\n+++ b/README.md\n-old\n+new",
      reviewDiffPaths: ["README.md"]
    }
  };
  session.durable.state.evidence.push(delta);
  session.durable.state.mutationEvidence.push(delta);
}

describe("runtime terminal review ordering", () => {
  it("durably finishes review before emitting a successful runtime_finalize receipt", async () => {
    const order: string[] = [];
    const options = {
      runtime: {},
      maxParallelTools: 1,
      permissionMode: "auto",
      emit: async (_session: RuntimeSession, type: string) => {
        order.push(type);
        return {};
      },
      finish: async () => true,
      createArtifact: async () => "artifact",
      control: {},
      budgets: {},
      reviewer: {},
      hooks: {
        dispatch: async (_session: RuntimeSession, hook: string) => {
          order.push(`hook:${hook}`);
        }
      }
    } as unknown as EffectRunnerOptions;
    const runner = new EffectRunner(options) as unknown as EffectRunnerInternals;
    runner.reviews = {
      maybeReview: async () => {
        order.push("review.completed");
      }
    };
    runner.transactions = {
      settleBudgetsAfterReceipt: async () => {
        order.push("budgets.settled");
      }
    };

    const session = runtimeSessionFixture();
    session.services.profile = {
      profile: { mutationPolicy: { reviewMode: "advisory" } }
    } as RuntimeSession["services"]["profile"];
    attachReviewableDocumentationSubject(session);
    const modelTurn = { turnId: 1, effectRevision: session.durable.state.revision };
    session.durable.state.pendingTools = [{
      request: {
        callId: "finalize",
        name: "runtime_finalize",
        arguments: { summary: "done" }
      },
      modelTurn,
      approval: "not_required",
      started: true,
      origin: "runtime"
    }];
    const receipt: ToolReceipt = {
      callId: "finalize",
      ok: true,
      output: JSON.stringify({ summary: "done" }),
      observedEffects: ["outcome.propose"],
      artifacts: [],
      diagnostics: [],
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:00:01.000Z"
    };

    await runner.emitReceipt(session, receipt, modelTurn);

    expect(order).toEqual([
      "review.completed",
      "tool.completed",
      "hook:post_tool",
      "budgets.settled"
    ]);
  });

  it.each([
    { label: "review is off", reviewMode: "off", subject: "changed", allowed: true },
    { label: "there is no review subject", reviewMode: "advisory", subject: "none", allowed: true },
    { label: "the advisory subject is waived", reviewMode: "advisory", subject: "waived", allowed: true },
    { label: "candidate review is eligible", reviewMode: "advisory", subject: "changed", allowed: false }
  ] as const)("applies the long-final envelope only when $label", async ({ reviewMode, subject, allowed }) => {
    let completedPayload: Record<string, unknown> | undefined;
    let failedPayload: Record<string, unknown> | undefined;
    let completedPlan: Record<string, unknown> | undefined;
    let reviewCalls = 0;
    const options = {
      runtime: {}, maxParallelTools: 1, permissionMode: "auto",
      emit: async (_session: RuntimeSession, type: string, _authority: string, payload: unknown) => {
        if (type === "tool.completed") completedPayload = payload as Record<string, unknown>;
        if (type === "tool.failed") failedPayload = payload as Record<string, unknown>;
        if (type === "plan.updated") completedPlan = payload as Record<string, unknown>;
        return {};
      },
      finish: async () => true, createArtifact: async () => "artifact", control: {}, budgets: {}, reviewer: {},
      hooks: { dispatch: async () => {} }
    } as unknown as EffectRunnerOptions;
    const runner = new EffectRunner(options) as unknown as EffectRunnerInternals;
    runner.reviews = { maybeReview: async () => { reviewCalls += 1; } };
    runner.transactions = { settleBudgetsAfterReceipt: async () => {} };
    const session = runtimeSessionFixture();
    session.services.profile = {
      profile: { mutationPolicy: { reviewMode } }
    } as RuntimeSession["services"]["profile"];
    session.durable.state.plan = {
      revision: 1,
      goal: "Deliver the result.",
      activeNodeId: "root",
      nodes: [{
        id: "root", title: "Deliver", dependencies: [], status: "in_progress",
        owner: { kind: "root" }, acceptanceCriteria: ["Delivered"], evidence: []
      }]
    };
    if (subject !== "none") {
      session.durable.state.mutationFrontier = {
        ...session.durable.state.mutationFrontier,
        revision: 1,
        currentStateDigest: "a".repeat(64),
        changedPaths: ["README.md"],
        sourceCheckpointIds: ["checkpoint"]
      };
      const delta: WorkspaceDeltaEvidence = {
        evidenceId: "delta", sessionId: session.identity.sessionId, runId: session.durable.runId,
        kind: "workspace_delta", status: "passed", createdAt: "2026-01-01T00:00:00.000Z",
        producer: { authority: "runtime", id: "checkpoint" }, summary: "updated documentation",
        data: {
          checkpointId: "checkpoint",
          delta: { added: [], modified: ["README.md"], deleted: [] },
          reviewDiff: "--- a/README.md\n+++ b/README.md\n-old\n+new",
          reviewDiffPaths: ["README.md"]
        }
      };
      session.durable.state.evidence.push(delta);
      session.durable.state.mutationEvidence.push(delta);
      if (subject === "waived") {
        session.durable.state.evidence.push({
          evidenceId: "waiver", sessionId: session.identity.sessionId, runId: session.durable.runId,
          kind: "user_waiver", status: "informational", createdAt: "2026-01-01T00:00:00.000Z",
          producer: { authority: "user" }, summary: "review waived",
          data: { scope: "review", reason: "operator reviewed it", checkpointId: "checkpoint" }
        });
      }
    }
    const modelTurn = { turnId: 1, effectRevision: session.durable.state.revision };
    const summary = "x".repeat(COMPLETION_CANDIDATE_MAX_SERIALIZED_UTF8_BYTES);
    if (subject === "waived") {
      const digest = completionCandidateDigest({ message: summary, summary, warnings: [] });
      session.durable.state.evidence.push({
        evidenceId: "superseded-review", sessionId: session.identity.sessionId, runId: session.durable.runId,
        kind: "review", status: "failed", createdAt: "2026-01-01T00:00:00.000Z",
        producer: { authority: "runtime", id: "reviewer" }, summary: "changes requested before waiver",
        data: {
          reviewerId: "reviewer", verdict: "changes_requested", findings: [{
            actionable: true, severity: "error", summary: "Review before the user waiver."
          }],
          frontierRevision: 1, stateDigest: "a".repeat(64),
          reviewBasisDigest: reviewBasisDigest(session, [], digest), reviewBasisVersion: 3,
          completionCandidateDigest: digest, validationEvidenceIds: []
        }
      });
    }
    session.durable.state.pendingTools = [{
      request: { callId: "oversized-finalize", name: "runtime_finalize", arguments: { summary } },
      modelTurn, approval: "not_required", started: true, origin: "runtime"
    }];
    const receipt: ToolReceipt = {
      callId: "oversized-finalize", ok: true, output: JSON.stringify({ summary }),
      observedEffects: ["outcome.propose"], artifacts: [], diagnostics: [],
      startedAt: "2026-01-01T00:00:00.000Z", completedAt: "2026-01-01T00:00:01.000Z"
    };

    await runner.emitReceipt(session, receipt, modelTurn);

    expect(reviewCalls).toBe(0);
    if (allowed) {
      expect(completedPayload).toMatchObject({ ok: true, diagnostics: [] });
      expect(completedPlan).toMatchObject({
        plan: { activeNodeId: undefined, nodes: [{ id: "root", status: "completed" }] }
      });
    } else {
      expect(failedPayload).toMatchObject({
        ok: false,
        diagnostics: ["completion_candidate_too_large"],
        result: { status: "rejected", code: "completion_candidate_too_large" }
      });
      expect(completedPlan).toBeUndefined();
    }
  });

  it.each([
    { label: "changes_requested", verdict: "changes_requested", closesPlan: false },
    { label: "approved", verdict: "approved", closesPlan: true },
    {
      label: "an infrastructure failure", verdict: "changes_requested",
      failureKind: "infrastructure", closesPlan: false
    }
  ] as const)("keeps the root plan editable until candidate review is $label", async ({
    verdict, closesPlan, ...reviewCase
  }) => {
    const order: string[] = [];
    const session = runtimeSessionFixture();
    const options = {
      runtime: {},
      maxParallelTools: 1,
      permissionMode: "auto",
      emit: async (_session: RuntimeSession, type: string) => {
        order.push(type);
        return {};
      },
      finish: async () => true,
      createArtifact: async () => "artifact",
      control: {},
      budgets: {},
      reviewer: {},
      hooks: { dispatch: async (_session: RuntimeSession, hook: string) => { order.push(`hook:${hook}`); } }
    } as unknown as EffectRunnerOptions;
    const runner = new EffectRunner(options) as unknown as EffectRunnerInternals;
    runner.transactions = { settleBudgetsAfterReceipt: async () => {} };
    runner.reviews = {
      maybeReview: async (_target, _signal, _explicit, candidate) => {
        order.push("review.completed");
        const digest = completionCandidateDigest(candidate!);
        const review: ReviewEvidence = {
          evidenceId: `review-${verdict}`,
          sessionId: session.identity.sessionId,
          runId: session.durable.runId,
          kind: "review",
          status: verdict === "approved" ? "passed" : "failed",
          createdAt: "2026-01-01T00:00:00.000Z",
          producer: { authority: "runtime", id: "reviewer" },
          summary: reviewCase.label,
          data: {
            reviewerId: "reviewer",
            verdict,
            findings: verdict === "approved" || "failureKind" in reviewCase ? [] : [{
              actionable: true, severity: "error", summary: "Repair the implementation."
            }],
            ...("failureKind" in reviewCase ? { failureKind: reviewCase.failureKind } : {}),
            frontierRevision: session.durable.state.mutationFrontier.revision,
            stateDigest: session.durable.state.mutationFrontier.currentStateDigest,
            reviewBasisDigest: reviewBasisDigest(session, [], digest),
            reviewBasisVersion: 3,
            completionCandidateDigest: digest,
            validationEvidenceIds: []
          }
        };
        session.durable.state.evidence.push(review);
      }
    };

    session.services.profile = {
      profile: { mutationPolicy: { reviewMode: "advisory" } }
    } as RuntimeSession["services"]["profile"];
    session.durable.state.plan = {
      revision: 1,
      goal: "Change src/code.ts.",
      activeNodeId: "root",
      nodes: [{
        id: "root",
        title: "Change src/code.ts",
        dependencies: [],
        status: "in_progress",
        owner: { kind: "root" },
        acceptanceCriteria: ["The requested change is complete."],
        evidence: []
      }]
    };
    attachReviewableDocumentationSubject(session);
    const modelTurn = { turnId: 1, effectRevision: session.durable.state.revision };
    session.durable.state.pendingTools = [{
      request: { callId: "finalize", name: "runtime_finalize", arguments: { summary: "done" } },
      modelTurn,
      approval: "not_required",
      started: true,
      origin: "runtime"
    }];
    const receipt: ToolReceipt = {
      callId: "finalize",
      ok: true,
      output: JSON.stringify({ summary: "done" }),
      observedEffects: ["outcome.propose"],
      artifacts: [],
      diagnostics: [],
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:00:01.000Z"
    };

    await runner.emitReceipt(session, receipt, modelTurn);

    expect(order.includes("plan.updated")).toBe(closesPlan);
    if (closesPlan) {
      expect(order.indexOf("review.completed")).toBeLessThan(order.indexOf("plan.updated"));
      expect(order.indexOf("plan.updated")).toBeLessThan(order.indexOf("tool.completed"));
    } else {
      expect(session.durable.state.plan.nodes[0]?.status).toBe("in_progress");
    }
  });

  it("returns the post-review state from request_review", async () => {
    const order: string[] = [];
    let completedOutput = "";
    const options = {
      runtime: {},
      maxParallelTools: 1,
      permissionMode: "auto",
      emit: async (_session: RuntimeSession, type: string, _authority: string, payload: unknown) => {
        order.push(type);
        if (type === "tool.completed") completedOutput = (payload as { output: string }).output;
        return {};
      },
      finish: async () => true,
      createArtifact: async () => "artifact",
      control: {
        forSession: () => ({
          requestReview: async () => ({
            status: "approved",
            reviewState: "current",
            reviewBasisDigest: "b".repeat(64),
            frontierRevision: 1,
            stateDigest: "a".repeat(64),
            changedPaths: ["src/code.ts"],
            missingValidationPaths: []
          })
        })
      },
      budgets: {},
      reviewer: {},
      hooks: { dispatch: async () => {} }
    } as unknown as EffectRunnerOptions;
    const runner = new EffectRunner(options) as unknown as EffectRunnerInternals;
    runner.transactions = { settleBudgetsAfterReceipt: async () => {} };
    runner.reviews = { maybeReview: async () => { order.push("review.completed"); } };
    const session = runtimeSessionFixture();
    session.services.profile = {
      profile: { mutationPolicy: { reviewMode: "advisory" } }
    } as RuntimeSession["services"]["profile"];
    const modelTurn = { turnId: 1, effectRevision: session.durable.state.revision };
    session.durable.state.pendingTools = [{
      request: { callId: "review", name: "request_review", arguments: {} },
      modelTurn,
      approval: "not_required",
      started: true,
      origin: "model"
    }];
    const receipt: ToolReceipt = {
      callId: "review",
      // The control tool's pre-review snapshot may be pessimistic. The
      // receipt reviewer must still execute an explicit retry and replace it
      // with the post-review state.
      ok: false,
      output: JSON.stringify({ status: "changes_required" }),
      observedEffects: ["review.request"],
      artifacts: [], diagnostics: ["review_changes_required"],
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:00:01.000Z"
    };

    await runner.emitReceipt(session, receipt, modelTurn);

    expect(order.indexOf("review.completed")).toBeLessThan(order.indexOf("tool.completed"));
    expect(JSON.parse(completedOutput)).toMatchObject({ status: "approved", reviewState: "current" });
    const completed = order.filter((item) => item === "tool.completed");
    expect(completed).toHaveLength(1);
  });

  it("retries a candidate-bound infrastructure failure on the same completion candidate", async () => {
    const session = runtimeSessionFixture();
    session.durable.state.deadlineRemainingMs = 24 * 60 * 60 * 1_000;
    session.durable.state.plan = {
      revision: 1,
      goal: "Change src/code.ts.",
      activeNodeId: "root",
      nodes: [{
        id: "root",
        title: "Change src/code.ts",
        dependencies: [],
        status: "in_progress",
        owner: { kind: "root" },
        acceptanceCriteria: ["The requested change is complete."],
        evidence: []
      }]
    };
    session.durable.state.mutationFrontier = {
      ...session.durable.state.mutationFrontier,
      revision: 1,
      currentStateDigest: "a".repeat(64),
      changedPaths: ["src/code.ts"],
      sourceCheckpointIds: ["checkpoint"]
    };
    const delta: WorkspaceDeltaEvidence = {
      evidenceId: "delta",
      sessionId: session.identity.sessionId,
      runId: session.durable.runId,
      kind: "workspace_delta",
      status: "passed",
      createdAt: "2026-01-01T00:00:00.000Z",
      producer: { authority: "runtime", id: "checkpoint" },
      summary: "changed",
      data: {
        checkpointId: "checkpoint",
        delta: { added: [], modified: ["src/code.ts"], deleted: [] },
        reviewDiff: "--- a/src/code.ts\n+++ b/src/code.ts\n-old\n+new",
        reviewDiffPaths: ["src/code.ts"]
      }
    };
    const validation: ValidationEvidence = {
      evidenceId: "validation",
      sessionId: session.identity.sessionId,
      runId: session.durable.runId,
      kind: "validation",
      status: "passed",
      createdAt: "2026-01-01T00:00:00.000Z",
      producer: { authority: "tool", id: "validate" },
      summary: "passed",
      data: {
        validator: "command",
        exitCode: 0,
        artifactIds: [],
        frontierRevision: 1,
        stateDigest: "a".repeat(64),
        coveredPaths: ["src/code.ts"],
        claim: {
          kind: "typecheck",
          commandDigest: "c".repeat(64),
          strength: "structural",
          independence: "cross_method",
          assertionMode: "explicit",
          subject: { projectId: ".", configPaths: [], selectedTests: [], exactFiles: [] },
          status: "passed"
        }
      }
    };
    session.durable.state.evidence = [delta, validation];
    session.durable.state.mutationEvidence = [delta, validation];
    session.services.profile = {
      profile: { mutationPolicy: { reviewMode: "required" } }
    } as RuntimeSession["services"]["profile"];

    const completedReceipts: Array<{ type: AgentEventType; receipt: ToolReceipt }> = [];
    const emit = async (
      target: RuntimeSession,
      type: AgentEventType,
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
      target.durable.state = evolve(target.durable.state, event);
      if (type === "tool.completed" || type === "tool.failed") {
        completedReceipts.push({ type, receipt: payload as ToolReceipt });
      }
      return event;
    };
    let reviewCalls = 0;
    const options = {
      runtime: {},
      maxParallelTools: 1,
      permissionMode: "auto",
      emit,
      finish: async () => true,
      createArtifact: async () => "artifact",
      control: {},
      budgets: {},
      reviewer: {
        reviewerId: "transient-reviewer",
        review: async (input: {
          sessionId: string;
          runId: string;
          frontierRevision: number;
          stateDigest: string;
          validations: ValidationEvidence[];
        }): Promise<ReviewEvidence> => {
          reviewCalls += 1;
          if (reviewCalls === 1) throw new Error("temporary reviewer outage");
          return {
            evidenceId: "approved-after-retry",
            sessionId: input.sessionId,
            runId: input.runId,
            kind: "review",
            status: "passed",
            createdAt: "2026-01-01T00:00:00.000Z",
            producer: { authority: "runtime", id: "transient-reviewer" },
            summary: "approved",
            data: {
              reviewerId: "transient-reviewer",
              verdict: "approved",
              findings: [],
              frontierRevision: input.frontierRevision,
              stateDigest: input.stateDigest,
              validationEvidenceIds: input.validations.map((item) => item.evidenceId)
            }
          };
        }
      },
      hooks: { dispatch: async () => {} }
    } as unknown as EffectRunnerOptions;
    const runner = new EffectRunner(options) as unknown as EffectRunnerInternals;
    runner.transactions = { settleBudgetsAfterReceipt: async () => {} };
    const receipt = (callId: string): ToolReceipt => ({
      callId,
      ok: true,
      output: JSON.stringify({ summary: "done" }),
      observedEffects: ["outcome.propose"],
      artifacts: [],
      diagnostics: [],
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:00:01.000Z"
    });
    const finalize = async (callId: string, turnId: number): Promise<void> => {
      const modelTurn = { turnId, effectRevision: session.durable.state.revision };
      session.durable.state.pendingTools = [{
        request: { callId, name: "runtime_finalize", arguments: { summary: "done" } },
        modelTurn,
        approval: "not_required",
        started: true,
        origin: "runtime"
      }];
      await runner.emitReceipt(session, receipt(callId), modelTurn);
    };

    await finalize("finalize-1", 1);
    expect(reviewCalls).toBe(1);
    expect(completedReceipts.at(-1)?.type).toBe("tool.failed");
    expect(session.durable.state.plan.nodes[0]?.status).toBe("in_progress");

    await finalize("finalize-2", 2);

    expect(reviewCalls).toBe(2);
    expect(completedReceipts.at(-1)?.type).toBe("tool.completed");
    expect(session.durable.state.plan.nodes[0]?.status).toBe("completed");
    expect(session.durable.state.proposedOutcome).toMatchObject({ kind: "completed" });
  });
});
