import { mkdir, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ModelToolCall, ToolCallPlan, ToolDescriptor } from "../packages/agent-protocol/src/index.js";
import { writeScopeFailure } from "../packages/agent-runtime/src/effect-helpers.js";
import type { RuntimeSession } from "../packages/agent-runtime/src/types.js";
import { runtimeSessionFixture } from "./testkit/runtime-session-fixture.js";

const descriptor: ToolDescriptor = {
  name: "exec",
  description: "test",
  inputSchema: { type: "object" },
  possibleEffects: ["process.spawn", "process.spawn.readonly", "filesystem.write"],
  maximumEffects: ["process.spawn", "process.spawn.readonly", "filesystem.write"],
  availableModes: ["analyze", "change"],
  executionMode: "exclusive",
  resourceKeys: [],
  approval: "prompt",
  idempotent: false,
  timeoutMs: 1_000
};

function call(): ModelToolCall {
  return { id: "call", name: "exec", arguments: { executable: "fixture" } };
}

function plan(exactEffects: ToolCallPlan["exactEffects"], writePaths: string[]): ToolCallPlan {
  return {
    exactEffects,
    readPaths: ["."],
    writePaths,
    network: "none",
    processMode: "pipe",
    checkpointScope: writePaths,
    idempotence: "non_replayable"
  };
}

function session(workspacePath: string, writeScope = ["delegated"]): RuntimeSession {
  return runtimeSessionFixture({
    workspacePath,
    identity: { strictWriteScope: true, writeScope }
  });
}

describe("plan-aware delegated write scope", () => {
  it("uses exact plan effects and paths instead of descriptor maxima or raw arguments", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-plan-write-scope-"));
    await mkdir(path.join(workspace, "delegated"));
    await mkdir(path.join(workspace, "outside"));
    const runtimeSession = session(workspace);

    await expect(writeScopeFailure(
      runtimeSession,
      call(),
      descriptor,
      new Date().toISOString(),
      plan(["process.spawn.readonly"], [])
    )).resolves.toBeNull();
    await expect(writeScopeFailure(
      runtimeSession,
      call(),
      descriptor,
      new Date().toISOString(),
      plan(["process.spawn", "filesystem.write"], ["delegated/generated.ts"])
    )).resolves.toBeNull();
    await expect(writeScopeFailure(
      runtimeSession,
      call(),
      descriptor,
      new Date().toISOString(),
      plan(["process.spawn", "filesystem.write"], ["outside/generated.ts"])
    )).resolves.toMatchObject({ ok: false, diagnostics: ["write_scope_denied"] });
  });

  it("denies unconstrained open-world execution in a delegated write scope", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-open-world-scope-"));
    await mkdir(path.join(workspace, "delegated"));
    await expect(writeScopeFailure(
      session(workspace),
      call(),
      descriptor,
      new Date().toISOString(),
      plan(["process.spawn.readonly", "open_world"], [])
    )).resolves.toMatchObject({ ok: false, diagnostics: ["write_scope_denied"] });
  });

  it("allows an absent checkpoint ancestor needed for an exact nested file scope", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-missing-checkpoint-scope-"));
    const nestedPlan: ToolCallPlan = {
      exactEffects: ["filesystem.write"],
      readPaths: ["delegated/new/file.ts"],
      writePaths: ["delegated/new/file.ts"],
      network: "none",
      processMode: "none",
      checkpointScope: ["delegated"],
      idempotence: "replay_safe"
    };

    await expect(writeScopeFailure(
      session(workspace, ["delegated/new/file.ts"]),
      call(),
      descriptor,
      new Date().toISOString(),
      nestedPlan
    )).resolves.toBeNull();

    await mkdir(path.join(workspace, "delegated"));
    await expect(writeScopeFailure(
      session(workspace, ["delegated/new/file.ts"]),
      call(),
      descriptor,
      new Date().toISOString(),
      nestedPlan
    )).resolves.toMatchObject({ ok: false, diagnostics: ["write_scope_denied"] });
  });
});
