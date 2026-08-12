import { describe, expect, it } from "vitest";
import { registerBuiltinTools, EffectToolRegistry } from "../packages/agent-tools/src/index.js";
import {
  modelTools,
  projectModelToolDescriptors,
  sessionSkillProjectionCapabilities
} from "../packages/agent-runtime/src/effect-helpers.js";
import {
  eligibleReadBatchDescriptors,
  readBatchDescriptor,
  withReadBatchDescriptor
} from "../packages/agent-runtime/src/read-batch-tool.js";

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

  it("projects a provider-neutral direct core and deferred capability metadata", () => {
    const tools = new Map(modelTools(descriptors).map((tool) => [tool.name, tool]));
    for (const name of [
      "read", "write", "edit", "apply_patch", "shell",
      "git_status", "git_diff", "update_plan", "request_user_input", "report_blocked"
    ]) {
      expect(tools.get(name)?.presentation?.exposure, name).toBe("direct");
    }
    const deferredNames = [
      "inspect_document", "inspect_image", "lsp", "process_spawn", "load_skill",
      "delete_file", "restore_run_changes", "spawn_agent"
    ].filter((name) => tools.has(name));
    expect(deferredNames.length).toBeGreaterThanOrEqual(5);
    for (const name of deferredNames) {
      expect(tools.get(name)?.presentation?.exposure, name).toBe("deferred");
    }
    expect(tools.get("inspect_image")?.presentation?.namespace?.name)
      .toBe("workspace_read");
    expect(tools.get("delete_file")?.presentation?.namespace?.name)
      .toBe("workspace_write");
    expect(JSON.stringify([...tools.values()])).not.toMatch(/gpt-|openai|anthropic|google/iu);
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
      planReadRequired: false
    });
    for (const name of [
      "process_poll", "process_write", "process_terminate", "process_handoff",
      "message_agent", "join_agent", "list_agents", "integrate_agent", "read_plan"
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
      planReadRequired: true
    });
    for (const name of [
      "process_poll", "process_write", "process_terminate",
      "message_agent", "join_agent", "list_agents", "integrate_agent", "read_plan"
    ]) {
      expect(available.some((item) => item.name === name)).toBe(true);
    }
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
