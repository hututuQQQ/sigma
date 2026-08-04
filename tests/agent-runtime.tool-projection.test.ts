import { describe, expect, it } from "vitest";
import type { ToolDescriptor } from "../packages/agent-protocol/src/index.js";
import { registerBuiltinTools, EffectToolRegistry } from "../packages/agent-tools/src/index.js";
import {
  modelTools,
  projectModelToolDescriptors,
  sessionModelToolProjectionCapabilities,
  sessionSkillProjectionCapabilities,
  stableSessionModelToolProjectionCapabilities
} from "../packages/agent-runtime/src/effect-helpers.js";
import {
  eligibleReadBatchDescriptors,
  readBatchPlanAllowed,
  readBatchDescriptor,
  withReadBatchDescriptor
} from "../packages/agent-runtime/src/read-batch-tool.js";
import { runtimeSessionFixture } from "./testkit/runtime-session-fixture.js";

describe("session model-tool capability projection", () => {
  const descriptors = registerBuiltinTools(new EffectToolRegistry()).descriptors();

  it("serializes model tool schemas deterministically regardless of registry order", () => {
    const forward = modelTools(descriptors);
    const reversed = modelTools([...descriptors].reverse());
    expect(reversed).toEqual(forward);
    expect(forward.map((item) => item.name))
      .toEqual(forward.map((item) => item.name).toSorted());
    for (const tool of forward) {
      const properties = tool.inputSchema.properties;
      if (properties && typeof properties === "object" && !Array.isArray(properties)) {
        expect(Object.keys(properties)).toEqual(Object.keys(properties).toSorted());
      }
    }
  });

  it("offers batching only as a facade over auto-approved read-only tools", () => {
    const eligible = eligibleReadBatchDescriptors(descriptors);
    expect(eligible.map((item) => item.name)).toEqual(expect.arrayContaining([
      "read", "git_status", "git_diff"
    ]));
    expect(eligible.map((item) => item.name)).not.toEqual(expect.arrayContaining([
      "apply_patch", "shell", "write", "lsp"
    ]));
    const batch = readBatchDescriptor(descriptors);
    expect(batch).toMatchObject({
      name: "batch_read",
      approval: "auto",
      possibleEffects: ["filesystem.read", "process.spawn.readonly"]
    });
    const schema = JSON.stringify(batch?.inputSchema);
    expect(schema).toContain('"read"');
    expect(schema).not.toContain('"apply_patch"');
    expect(schema).not.toContain('"shell"');
  });

  it("admits a mixed-capability descriptor only when its prepared member plan is read-only", () => {
    const read = descriptors.find((item) => item.name === "read")!;
    const navigation: ToolDescriptor = {
      ...read,
      name: "planned_navigation",
      possibleEffects: ["filesystem.read", "filesystem.write", "process.spawn.readonly"],
      maximumEffects: ["filesystem.read", "filesystem.write", "process.spawn.readonly"],
      approval: "auto"
    };
    expect(eligibleReadBatchDescriptors([...descriptors, navigation]).map((item) => item.name))
      .toContain("planned_navigation");
    const readPlan = {
      exactEffects: ["filesystem.read", "process.spawn.readonly"],
      readPaths: ["src/current.ts"], writePaths: [], network: "none" as const,
      processMode: "background" as const, checkpointScope: [], idempotence: "read_only" as const
    };
    expect(readBatchPlanAllowed(readPlan)).toBe(true);
    expect(readBatchPlanAllowed({
      ...readPlan,
      exactEffects: [...readPlan.exactEffects, "filesystem.write"],
      writePaths: ["src/current.ts"],
      idempotence: "non_replayable"
    })).toBe(false);
  });

  it("builds the batch facade only from capability-visible tools", () => {
    const read = descriptors.find((item) => item.name === "read")!;
    const projected = projectModelToolDescriptors([
      ...descriptors.filter((item) => item.name !== "read_plan"),
      { ...read, name: "read_plan" }
    ], {
      skillsAvailable: false,
      planReadRequired: false
    });
    const offered = withReadBatchDescriptor(projected);
    const schema = JSON.stringify(
      offered.find((item) => item.name === "batch_read")?.inputSchema
    );
    expect(schema).toContain('"read"');
    expect(schema).not.toContain('"read_plan"');
  });

  it("does not advertise Git operations when the workspace is known not to be a repository", () => {
    const projected = withReadBatchDescriptor(projectModelToolDescriptors(descriptors, {
      skillsAvailable: false,
      gitReadAvailable: false,
      repositoryInspectionAvailable: false
    }));
    const names = projected.map((item) => item.name);
    expect(names).not.toEqual(expect.arrayContaining([
      "git_status", "git_diff", "repository_inspect", "git_transaction"
    ]));
    expect(JSON.stringify(
      projected.find((item) => item.name === "batch_read")?.inputSchema
    )).not.toMatch(/git_status|git_diff/u);
    expect(names).toContain("read");
  });

  it("hides skill discovery and execution fields when no skill exists", () => {
    const projected = projectModelToolDescriptors(descriptors, {
      skillsAvailable: false
    });
    expect(projected.some((item) => item.name === "load_skill")).toBe(false);
    expect(projected.some((item) => item.name === "exec")).toBe(false);
    expect(projected.some((item) => item.name === "validate")).toBe(false);
    expect(projected.some((item) => item.name === "process_spawn")).toBe(false);
    const properties = projected.find((item) => item.name === "shell")?.inputSchema.properties;
    expect(properties).not.toHaveProperty("skill");
    expect(properties).not.toHaveProperty("skillScript");
  });

  it("keeps one stable foreground surface while skills are discovered and loaded", () => {
    const discoverable = projectModelToolDescriptors(descriptors, {
      skillsAvailable: true
    });
    expect(discoverable.some((item) => item.name === "load_skill")).toBe(true);
    expect(discoverable.some((item) => item.name === "exec")).toBe(false);
    expect(discoverable.find((item) => item.name === "shell")?.inputSchema.properties)
      .toHaveProperty("skill");

    expect(discoverable.some((item) => item.name === "exec")).toBe(false);
    expect(discoverable.find((item) => item.name === "shell")?.inputSchema.properties)
      .toHaveProperty("skill");
    expect(discoverable.find((item) => item.name === "shell")?.inputSchema.properties)
      .toHaveProperty("skillScript");
    expect(discoverable.some((item) => item.name === "validate")).toBe(false);
    expect(discoverable.some((item) => item.name === "process_spawn")).toBe(false);
    expect(discoverable.find((item) => item.name === "shell")?.inputSchema.properties)
      .toHaveProperty("background");
    expect(discoverable.find((item) => item.name === "shell")?.inputSchema.properties)
      .toHaveProperty("validation");
  });

  it("uses one current shell contract at both runtime and model boundaries", () => {
    const tools = registerBuiltinTools(new EffectToolRegistry());
    const runtimeProperties = tools.descriptor("shell")?.inputSchema.properties;
    const modelShell = tools.modelDescriptors().find((item) => item.name === "shell");
    const modelProperties = modelShell?.inputSchema.properties;

    expect(runtimeProperties).not.toHaveProperty("access");
    expect(runtimeProperties).not.toHaveProperty("writeRoots");
    expect(runtimeProperties).toHaveProperty("expectedChanges");
    expect(runtimeProperties).not.toHaveProperty("purpose");
    expect(runtimeProperties).not.toHaveProperty("subjects");
    expect(runtimeProperties).not.toHaveProperty("criterionIds");
    expect(modelProperties).toEqual(runtimeProperties);
    expect(modelProperties).not.toHaveProperty("access");
    expect(modelProperties).not.toHaveProperty("writeRoots");
    expect(modelProperties).toHaveProperty("expectedChanges");
    expect((modelProperties as Record<string, unknown>).expectedChanges)
      .not.toHaveProperty("minItems");
    expect(modelProperties).not.toHaveProperty("purpose");
    expect(modelProperties).not.toHaveProperty("subjects");
    expect(modelProperties).not.toHaveProperty("criterionIds");
    expect(modelShell?.description).toContain("process temp directory");
    expect(modelShell?.description).toContain("validation=true");
    expect(modelShell?.description).toContain("Keep commands that write workspace deliverables");
    expect((modelProperties as Record<string, { description?: string }>).background?.description)
      .toContain("read-only long-running commands");

    const analyzeShell = projectModelToolDescriptors(tools.modelDescriptors(), {
      skillsAvailable: false,
      environmentMutationAvailable: false
    }).find((item) => item.name === "shell");
    expect(analyzeShell?.inputSchema.properties).not.toHaveProperty("expectedChanges");
    expect(analyzeShell?.description).not.toContain("provide expectedChanges");
  });

  it("keeps environment state guidance only while that execution boundary is available", () => {
    const environmentTools = registerBuiltinTools(new EffectToolRegistry(), {
      readScope: "host",
      writeScope: "enclosing-container",
      enclosingContainerRoot: true,
      enclosingContainerAttestationDigest: "attested-container"
    }).modelDescriptors();
    const availableShell = projectModelToolDescriptors(environmentTools, {
      skillsAvailable: false,
      environmentMutationAvailable: true
    }).find((item) => item.name === "shell");
    expect(availableShell?.description)
      .toContain("workspace-target calls use a separate sandbox view");

    const unavailableShell = projectModelToolDescriptors(environmentTools, {
      skillsAvailable: false,
      environmentMutationAvailable: false
    }).find((item) => item.name === "shell");
    expect(unavailableShell?.inputSchema.properties).not.toHaveProperty("target");
    expect(unavailableShell?.description).not.toContain("target=environment");
    expect(unavailableShell?.description).not.toContain("outer environment");
  });

  it("defers lifecycle controls until durable process or child state exists", () => {
    const template = descriptors.find((item) => item.name === "read_plan")!;
    const childNames = [
      "spawn_agent", "message_agent", "join_agent", "list_agents", "integrate_agent"
    ];
    const lifecycleDescriptors = [
      ...descriptors,
      ...childNames.map((name) => ({ ...template, name }))
    ];
    const unavailable = projectModelToolDescriptors(lifecycleDescriptors, {
      skillsAvailable: false,
      processControlsAvailable: false,
      childControlsAvailable: false,
      planReadRequired: false,
      artifactReadAvailable: false,
      workspaceFrontierReadRequired: false,
      checkpointListAvailable: false,
      checkpointRestoreAvailable: false,
      restorationConfirmationAvailable: false,
      reviewAvailable: false
    });
    for (const name of [
      "process_poll", "process_write", "process_terminate", "process_handoff",
      "message_agent", "join_agent", "list_agents", "integrate_agent", "read_plan",
      "read_artifact", "read_workspace_frontier", "list_checkpoints",
      "restore_run_changes", "confirm_run_restored", "request_review"
    ]) {
      expect(unavailable.some((item) => item.name === name)).toBe(false);
    }
    expect(unavailable.some((item) => item.name === "process_spawn")).toBe(false);
    expect(unavailable.find((item) => item.name === "shell")?.inputSchema.properties)
      .toHaveProperty("background");
    expect(unavailable.some((item) => item.name === "spawn_agent")).toBe(true);

    const available = projectModelToolDescriptors(lifecycleDescriptors, {
      skillsAvailable: false,
      processControlsAvailable: true,
      childControlsAvailable: true,
      planReadRequired: true,
      artifactReadAvailable: true,
      workspaceFrontierReadRequired: true,
      checkpointListAvailable: true,
      checkpointRestoreAvailable: true,
      restorationConfirmationAvailable: true,
      reviewAvailable: true
    });
    for (const name of [
      "process_poll", "process_write", "process_terminate",
      "message_agent", "join_agent", "list_agents", "integrate_agent", "read_plan",
      "read_artifact", "read_workspace_frontier", "list_checkpoints",
      "restore_run_changes", "confirm_run_restored", "request_review"
    ]) {
      expect(available.some((item) => item.name === name)).toBe(true);
    }

    const sessionOnly = projectModelToolDescriptors(lifecycleDescriptors, {
      skillsAvailable: false,
      processControlsAvailable: true,
      processHandoffAvailable: false
    });
    expect(sessionOnly.some((item) => item.name === "process_poll")).toBe(true);
    expect(sessionOnly.some((item) => item.name === "process_terminate")).toBe(true);
    expect(sessionOnly.some((item) => item.name === "process_handoff")).toBe(false);
  });

  it("derives deferred inspection and recovery surfaces from durable session state", () => {
    const session = runtimeSessionFixture();
    expect(sessionModelToolProjectionCapabilities(session)).toMatchObject({
      artifactReadAvailable: false,
      workspaceFrontierReadRequired: false,
      checkpointListAvailable: false,
      checkpointRestoreAvailable: false,
      restorationConfirmationAvailable: false,
      reviewAvailable: false
    });

    session.durable.state.receipts.push({
      callId: "large-read",
      ok: true,
      output: "bounded",
      outcome: { status: "succeeded", output: "bounded", diagnosticCodes: [] },
      observedEffects: ["filesystem.read"],
      actualEffects: ["filesystem.read"],
      artifacts: ["artifact-id"],
      diagnostics: [],
      evidence: [],
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:00:01.000Z"
    });
    session.durable.state.mutationFrontier.changedPaths = Array.from(
      { length: 33 },
      (_, index) => `src/file-${index}.ts`
    );
    session.durable.state.mutationFrontier.sourceCheckpointIds = ["checkpoint"];
    session.durable.state.checkpointHead = {
      checkpointId: "checkpoint",
      sessionId: session.identity.sessionId,
      runId: session.durable.runId,
      status: "sealed",
      createdAt: "2026-01-01T00:00:00.000Z",
      sealedAt: "2026-01-01T00:00:01.000Z",
      preManifestDigest: "before",
      postManifestDigest: "after",
      delta: { added: [], modified: ["src/file-0.ts"], deleted: [] }
    };

    expect(sessionModelToolProjectionCapabilities(session)).toMatchObject({
      artifactReadAvailable: true,
      workspaceFrontierReadRequired: true,
      checkpointListAvailable: true,
      checkpointRestoreAvailable: true,
      restorationConfirmationAvailable: false,
      reviewAvailable: true
    });
  });

  it("keeps the model tool schema stable while live session capabilities change", () => {
    const session = runtimeSessionFixture();
    const stableBefore = stableSessionModelToolProjectionCapabilities(session);
    const schemaBefore = modelTools(withReadBatchDescriptor(
      projectModelToolDescriptors(descriptors, stableBefore)
    ));

    session.durable.state.activeProcessIds.push("process-1");
    session.durable.state.receipts.push({
      callId: "artifact-producing-call",
      ok: true,
      output: "bounded",
      outcome: { status: "succeeded", output: "bounded", diagnosticCodes: [] },
      observedEffects: ["filesystem.read"],
      actualEffects: ["filesystem.read"],
      artifacts: ["artifact-id"],
      diagnostics: [],
      evidence: [],
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:00:01.000Z"
    });
    session.durable.state.mutationFrontier.changedPaths = ["src/changed.ts"];

    expect(sessionModelToolProjectionCapabilities(session)).toMatchObject({
      processControlsAvailable: true,
      artifactReadAvailable: true,
      reviewAvailable: true
    });
    const stableAfter = stableSessionModelToolProjectionCapabilities(session);
    const schemaAfter = modelTools(withReadBatchDescriptor(
      projectModelToolDescriptors(descriptors, stableAfter)
    ));
    expect(stableAfter).toEqual(stableBefore);
    expect(schemaAfter).toEqual(schemaBefore);
    expect(schemaAfter.map((item) => item.name)).toEqual(expect.arrayContaining([
      "process_poll", "read_artifact", "request_review"
    ]));
  });

  it("retains direct execution when no shell exists", () => {
    const directDescriptors = registerBuiltinTools(new EffectToolRegistry(), {
      shells: []
    }).descriptors();
    const projected = projectModelToolDescriptors(
      directDescriptors,
      { skillsAvailable: false }
    );
    expect(projected.some((item) => item.name === "exec")).toBe(true);
    expect(projected.find((item) => item.name === "exec")?.inputSchema.properties)
      .not.toHaveProperty("skill");
    expect(projected.find((item) => item.name === "exec")?.inputSchema.properties)
      .not.toHaveProperty("access");
    expect(projected.find((item) => item.name === "exec")?.inputSchema.properties)
      .not.toHaveProperty("writeRoots");
    expect(projected.find((item) => item.name === "exec")?.inputSchema.properties)
      .toHaveProperty("expectedChanges");
  });

  it("projects frozen skills without widening profile capabilities", () => {
    expect(sessionSkillProjectionCapabilities({
      frozenCustomization: { skills: [] }
    })).toEqual({ skillsAvailable: false });
    expect(sessionSkillProjectionCapabilities({
      frozenCustomization: { skills: [{ qualifiedName: "home:frozen" }] },
      profileSkillNames: ["home:frozen"]
    })).toEqual({ skillsAvailable: true });
  });
});
