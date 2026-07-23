import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type {
  ToolCallPlan,
  ToolDescriptor,
  ToolReceipt
} from "../packages/agent-protocol/src/index.js";
import {
  assertTransactionIsolationPlanAllowed
} from "../packages/agent-runtime/src/tool-plan-enforcement.js";
import {
  prepareBudgetedModelTurn
} from "../packages/agent-runtime/src/model-budget-convergence.js";
import { runtimeSessionFixture } from "./testkit/runtime-session-fixture.js";

function descriptor(name: string, effects: ToolDescriptor["possibleEffects"]): ToolDescriptor {
  return {
    name,
    description: name,
    inputSchema: { type: "object" },
    possibleEffects: effects,
    maximumEffects: effects,
    executionMode: "exclusive",
    resourceKeys: [],
    approval: "auto",
    idempotent: false,
    timeoutMs: 1_000
  };
}

function plan(readPaths: string[], writePaths: string[]): ToolCallPlan {
  return {
    exactEffects: writePaths.length > 0
      ? ["filesystem.read", "filesystem.write"]
      : ["filesystem.read"],
    readPaths,
    writePaths,
    network: "none",
    processMode: "none",
    checkpointScope: writePaths,
    idempotence: writePaths.length > 0 ? "non_replayable" : "read_only"
  };
}

function preparation(session = runtimeSessionFixture()) {
  const descriptors = [
    descriptor("read", ["filesystem.read"]),
    descriptor("shell", ["filesystem.read", "process.spawn.readonly"]),
    descriptor("edit", ["filesystem.read", "filesystem.write"]),
    descriptor("validate", ["filesystem.read", "process.spawn.readonly", "validation"]),
    descriptor("report_blocked", ["outcome.report_blocked"]),
    descriptor("request_user_input", ["outcome.request_input"])
  ];
  return {
    session,
    forecast: {
      stage: "normal" as const,
      remainingMs: 1,
      usableMs: 0,
      nextModelEstimateMs: 180_000,
      settlementReserveMs: 10_000
    },
    turnId: 1,
    descriptors,
    capabilities: { skillsAvailable: false, executableSkillResourcesLoaded: false },
    dynamic: [],
    hookContext: [],
    ledger: {
      id: "ledger",
      authority: "runtime" as const,
      provenance: "test ledger",
      content: "{}",
      tokenCount: 1,
      priority: 1
    },
    available: {
      inputTokens: 100_000,
      outputTokens: 100_000,
      costMicroUsd: 10_000_000,
      modelTurns: 10,
      toolCalls: 10,
      children: 10
    },
    defaultOutputReserveTokens: 4_096
  };
}

describe("model-owned recovery policy", () => {
  it("keeps every permitted development and terminal tool visible", async () => {
    const input = preparation();
    const prepared = await prepareBudgetedModelTurn(input);
    expect(prepared.turn.tools.map((tool) => tool.name)).toEqual(
      input.descriptors.map((tool) => tool.name).sort((left, right) => left.localeCompare(right))
    );
    expect(prepared.turn.toolChoice).toBeUndefined();
  });

  it("retains concrete broker conflict-path isolation without an obligation state", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-repository-transaction-"));
    await mkdir(path.join(workspace, "src"));
    await writeFile(path.join(workspace, "src", "conflict.ts"), "conflict\n", "utf8");
    await writeFile(path.join(workspace, "src", "other.ts"), "other\n", "utf8");
    const session = runtimeSessionFixture({ workspacePath: workspace });
    const receipt: ToolReceipt = {
      callId: "transaction",
      ok: false,
      output: "conflicts",
      result: {
        status: "conflicts_pending",
        transactionHandle: "transaction-handle",
        conflictPaths: ["src/conflict.ts"]
      },
      observedEffects: ["repository.write"],
      actualEffects: ["repository.write"],
      artifacts: [],
      diagnostics: ["conflicts_pending"],
      startedAt: "start",
      completedAt: "end"
    };
    session.durable.state.receipts.push(receipt);

    await expect(assertTransactionIsolationPlanAllowed(
      session,
      plan(["src/other.ts"], [])
    )).resolves.toBeUndefined();
    await expect(assertTransactionIsolationPlanAllowed(
      session,
      plan(["src/conflict.ts"], ["src/conflict.ts"])
    )).resolves.toBeUndefined();
    await expect(assertTransactionIsolationPlanAllowed(
      session,
      plan(["src/conflict.ts"], ["src/other.ts"])
    )).rejects.toMatchObject({ code: "tool_unavailable_for_repair" });
    expect(session.durable.state).not.toHaveProperty("taskControl");
  });
});
