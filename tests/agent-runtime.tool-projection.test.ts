import { describe, expect, it } from "vitest";
import { registerBuiltinTools, EffectToolRegistry } from "../packages/agent-tools/src/index.js";
import {
  projectModelToolDescriptors,
  sessionSkillProjectionCapabilities
} from "../packages/agent-runtime/src/effect-helpers.js";
import {
  descriptorsAvailableToModel,
  modelToolArgumentFailure,
  modelToolCallContractFailure,
  modelTurnToolPolicyFailure
} from "../packages/agent-runtime/src/model-tool-availability.js";
import type { ModelToolCall, ToolDescriptor } from "../packages/agent-protocol/src/index.js";
import { runtimeSessionFixture } from "./testkit/runtime-session-fixture.js";

describe("session model-tool capability projection", () => {
  const descriptors = registerBuiltinTools(new EffectToolRegistry()).descriptors();

  it("hides skill discovery and execution fields when no skill exists", () => {
    const projected = projectModelToolDescriptors(descriptors, {
      skillsAvailable: false,
      executableSkillResourcesLoaded: false
    });
    expect(projected.some((item) => item.name === "load_skill")).toBe(false);
    for (const name of ["exec", "validate", "process_spawn"]) {
      const properties = projected.find((item) => item.name === name)?.inputSchema.properties;
      expect(properties).not.toHaveProperty("skill");
      expect(properties).not.toHaveProperty("skillScript");
    }
  });

  it("exposes only the skill capabilities that are actually usable in this session", () => {
    const discoverable = projectModelToolDescriptors(descriptors, {
      skillsAvailable: true,
      executableSkillResourcesLoaded: false
    });
    expect(discoverable.some((item) => item.name === "load_skill")).toBe(true);
    expect(discoverable.find((item) => item.name === "exec")?.inputSchema.properties)
      .not.toHaveProperty("skill");

    const loaded = projectModelToolDescriptors(descriptors, {
      skillsAvailable: true,
      executableSkillResourcesLoaded: true
    });
    expect(loaded.find((item) => item.name === "exec")?.inputSchema.properties)
      .toHaveProperty("skill");
    expect(loaded.find((item) => item.name === "exec")?.inputSchema.properties)
      .toHaveProperty("skillScript");
    expect(loaded.find((item) => item.name === "process_spawn")?.inputSchema.properties)
      .not.toHaveProperty("skill");
  });

  it("keeps the authoritative execution contract while exposing only expectedChanges to the model", () => {
    const projected = projectModelToolDescriptors(descriptors, {
      skillsAvailable: true,
      executableSkillResourcesLoaded: true
    });
    for (const name of ["exec", "shell", "validate"]) {
      const authoritative = descriptors.find((item) => item.name === name);
      if (!authoritative) continue;
      const visible = projected.find((item) => item.name === name);
      expect(authoritative.inputSchema.properties).toMatchObject({
        access: expect.any(Object),
        writeRoots: expect.any(Object),
        writePaths: expect.any(Object),
        expectedChanges: expect.any(Object)
      });
      expect(visible?.inputSchema.properties).toHaveProperty("expectedChanges");
      expect(visible?.inputSchema.properties).not.toHaveProperty("access");
      expect(visible?.inputSchema.properties).not.toHaveProperty("writeRoots");
      expect(visible?.inputSchema.properties).not.toHaveProperty("writePaths");
    }
  });

  it("phases process, child, checkpoint, and review controls from durable state", () => {
    const session = runtimeSessionFixture();
    const childControl = {
      ...descriptors[0]!,
      name: "list_agents"
    } as ToolDescriptor;
    const candidates = [...descriptors, childControl];
    const initial = descriptorsAvailableToModel(session, candidates).map((item) => item.name);
    expect(initial).toContain("process_spawn");
    expect(initial).not.toContain("process_poll");
    expect(initial).not.toContain("list_agents");
    expect(initial).not.toContain("list_checkpoints");
    expect(initial).not.toContain("restore_run_changes");
    expect(initial).not.toContain("request_review");

    session.durable.state.activeProcessIds = ["process-1"];
    session.durable.state.childIds = ["child-1"];
    session.durable.state.mutationFrontier.changedPaths = ["src/code.ts"];
    session.durable.state.checkpointHead = {
      checkpointId: "checkpoint-1",
      sessionId: session.identity.sessionId,
      runId: session.durable.runId,
      status: "sealed",
      createdAt: "2026-01-01T00:00:00.000Z",
      preManifestDigest: "a".repeat(64),
      postManifestDigest: "b".repeat(64)
    };
    const active = descriptorsAvailableToModel(session, candidates).map((item) => item.name);
    expect(active).toEqual(expect.arrayContaining([
      "process_poll", "list_agents", "list_checkpoints", "restore_run_changes", "request_review"
    ]));
  });

  it("rejects a state-stale model call and model-authored hidden ACL fields", () => {
    const session = runtimeSessionFixture();
    const process = descriptors.find((item) => item.name === "process_poll")!;
    const staleCall: ModelToolCall = {
      id: "stale-process",
      name: process.name,
      arguments: { handleId: "gone", brokerInstanceId: "broker" }
    };
    session.durable.state.pendingTools = [{
      request: { callId: staleCall.id, name: staleCall.name, arguments: staleCall.arguments },
      modelTurn: { turnId: 1, effectRevision: session.durable.state.revision },
      approval: "not_required",
      started: false,
      origin: "model"
    }];
    expect(modelToolCallContractFailure(session, staleCall, process, "2026-01-01T00:00:00.000Z"))
      .toMatchObject({ diagnostics: ["tool_call_stale"], result: { code: "tool_call_stale" } });

    const exec = descriptors.find((item) => item.name === "exec")!;
    const hiddenCall: ModelToolCall = {
      id: "hidden-acl",
      name: exec.name,
      arguments: { executable: ".\\tool.exe", access: "write", writePaths: ["out.txt"] }
    };
    session.durable.state.pendingTools = [{
      request: { callId: hiddenCall.id, name: hiddenCall.name, arguments: hiddenCall.arguments },
      modelTurn: { turnId: 2, effectRevision: session.durable.state.revision },
      approval: "not_required",
      started: false,
      origin: "model"
    }];
    expect(modelToolCallContractFailure(session, hiddenCall, exec, "2026-01-01T00:00:00.000Z"))
      .toMatchObject({
        diagnostics: ["tool_arguments_stale"],
        result: {
          code: "tool_arguments_stale",
          nextArguments: { executable: ".\\tool.exe", expectedChanges: ["out.txt"] }
        }
      });
  });

  it("fails closed on missing or mixed-effect model-turn authorization", () => {
    const session = runtimeSessionFixture();
    const read = descriptors.find((item) => item.name === "read")!;
    const readCall: ModelToolCall = { id: "unbound-read", name: "read", arguments: { path: "seed.txt" } };
    const unboundTurn = { turnId: 10, effectRevision: session.durable.state.revision };
    session.durable.state.pendingTools = [{
      request: { callId: readCall.id, name: readCall.name, arguments: readCall.arguments },
      modelTurn: unboundTurn,
      approval: "not_required",
      started: false,
      origin: "model"
    }];
    expect(modelTurnToolPolicyFailure(
      session, readCall, read, unboundTurn, "2026-01-01T00:00:00.000Z"
    )).toMatchObject({ diagnostics: ["tool_not_authorized_for_turn"] });

    const mixed: ToolDescriptor = {
      ...read,
      name: "mixed_terminal_writer",
      possibleEffects: ["outcome.propose", "filesystem.write"]
    };
    const mixedCall: ModelToolCall = { id: "mixed-call", name: mixed.name, arguments: {} };
    const terminalTurn = {
      turnId: 11,
      effectRevision: session.durable.state.revision,
      toolPolicy: { allowedToolNames: [mixed.name], terminalOnly: true }
    };
    session.durable.state.pendingTools = [{
      request: { callId: mixedCall.id, name: mixedCall.name, arguments: mixedCall.arguments },
      modelTurn: terminalTurn,
      approval: "not_required",
      started: false,
      origin: "model"
    }];
    expect(modelTurnToolPolicyFailure(
      session, mixedCall, mixed, terminalTurn, "2026-01-01T00:00:00.000Z"
    )).toMatchObject({ diagnostics: ["tool_not_authorized_for_turn"] });
  });

  it("returns an adoptable nextArguments object when invalid extras can be removed safely", () => {
    const session = runtimeSessionFixture();
    const descriptor = descriptors.find((item) => item.name === "read_plan")!;
    const call: ModelToolCall = { id: "invalid-arguments", name: descriptor.name, arguments: { typo: true } };
    session.durable.state.pendingTools = [{
      request: { callId: call.id, name: call.name, arguments: call.arguments },
      modelTurn: { turnId: 3, effectRevision: session.durable.state.revision },
      approval: "not_required",
      started: false,
      origin: "model"
    }];
    expect(modelToolArgumentFailure(
      session,
      call,
      descriptor,
      "2026-01-01T00:00:00.000Z",
      Object.assign(new Error("invalid"), { code: "tool_arguments_invalid" })
    )).toMatchObject({
      diagnostics: ["tool_arguments_invalid"],
      result: { code: "tool_arguments_invalid", nextArguments: {} }
    });
  });

  it("projects legacy durable skills without widening frozen or profile capabilities", () => {
    const legacy = { qualifiedName: "home:legacy", executionManifestArtifactId: "a", executionManifestDigest: "b" };
    expect(sessionSkillProjectionCapabilities({ loadedSkills: [legacy] })).toEqual({
      skillsAvailable: true,
      executableSkillResourcesLoaded: true
    });
    expect(sessionSkillProjectionCapabilities({
      frozenCustomization: { skills: [] },
      liveSkillDescriptors: [legacy],
      loadedSkills: [legacy]
    })).toEqual({ skillsAvailable: false, executableSkillResourcesLoaded: false });
    expect(sessionSkillProjectionCapabilities({
      liveSkillDescriptors: [legacy],
      loadedSkills: [legacy],
      profileSkillNames: []
    })).toEqual({ skillsAvailable: false, executableSkillResourcesLoaded: false });
    expect(sessionSkillProjectionCapabilities({
      frozenCustomization: { skills: [{ qualifiedName: "home:frozen" }] },
      loadedSkills: [],
      profileSkillNames: ["home:frozen"]
    })).toEqual({ skillsAvailable: true, executableSkillResourcesLoaded: false });
  });

  it("exposes Git and LSP only when their exact session capability is available", () => {
    const descriptorsWithLsp = [...descriptors, { ...descriptors[0]!, name: "lsp" }];
    const hidden = projectModelToolDescriptors(descriptorsWithLsp, {
      skillsAvailable: false,
      executableSkillResourcesLoaded: false,
      gitAvailable: false,
      lspAvailable: false
    });
    expect(hidden.some((item) => item.name === "git_status" || item.name === "git_diff")).toBe(false);
    expect(hidden.some((item) => item.name === "lsp")).toBe(false);

    const visible = projectModelToolDescriptors(descriptorsWithLsp, {
      skillsAvailable: false,
      executableSkillResourcesLoaded: false,
      gitAvailable: true,
      lspAvailable: true
    });
    expect(visible.some((item) => item.name === "git_status")).toBe(true);
    expect(visible.some((item) => item.name === "git_diff")).toBe(true);
    expect(visible.some((item) => item.name === "lsp")).toBe(true);
  });
});
