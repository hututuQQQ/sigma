import { describe, expect, it } from "vitest";
import { approximateTokens } from "../packages/agent-context/src/index.js";
import type { ContextItem, ToolDescriptor } from "../packages/agent-protocol/src/index.js";
import { evidenceLedger } from "../packages/agent-runtime/src/model-evidence-ledger.js";
import { planLedger } from "../packages/agent-runtime/src/model-plan-ledger.js";
import { prepareBudgetedModelTurn } from "../packages/agent-runtime/src/model-budget-convergence.js";
import {
  MAX_RUNTIME_PROMPT_FRAME_TOKENS,
  materializeRuntimePromptFrame
} from "../packages/agent-runtime/src/runtime-prompt-state.js";
import { runtimeSessionFixture } from "./testkit/runtime-session-fixture.js";

const available = {
  inputTokens: 1_000_000,
  outputTokens: 100_000,
  costMicroUsd: 10_000_000,
  modelTurns: 100,
  toolCalls: 1_000,
  children: 10
};

function item(id: string, provenance: string, content: string, priority = 1): ContextItem {
  return {
    id,
    authority: "runtime",
    provenance,
    content,
    tokenCount: approximateTokens(content),
    priority
  };
}

describe("incremental runtime prompt state", () => {
  it("bounds a ten-thousand-path frontier and pages the full set outside the prompt", () => {
    const session = runtimeSessionFixture();
    session.durable.state.mutationFrontier = {
      revision: 4,
      baselineManifestDigest: "a".repeat(64),
      currentStateDigest: "b".repeat(64),
      changedPaths: Array.from({ length: 10_000 }, (_, index) =>
        `generated/package-${String(index).padStart(5, "0")}/index.ts`),
      sourceCheckpointIds: []
    };
    const ledger = evidenceLedger(session);
    expect(ledger.tokenCount).toBeLessThanOrEqual(2_048);
    expect(ledger.content).toContain("net changed paths: 10000");
    expect(ledger.content).toContain("representative changed paths (up to 32)");
    expect(ledger.content).not.toContain("package-09999");
  });

  it("emits full state once, then only changed sections, and restates after compaction", () => {
    const session = runtimeSessionFixture();
    const repository = item("repo", "repository", "repo state");
    const first = materializeRuntimePromptFrame(session, available, {
      repository: [repository],
      completion: evidenceLedger(session),
      plan: planLedger(session),
      turnOnly: [item("large", "test", "x".repeat(100_000))]
    });
    expect(first.frameMode).toBe("full");
    expect(first.items.reduce((total, value) => total + value.tokenCount, 0))
      .toBeLessThanOrEqual(MAX_RUNTIME_PROMPT_FRAME_TOKENS - 64);
    expect(first.items.filter((value) => value.id.startsWith("runtime:state:"))).toHaveLength(5);

    session.durable.state.promptState = first.promptState;
    const unchanged = materializeRuntimePromptFrame(session, available, {
      repository: [repository],
      completion: evidenceLedger(session),
      plan: planLedger(session)
    });
    expect(unchanged).toMatchObject({ frameMode: "delta", items: [] });

    session.durable.state.mutationFrontier = {
      ...session.durable.state.mutationFrontier,
      revision: 1,
      currentStateDigest: "c".repeat(64),
      changedPaths: ["src/changed.ts"]
    };
    const changed = materializeRuntimePromptFrame(session, available, {
      repository: [repository],
      completion: evidenceLedger(session),
      plan: planLedger(session)
    });
    expect(changed.items.map((value) => value.provenance)).toEqual([
      "runtime_state:completion"
    ]);

    session.durable.state.contextArchive = {
      schemaVersion: 1,
      item: {
        ...item("archive", "archive", "summary"),
        authority: "runtime",
        cacheKey: "d".repeat(64)
      },
      omittedHistoryTurns: 1,
      sourceDigest: "d".repeat(64)
    };
    session.durable.state.promptState = changed.promptState;
    const afterCompaction = materializeRuntimePromptFrame(session, available, {
      repository: [repository],
      completion: evidenceLedger(session),
      plan: planLedger(session)
    });
    expect(afterCompaction.frameMode).toBe("full");
    expect(afterCompaction.items.filter((value) => value.id.startsWith("runtime:state:")))
      .toHaveLength(5);
  });

  it("produces byte-identical model messages for different implicit deadlines", async () => {
    const first = runtimeSessionFixture();
    const second = runtimeSessionFixture();
    first.durable.state.deadlineAt = "2026-01-01T00:00:01.000Z";
    second.durable.state.deadlineAt = "2036-01-01T00:00:00.000Z";
    const prepare = async (session: typeof first) => await prepareBudgetedModelTurn({
      session,
      turnId: 1,
      descriptors: [],
      capabilities: { skillsAvailable: false },
      dynamic: [item("repo", "repository", "same repository")],
      hookContext: [],
      ledger: evidenceLedger(session),
      available,
      defaultOutputReserveTokens: 2_048
    });
    const [left, right] = await Promise.all([prepare(first), prepare(second)]);
    expect(JSON.stringify(left.turn.messages)).toBe(JSON.stringify(right.turn.messages));
    expect(JSON.stringify(left.turn.messages)).not.toMatch(/timeMs|remainingMs|deadlineAt/u);
  });

  it("retries a discarded length response once with 32K headroom and automatic tools", async () => {
    const session = runtimeSessionFixture();
    session.services.gateway.capabilities.contextWindowTokens = 128_000;
    session.services.gateway.capabilities.maxOutputTokens = 64_000;
    session.durable.state.lengthRecovery = {
      schemaVersion: 1,
      mode: "retry_with_headroom",
      attempts: 1
    };
    const descriptor: ToolDescriptor = {
      name: "read",
      description: "read",
      inputSchema: { type: "object", properties: {} },
      possibleEffects: ["filesystem.read"],
      executionMode: "sequential",
      resourceKeys: [],
      approval: "auto",
      idempotent: true,
      timeoutMs: 1_000
    };
    const prepared = await prepareBudgetedModelTurn({
      session,
      turnId: 2,
      descriptors: [descriptor],
      capabilities: { skillsAvailable: false },
      dynamic: [item("repo", "repository", "same repository")],
      hookContext: [],
      ledger: evidenceLedger(session),
      available,
      defaultOutputReserveTokens: 8_192
    });

    expect(prepared.turn).toMatchObject({
      toolChoice: "auto",
      outputReserveTokens: 32_000
    });
    expect(prepared.turn.tools).toEqual([expect.objectContaining({ name: "read" })]);
    expect(prepared.turn.messages.some((message) =>
      message.content.includes("was discarded before any tool call could run"))).toBe(true);
  });

  it("uses a 2K no-tool fallback when strict tool choice is unavailable", async () => {
    const session = runtimeSessionFixture();
    session.durable.state.lengthRecovery = {
      schemaVersion: 1,
      mode: "action_required",
      attempts: 1
    };
    const descriptor: ToolDescriptor = {
      name: "read",
      description: "read",
      inputSchema: { type: "object", properties: {} },
      possibleEffects: ["filesystem.read"],
      executionMode: "sequential",
      resourceKeys: [],
      approval: "auto",
      idempotent: true,
      timeoutMs: 1_000
    };
    const prepared = await prepareBudgetedModelTurn({
      session,
      turnId: 2,
      descriptors: [descriptor],
      capabilities: { skillsAvailable: false },
      dynamic: [item("repo", "repository", "same repository")],
      hookContext: [],
      ledger: evidenceLedger(session),
      available,
      defaultOutputReserveTokens: 8_192
    });
    expect(prepared.turn).toMatchObject({
      toolChoice: "none",
      tools: [],
      outputReserveTokens: 2_048
    });
    expect(prepared.turn.messages.some((message) =>
      message.content.includes("smallest complete user-facing answer"))).toBe(true);
  });

  it("uses the last tool-capable turn for closure and makes the final model turn text-only", async () => {
    const session = runtimeSessionFixture();
    const descriptor: ToolDescriptor = {
      name: "read",
      description: "read",
      inputSchema: { type: "object", properties: {} },
      possibleEffects: ["filesystem.read"],
      executionMode: "sequential",
      resourceKeys: [],
      approval: "auto",
      idempotent: true,
      timeoutMs: 1_000
    };
    const prepare = async (modelTurns: number) => await prepareBudgetedModelTurn({
      session,
      turnId: 2,
      descriptors: [descriptor],
      capabilities: { skillsAvailable: false },
      dynamic: [item("repo", "repository", "same repository")],
      hookContext: [],
      ledger: evidenceLedger(session),
      available: { ...available, modelTurns },
      defaultOutputReserveTokens: 8_192
    });

    const toolClosure = await prepare(2);
    expect(toolClosure.turn.boundaryStage).toBe("tool_closure");
    expect(toolClosure.turn.tools).toEqual([
      expect.objectContaining({ name: "read" })
    ]);
    expect(toolClosure.turn.toolChoice).toBeUndefined();
    expect(toolClosure.turn.messages.some((message) =>
      message.content.includes("final tool-capable model turn"))).toBe(true);

    const final = await prepare(1);
    expect(final.turn).toMatchObject({
      boundaryStage: "final",
      toolChoice: "none",
      tools: []
    });
    expect(final.turn.messages.some((message) =>
      message.content.includes("final model turn allowed"))).toBe(true);
    expect(final.turn.messages.some((message) =>
      message.content.includes("Do not claim unfinished work is complete"))).toBe(true);
    expect(final.turn.messages.some((message) =>
      message.content.includes("do not emit or simulate tool calls"))).toBe(true);
  });

  it("uses remaining repair tools before one bounded no-tool synthesis turn", async () => {
    const session = runtimeSessionFixture();
    session.durable.state.mutationFrontier = {
      revision: 1,
      baselineManifestDigest: "0".repeat(64),
      currentStateDigest: "a".repeat(64),
      changedPaths: ["src/change.ts"],
      sourceCheckpointIds: ["checkpoint"]
    };
    session.durable.state.evidence.push({
      evidenceId: "review-failed",
      sessionId: session.identity.sessionId,
      runId: session.durable.runId,
      kind: "review",
      status: "failed",
      createdAt: "2026-07-25T00:00:00.000Z",
      producer: { authority: "runtime", id: "reviewer" },
      summary: "Repair required.",
      data: {
        schemaVersion: 1,
        reviewerId: "reviewer",
        verdict: "changes_requested",
        findings: [{
          actionable: true,
          severity: "error",
          summary: "Fix the observed defect."
        }],
        criteria: [{
          criterion: "The change is correct.",
          status: "failed",
          evidence: []
        }],
        requiredValidations: [],
        frontierRevision: 1,
        stateDigest: "a".repeat(64),
        reviewBasisDigest: "b".repeat(64),
        validationEvidenceIds: [],
        durableEvidenceIds: [],
        actualChecks: []
      }
    });
    session.durable.state.longHorizon.assurance.protectedRepairTurnsRemaining = 0;
    session.durable.state.longHorizon.assurance.protectedToolCallsRemaining = 1;
    const descriptor: ToolDescriptor = {
      name: "read",
      description: "read",
      inputSchema: { type: "object", properties: {} },
      possibleEffects: ["filesystem.read"],
      executionMode: "sequential",
      resourceKeys: [],
      approval: "auto",
      idempotent: true,
      timeoutMs: 1_000
    };

    const actionable = await prepareBudgetedModelTurn({
      session,
      turnId: 3,
      descriptors: [descriptor],
      capabilities: { skillsAvailable: false },
      dynamic: [item("repo", "repository", "same repository")],
      hookContext: [],
      ledger: evidenceLedger(session),
      available,
      defaultOutputReserveTokens: 8_192
    });

    expect(actionable.turn.tools).toEqual([
      expect.objectContaining({ name: "read" })
    ]);
    expect(actionable.turn.toolChoice).toBeUndefined();
    expect(actionable.turn.outputReserveTokens).toBe(4_096);
    expect(actionable.turn.messages.some((message) =>
      message.content.includes("Only hard-budget exhaustion removes tools"))).toBe(true);

    session.durable.state.longHorizon.assurance.protectedToolCallsRemaining = 0;
    const ordinaryCapacity = await prepareBudgetedModelTurn({
      session,
      turnId: 4,
      descriptors: [descriptor],
      capabilities: { skillsAvailable: false },
      dynamic: [item("repo", "repository", "same repository")],
      hookContext: [],
      ledger: evidenceLedger(session),
      available,
      defaultOutputReserveTokens: 8_192
    });

    expect(ordinaryCapacity.turn.tools).toEqual([
      expect.objectContaining({ name: "read" })
    ]);
    expect(ordinaryCapacity.turn.toolChoice).toBeUndefined();
    expect(ordinaryCapacity.turn.messages.some((message) =>
      message.content.includes("Only hard-budget exhaustion removes tools"))).toBe(true);

    session.durable.state.budget.consumed.toolCalls =
      session.durable.state.budget.limits.toolCalls;
    const closure = await prepareBudgetedModelTurn({
      session,
      turnId: 5,
      descriptors: [descriptor],
      capabilities: { skillsAvailable: false },
      dynamic: [item("repo", "repository", "same repository")],
      hookContext: [],
      ledger: evidenceLedger(session),
      available,
      defaultOutputReserveTokens: 8_192
    });

    expect(closure.turn).toMatchObject({
      toolChoice: "none",
      tools: [],
      outputReserveTokens: 2_048
    });
    expect(closure.turn.messages.some((message) =>
      message.content.includes("No hard-ledger tool calls remain"))).toBe(true);
    expect(JSON.stringify(closure.turn.messages)).not.toMatch(/remainingMs|deadlineAt/u);
  });
});
