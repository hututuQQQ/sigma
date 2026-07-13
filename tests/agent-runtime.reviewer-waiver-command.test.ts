import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  AgentEventEnvelope,
  AgentEventType,
  ContextAuthority,
  JsonValue,
  ModelCapabilities,
  ModelGateway,
  ModelMessage,
  ModelRequest,
  ModelResponse,
  ModelStreamEvent,
  ModelToolDefinition,
  ReviewEvidence,
  ValidationEvidence,
  WorkspaceDeltaEvidence
} from "../packages/agent-protocol/src/index.js";
import { EVENT_SCHEMA_VERSION } from "../packages/agent-protocol/src/index.js";
import { createRuntime, restoreStoredSession } from "../packages/agent-runtime/src/testing.js";
import { SegmentedJsonlStore } from "../packages/agent-store/src/index.js";
import { EffectToolRegistry, registerBuiltinTools } from "../packages/agent-tools/src/index.js";
import { completeAgentEventPayload } from "./testkit/agent-event-fixtures.js";

const roots: string[] = [];
const occurredAt = "2026-07-11T00:00:00.000Z";

class UnusedGateway implements ModelGateway {
  readonly provider = "unused";
  readonly model = "unused";
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

  async complete(_request: ModelRequest): Promise<ModelResponse> {
    throw new Error("The reviewer waiver control-plane test must not call a model.");
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    const response = await this.complete(request);
    yield { type: "done", response };
  }

  async countTokens(_messages: ModelMessage[], _tools: ModelToolDefinition[] = []): Promise<number> {
    return 0;
  }
}

function event(
  seq: number,
  type: AgentEventType,
  payload: JsonValue,
  authority: Exclude<ContextAuthority, "external_verifier"> = "runtime"
): AgentEventEnvelope {
  return {
    schemaVersion: EVENT_SCHEMA_VERSION,
    seq,
    eventId: `event-${seq}`,
    sessionId: "session",
    runId: "run",
    occurredAt,
    type,
    authority,
    payload: completeAgentEventPayload(type, payload) as JsonValue
  };
}

function delta(id: string, checkpointId: string, file: string): WorkspaceDeltaEvidence {
  return {
    evidenceId: id,
    sessionId: "session",
    runId: "run",
    kind: "workspace_delta",
    status: "passed",
    createdAt: occurredAt,
    producer: { authority: "runtime", id: "checkpoint-manager" },
    summary: `Changed ${file}.`,
    data: {
      checkpointId,
      delta: { added: [], modified: [file], deleted: [] },
      reviewDiff: `[before]\nold\n[after]\nnew`
    }
  };
}

function validation(id: string, deltaId: string): ValidationEvidence {
  return {
    evidenceId: id,
    sessionId: "session",
    runId: "run",
    kind: "validation",
    status: "passed",
    createdAt: occurredAt,
    producer: { authority: "runtime", id: "test-validator" },
    summary: "Validation passed.",
    data: { validator: "test", workspaceDeltaEvidenceIds: [deltaId] }
  };
}

function review(deltaId: string): ReviewEvidence {
  return {
    evidenceId: "review-one",
    sessionId: "session",
    runId: "run",
    kind: "review",
    status: "passed",
    createdAt: occurredAt,
    producer: { authority: "runtime", id: "independent-reviewer" },
    summary: "First checkpoint approved.",
    data: {
      reviewerId: "independent-reviewer",
      verdict: "approved",
      findings: [],
      workspaceDeltaEvidenceIds: [deltaId]
    }
  };
}

function runtime(storeRootDir: string, store = new SegmentedJsonlStore({ rootDir: storeRootDir })) {
  return createRuntime({
    gateway: new UnusedGateway(),
    store,
    storeRootDir,
    tools: registerBuiltinTools(new EffectToolRegistry()),
    permissionMode: "auto",
    runDeadlineMs: 10_000
  });
}

async function pendingFixture(terminal = false): Promise<{
  root: string;
  storeRootDir: string;
  store: SegmentedJsonlStore;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "sigma-reviewer-waiver-"));
  roots.push(root);
  const storeRootDir = path.join(root, ".agent");
  const store = new SegmentedJsonlStore({ rootDir: storeRootDir });
  const first = delta("delta-one", "checkpoint-one", "src/one.ts");
  const second = delta("delta-two", "checkpoint-two", "src/two.ts");
  const events = [
    event(1, "session.created", { workspacePath: root, mode: "change" }),
    event(2, "plan.updated", {
      previousRevision: 0,
      plan: {
        revision: 1,
        goal: "Test reviewer waiver",
        activeNodeId: "root",
        nodes: [{
          id: "root",
          title: "Test reviewer waiver",
          dependencies: [],
          status: "in_progress",
          owner: { kind: "root" },
          acceptanceCriteria: ["The user decision is durable."],
          evidence: []
        }]
      }
    }),
    event(3, "run.started", { mode: "change" }),
    event(4, "user.message", { text: "Apply two changes." }, "user"),
    event(5, "evidence.recorded", first),
    event(6, "evidence.recorded", validation("validation-one", first.evidenceId)),
    event(7, "review.completed", review(first.evidenceId)),
    event(8, "evidence.recorded", second),
    event(9, "evidence.recorded", validation("validation-two", second.evidenceId)),
    terminal
      ? event(10, "run.failed", {
        kind: "recoverable_failure",
        code: "review_required",
        message: "Awaiting an explicit user follow-up."
      })
      : event(10, "run.suspended", {
        requestId: "review-required",
        message: "Independent review requires an explicit user decision."
      })
  ];
  for (const item of events) await store.append(item, item.seq - 1);
  return { root, storeRootDir, store };
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("reviewer waiver user control plane", () => {
  it("durably binds the default waiver to the latest pending checkpoint and cannot reuse it after restart", async () => {
    const fixture = await pendingFixture();
    const first = runtime(fixture.storeRootDir, fixture.store);
    await first.command({ type: "resume", sessionId: "session" });
    await first.command({
      type: "reviewer_waiver",
      sessionId: "session",
      reason: "The operator inspected and accepted this exact checkpoint."
    });

    const events: AgentEventEnvelope[] = [];
    for await (const item of fixture.store.events("session")) events.push(item);
    const waiver = events.findLast((item) => item.type === "review.waived");
    expect(waiver).toMatchObject({
      authority: "user",
      payload: {
        kind: "user_waiver",
        producer: { authority: "user", id: "session-command" },
        data: {
          scope: "review",
          checkpointId: "checkpoint-two",
          reason: "The operator inspected and accepted this exact checkpoint."
        }
      }
    });
    await first.releaseSession("session");
    const replayed = await restoreStoredSession(
      new SegmentedJsonlStore({ rootDir: fixture.storeRootDir }),
      "session",
      10_000
    );
    expect(replayed.state.evidence.filter((item) => item.kind === "user_waiver")).toHaveLength(1);

    const resumed = runtime(fixture.storeRootDir);
    await resumed.command({ type: "resume", sessionId: "session" });
    await expect(resumed.command({
      type: "reviewer_waiver",
      sessionId: "session",
      checkpointId: "checkpoint-two",
      reason: "Try to reuse the same waiver."
    })).rejects.toMatchObject({ code: "reviewer_waiver_already_used" });
    await resumed.releaseSession("session");
  });

  it("rejects non-pending targets, invalid states, and child-agent waiver injection", async () => {
    const fixture = await pendingFixture();
    const active = runtime(fixture.storeRootDir, fixture.store);
    await active.command({ type: "resume", sessionId: "session" });
    await expect(active.command({
      type: "reviewer_waiver",
      sessionId: "session",
      checkpointId: "checkpoint-one",
      reason: "Already reviewed."
    })).rejects.toMatchObject({ code: "reviewer_waiver_not_pending" });
    await active.releaseSession("session");

    const freshRoot = await mkdtemp(path.join(os.tmpdir(), "sigma-reviewer-waiver-fresh-"));
    roots.push(freshRoot);
    const fresh = runtime(path.join(freshRoot, ".agent"));
    const parent = await fresh.createSession({ workspacePath: freshRoot, mode: "change" });
    await expect(fresh.command({
      type: "reviewer_waiver",
      sessionId: parent.sessionId,
      reason: "No pending delta exists."
    })).rejects.toMatchObject({ code: "reviewer_waiver_invalid_state" });
    await expect(fresh.createChildSession(parent.sessionId, {
      workspacePath: freshRoot,
      mode: "change",
      reviewerWaiverReason: "A child attempted to forge user authority."
    }, undefined)).rejects.toMatchObject({ code: "reviewer_waiver_user_only" });
    await fresh.releaseSession(parent.sessionId);
  });

  it("persists the same one-shot decision while a terminal session awaits a follow-up", async () => {
    const fixture = await pendingFixture(true);
    const first = runtime(fixture.storeRootDir, fixture.store);
    await first.command({ type: "resume", sessionId: "session" });
    await first.waitForIdleOutcome("session");
    await first.command({
      type: "reviewer_waiver",
      sessionId: "session",
      checkpointId: "checkpoint-two",
      reason: "Allow the next user follow-up to proceed without another reviewer call."
    });
    await first.releaseSession("session");

    const replayed = await restoreStoredSession(
      new SegmentedJsonlStore({ rootDir: fixture.storeRootDir }),
      "session",
      10_000
    );
    expect(replayed.state.evidence.filter((item) => item.kind === "user_waiver")).toHaveLength(1);

    const resumed = runtime(fixture.storeRootDir);
    await resumed.command({ type: "resume", sessionId: "session" });
    await expect(resumed.command({
      type: "reviewer_waiver",
      sessionId: "session",
      reason: "A second waiver must not be accepted."
    })).rejects.toMatchObject({ code: "reviewer_waiver_already_used" });
    await resumed.releaseSession("session");
  });
});
