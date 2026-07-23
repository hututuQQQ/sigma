import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { repositoryRecoveryObligation } from "../packages/agent-kernel/src/index.js";
import type { ToolCallPlan, ToolDescriptor } from "../packages/agent-protocol/src/index.js";
import {
  assertTaskControlCallAllowed,
  assertTaskControlPlanAllowed
} from "../packages/agent-runtime/src/tool-plan-enforcement.js";
import { descriptorAllowedForRepair } from "../packages/agent-runtime/src/tool-turn-policy.js";
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

  it("binds a selected recovery candidate to one structured transaction", () => {
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

  it("scopes conflict reads and mutations to broker-observed paths", async () => {
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
      session, plan(["src/other.ts"], ["src/other.ts"])
    )).rejects.toMatchObject({ code: "tool_unavailable_for_repair" });
  });
});
