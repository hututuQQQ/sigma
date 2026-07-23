import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  recordToolPolicyViolation,
  repositoryRecoveryObligation
} from "../packages/agent-kernel/src/index.js";
import type { ToolCallPlan, ToolDescriptor } from "../packages/agent-protocol/src/index.js";
import {
  assertTaskControlCallAllowed,
  assertTaskControlPlanAllowed
} from "../packages/agent-runtime/src/tool-plan-enforcement.js";
import {
  deadlineBudgetStage,
  prepareBudgetedModelTurn
} from "../packages/agent-runtime/src/model-budget-convergence.js";
import {
  completionRepairPhase,
  descriptorAllowedForRepair,
  descriptorsAllowedForRepair,
  maximumTaskControlCalls
} from "../packages/agent-runtime/src/tool-turn-policy.js";
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
      ? ["filesystem.read", "filesystem.write"] : ["filesystem.read"],
    readPaths,
    writePaths,
    network: "none",
    processMode: "none",
    checkpointScope: writePaths,
    idempotence: writePaths.length > 0 ? "non_replayable" : "read_only"
  };
}

describe("repository recovery task-control projection", () => {
  const inspect = descriptor("repository_inspect", ["filesystem.read", "process.spawn.readonly"]);
  const transaction = descriptor("git_transaction", ["repository.write", "filesystem.write"]);
  const read = descriptor("read", ["filesystem.read"]);
  const patch = descriptor("apply_patch", ["filesystem.read", "filesystem.write"]);
  const exec = descriptor("exec", ["filesystem.read", "process.spawn"]);
  const complete = descriptor("complete_task", ["outcome.propose"]);

  it("makes deadline convergence terminal when possible without hiding an active prerequisite", () => {
    const forecast = {
      stage: "converge" as const,
      remainingMs: 40_000,
      usableMs: 30_000,
      nextModelEstimateMs: 15_000,
      settlementReserveMs: 10_000
    };
    expect(deadlineBudgetStage(forecast, [read, complete])).toBe("terminal");
    expect(deadlineBudgetStage(forecast, [transaction])).toBe("converge");
  });

  it("leaves natural completion available when terminal tools only report failure or request input", async () => {
    const session = runtimeSessionFixture();
    const reportBlocked = descriptor("report_blocked", ["outcome.report_blocked"]);
    const requestInput = descriptor("request_user_input", ["outcome.request_input"]);
    const input = {
      session,
      forecast: {
        stage: "converge" as const,
        remainingMs: 40_000,
        usableMs: 30_000,
        nextModelEstimateMs: 15_000,
        settlementReserveMs: 10_000
      },
      turnId: 1,
      descriptors: [read, reportBlocked, requestInput],
      capabilities: { skillsAvailable: false, executableSkillResourcesLoaded: false },
      dynamic: [],
      hookContext: [],
      ledger: {
        id: "ledger", authority: "runtime" as const, provenance: "test ledger",
        content: "{}", tokenCount: 1, priority: 1
      },
      available: {
        inputTokens: 100_000, outputTokens: 100_000, costMicroUsd: 10_000_000,
        modelTurns: 10, toolCalls: 10, children: 10
      },
      repairPending: false,
      budgetStage: "terminal" as const,
      defaultOutputReserveTokens: 4_096
    };

    const prepared = await prepareBudgetedModelTurn(input);
    expect(prepared.turn.tools.map((tool) => tool.name))
      .toEqual(["report_blocked", "request_user_input"]);
    expect(prepared.turn.toolChoice).toBeUndefined();
    expect(prepared.turn.messages.some((message) =>
      message.content.includes("If the task is complete, stop naturally")
    )).toBe(true);

    const repair = await prepareBudgetedModelTurn({
      ...input,
      turnId: 2,
      repairPending: true
    });
    expect(repair.turn.toolChoice).toBe("required");
    expect(repair.turn.messages.some((message) =>
      message.content.includes("If the task is complete, stop naturally")
    )).toBe(false);
  });

  it("binds and projects a selected recovery candidate as one exact transaction", async () => {
    const session = runtimeSessionFixture();
    const candidateId = "c".repeat(64);
    session.durable.state.taskControl = repositoryRecoveryObligation(
      session.durable.state.taskControl,
      session.durable.state.revision,
      "transact",
      { candidateId },
      { candidateId, selectionEvidenceId: "selection" }
    );
    expect(descriptorAllowedForRepair(session, transaction)).toBe(true);
    expect(descriptorAllowedForRepair(session, inspect)).toBe(false);
    expect(descriptorAllowedForRepair(session, patch)).toBe(false);
    expect(() => assertTaskControlCallAllowed(session, {
      id: "raw-oid",
      name: "git_transaction",
      arguments: { action: "recover", candidateId: "d".repeat(64), selectionEvidenceId: "selection" }
    })).toThrowError(expect.objectContaining({ code: "tool_unavailable_for_repair" }));
    expect(() => assertTaskControlCallAllowed(session, {
      id: "bound-recovery",
      name: "git_transaction",
      arguments: { action: "recover", candidateId, selectionEvidenceId: "selection" }
    })).not.toThrow();
    const projected = descriptorsAllowedForRepair(session, [transaction]);
    expect(projected).toEqual([{
      ...transaction,
      description: "Recover the runtime-selected Git candidate with its bound selection evidence. The action and evidence fields are fixed by task control; call git_transaction exactly as projected.",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", const: "recover" },
          candidateId: { type: "string", const: candidateId },
          selectionEvidenceId: { type: "string", const: "selection" }
        },
        required: ["action", "candidateId", "selectionEvidenceId"],
        additionalProperties: false
      }
    }]);
    const prepared = await prepareBudgetedModelTurn({
      session,
      forecast: {
        stage: "normal", remainingMs: 60_000, usableMs: 50_000,
        nextModelEstimateMs: 15_000, settlementReserveMs: 10_000
      },
      turnId: 1,
      descriptors: projected,
      capabilities: { skillsAvailable: false, executableSkillResourcesLoaded: false },
      dynamic: [],
      hookContext: [],
      ledger: {
        id: "ledger", authority: "runtime", provenance: "test ledger",
        content: "{}", tokenCount: 1, priority: 1
      },
      available: {
        inputTokens: 100_000, outputTokens: 100_000, costMicroUsd: 10_000_000,
        modelTurns: 10, toolCalls: 10, children: 10
      },
      repairPending: true,
      budgetStage: "normal",
      defaultOutputReserveTokens: 4_096
    });
    expect(prepared.turn.toolChoice).toBe("required");
    expect(prepared.turn.tools.map((tool) => tool.name)).toEqual(["git_transaction"]);
    expect(prepared.turn.messages.some((message) => message.content.includes(
      `Call git_transaction with exactly these arguments: ${JSON.stringify({
        action: "recover", candidateId, selectionEvidenceId: "selection"
      })}`
    ))).toBe(true);
  });

  it("offers only re-inspection while resolving a user selection", () => {
    const session = runtimeSessionFixture();
    session.durable.state.taskControl = repositoryRecoveryObligation(
      session.durable.state.taskControl,
      session.durable.state.revision,
      "select",
      { candidateSetDigest: "a".repeat(64) }
    );
    expect(descriptorAllowedForRepair(session, inspect)).toBe(true);
    expect(descriptorAllowedForRepair(session, transaction)).toBe(false);
    expect(descriptorAllowedForRepair(session, read)).toBe(false);
  });

  it("allows workspace context reads but scopes conflict mutations to broker-observed paths", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-repository-repair-"));
    await mkdir(path.join(workspace, "src"));
    await writeFile(path.join(workspace, "src", "conflict.ts"), "conflict\n", "utf8");
    await writeFile(path.join(workspace, "src", "other.ts"), "other\n", "utf8");
    const session = runtimeSessionFixture({ workspacePath: workspace });
    session.durable.state.taskControl = repositoryRecoveryObligation(
      session.durable.state.taskControl,
      session.durable.state.revision,
      "transact",
      { transactionId: "transaction", scopePaths: ["src/conflict.ts"] },
      { transactionId: "transaction", scopePaths: ["src/conflict.ts"] }
    );
    expect(descriptorAllowedForRepair(session, read)).toBe(true);
    expect(descriptorAllowedForRepair(session, patch)).toBe(true);
    expect(descriptorAllowedForRepair(session, exec)).toBe(false);
    const conflictEdit: ToolDescriptor = {
      ...patch,
      name: "edit",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          oldText: { type: "string" },
          newText: { type: "string" }
        },
        required: ["path", "oldText", "newText"],
        additionalProperties: false
      }
    };
    const projected = descriptorsAllowedForRepair(
      session, [read, conflictEdit, transaction]
    );
    expect((projected.find((item) => item.name === "edit")!.inputSchema.properties as any).path)
      .toMatchObject({ const: "src/conflict.ts" });
    expect(projected.find((item) => item.name === "git_transaction")!.description)
      .toContain("active broker-journaled recovery transaction");
    const prepared = await prepareBudgetedModelTurn({
      session,
      forecast: {
        stage: "normal", remainingMs: 60_000, usableMs: 50_000,
        nextModelEstimateMs: 15_000, settlementReserveMs: 10_000
      },
      turnId: 2,
      descriptors: projected,
      capabilities: { skillsAvailable: false, executableSkillResourcesLoaded: false },
      dynamic: [],
      hookContext: [],
      ledger: {
        id: "ledger", authority: "runtime", provenance: "test ledger",
        content: "{}", tokenCount: 1, priority: 1
      },
      available: {
        inputTokens: 100_000, outputTokens: 100_000, costMicroUsd: 10_000_000,
        modelTurns: 10, toolCalls: 10, children: 10
      },
      repairPending: true,
      budgetStage: "normal",
      defaultOutputReserveTokens: 4_096
    });
    expect(prepared.turn.messages.some((message) => message.content.includes(
      "may modify only these conflict paths: [\"src/conflict.ts\"]"
    ))).toBe(true);
    expect(prepared.turn.messages.some((message) => message.content.includes(
      "transactionHandle \"transaction\""
    ))).toBe(true);
    expect(() => assertTaskControlCallAllowed(session, {
      id: "continue",
      name: "git_transaction",
      arguments: { action: "continue", transactionHandle: "transaction" }
    })).not.toThrow();
    expect(() => assertTaskControlCallAllowed(session, {
      id: "wrong-handle",
      name: "git_transaction",
      arguments: { action: "abort", transactionHandle: "other" }
    })).toThrowError(expect.objectContaining({ code: "tool_unavailable_for_repair" }));
    await expect(assertTaskControlPlanAllowed(
      session, plan(["src/conflict.ts"], ["src/conflict.ts"])
    )).resolves.toBeUndefined();
    await expect(assertTaskControlPlanAllowed(
      session, plan(["src/other.ts"], [])
    )).resolves.toBeUndefined();
    await expect(assertTaskControlPlanAllowed(
      session, plan(["src/other.ts"], ["src/conflict.ts"])
    )).resolves.toBeUndefined();
    await expect(assertTaskControlPlanAllowed(
      session, plan(["src/conflict.ts"], ["src/other.ts"])
    )).rejects.toMatchObject({ code: "tool_unavailable_for_repair" });
    await expect(assertTaskControlPlanAllowed(
      session, plan(["../outside.ts"], [])
    )).rejects.toMatchObject({ code: "tool_unavailable_for_repair" });
  });
});

describe("generic task-control convergence projection", () => {
  it("reports runtime-owned no-progress state and points completed work at a completion action", async () => {
    const session = runtimeSessionFixture();
    session.durable.state.taskControl.phase = "focused";
    session.durable.state.taskControl.episode.noProgressBatches = 4;
    const descriptors = [
      descriptor("read", ["filesystem.read"]),
      descriptor("validate", ["filesystem.read", "process.spawn.readonly", "validation"]),
      descriptor("complete", ["outcome.propose"])
    ];

    const prepared = await prepareBudgetedModelTurn({
      session,
      forecast: {
        stage: "normal", remainingMs: 60_000, usableMs: 50_000,
        nextModelEstimateMs: 15_000, settlementReserveMs: 10_000
      },
      turnId: 3,
      descriptors,
      capabilities: { skillsAvailable: false, executableSkillResourcesLoaded: false },
      dynamic: [],
      hookContext: [],
      ledger: {
        id: "ledger", authority: "runtime", provenance: "test ledger",
        content: "{}", tokenCount: 1, priority: 1
      },
      available: {
        inputTokens: 100_000, outputTokens: 100_000, costMicroUsd: 10_000_000,
        modelTurns: 10, toolCalls: 10, children: 10
      },
      repairPending: true,
      budgetStage: "normal",
      defaultOutputReserveTokens: 4_096
    });

    expect(prepared.turn.messages.some((message) =>
      message.content.includes("last 4 completed tool batches produced no new trusted task facts")
      && message.content.includes("Do not repeat a read or command whose result is already known")
      && message.content.includes("use a completion action now (complete)")
    )).toBe(true);
  });

  it("allows one corrected parallel batch after JSON-encoded tool arguments are rejected", async () => {
    const session = runtimeSessionFixture();
    session.durable.state.taskControl = recordToolPolicyViolation(
      {
        ...session.durable.state.taskControl,
        episode: {
          ...session.durable.state.taskControl.episode,
          noProgressBatches: 1
        }
      },
      "tool_arguments_invalid",
      session.durable.state.revision
    );
    const descriptors = [
      descriptor("read", ["filesystem.read"]),
      descriptor("shell", ["filesystem.read", "process.spawn.readonly"])
    ];

    expect(completionRepairPhase(session)).toBe("protocol_repair");
    expect(maximumTaskControlCalls(session)).toBe(Number.MAX_SAFE_INTEGER);
    expect(descriptorsAllowedForRepair(session, descriptors).map((item) => item.name))
      .toEqual(["read", "shell"]);

    const prepared = await prepareBudgetedModelTurn({
      session,
      forecast: {
        stage: "normal", remainingMs: 60_000, usableMs: 50_000,
        nextModelEstimateMs: 15_000, settlementReserveMs: 10_000
      },
      turnId: 4,
      descriptors,
      capabilities: { skillsAvailable: false, executableSkillResourcesLoaded: false },
      dynamic: [],
      hookContext: [],
      ledger: {
        id: "ledger", authority: "runtime", provenance: "test ledger",
        content: "{}", tokenCount: 1, priority: 1
      },
      available: {
        inputTokens: 100_000, outputTokens: 100_000, costMicroUsd: 10_000_000,
        modelTurns: 10, toolCalls: 10, children: 10
      },
      repairPending: true,
      budgetStage: "normal",
      defaultOutputReserveTokens: 4_096
    });

    expect(prepared.turn.messages.some((message) =>
      message.content.includes("do not JSON-encode the arguments object")
      && message.content.includes("Independent corrected calls may be submitted together")
      && !message.content.includes("exactly one tool call")
    )).toBe(true);
  });
});
