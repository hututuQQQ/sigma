import { describe, expect, it } from "vitest";
import { registerBuiltinTools, EffectToolRegistry } from "../packages/agent-tools/src/index.js";
import {
  modelTools,
  projectModelToolDescriptors,
  sessionSkillProjectionCapabilities
} from "../packages/agent-runtime/src/effect-helpers.js";

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

  it("hides skill discovery and execution fields when no skill exists", () => {
    const projected = projectModelToolDescriptors(descriptors, {
      skillsAvailable: false,
      executableSkillResourcesLoaded: false
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
      skillsAvailable: true,
      executableSkillResourcesLoaded: false
    });
    expect(discoverable.some((item) => item.name === "load_skill")).toBe(true);
    expect(discoverable.some((item) => item.name === "exec")).toBe(false);
    expect(discoverable.find((item) => item.name === "shell")?.inputSchema.properties)
      .toHaveProperty("skill");

    const loaded = projectModelToolDescriptors(descriptors, {
      skillsAvailable: true,
      executableSkillResourcesLoaded: true
    });
    expect(loaded.some((item) => item.name === "exec")).toBe(false);
    expect(loaded.find((item) => item.name === "shell")?.inputSchema.properties)
      .toHaveProperty("skill");
    expect(loaded.find((item) => item.name === "shell")?.inputSchema.properties)
      .toHaveProperty("skillScript");
    expect(loaded.some((item) => item.name === "validate")).toBe(false);
    expect(loaded.some((item) => item.name === "process_spawn")).toBe(false);
    expect(loaded.find((item) => item.name === "shell")?.inputSchema.properties)
      .toHaveProperty("background");
    expect(loaded.find((item) => item.name === "shell")?.inputSchema.properties)
      .toHaveProperty("validation");
  });

  it("presents one scoped workspace-write field while retaining the recovery contract", () => {
    const tools = registerBuiltinTools(new EffectToolRegistry());
    const runtimeProperties = tools.descriptor("shell")?.inputSchema.properties;
    const modelShell = tools.modelDescriptors().find((item) => item.name === "shell");
    const modelProperties = modelShell?.inputSchema.properties;

    expect(runtimeProperties).toHaveProperty("access");
    expect(runtimeProperties).toHaveProperty("writeRoots");
    expect(runtimeProperties).toHaveProperty("expectedChanges");
    expect(modelProperties).not.toHaveProperty("access");
    expect(modelProperties).not.toHaveProperty("writeRoots");
    expect(modelProperties).toHaveProperty("expectedChanges");
    expect(modelShell?.description).toContain("process temp directory");

    const analyzeShell = projectModelToolDescriptors(tools.modelDescriptors(), {
      skillsAvailable: false,
      executableSkillResourcesLoaded: false,
      environmentMutationAvailable: false
    }).find((item) => item.name === "shell");
    expect(analyzeShell?.inputSchema.properties).not.toHaveProperty("expectedChanges");
    expect(analyzeShell?.description).not.toContain("provide expectedChanges");
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
      executableSkillResourcesLoaded: false,
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
      executableSkillResourcesLoaded: false,
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
    const projected = projectModelToolDescriptors(
      descriptors.filter((item) => item.name !== "shell"),
      {
        skillsAvailable: false,
        executableSkillResourcesLoaded: false
      }
    );
    expect(projected.some((item) => item.name === "exec")).toBe(true);
    expect(projected.find((item) => item.name === "exec")?.inputSchema.properties)
      .not.toHaveProperty("skill");
  });

  it("projects durable skills without widening frozen or profile capabilities", () => {
    const loaded = { qualifiedName: "home:loaded", executionManifestArtifactId: "a", executionManifestDigest: "b" };
    expect(sessionSkillProjectionCapabilities({
      frozenCustomization: { skills: [] },
      loadedSkills: [loaded]
    })).toEqual({ skillsAvailable: false, executableSkillResourcesLoaded: false });
    expect(sessionSkillProjectionCapabilities({
      frozenCustomization: { skills: [{ qualifiedName: "home:frozen" }] },
      loadedSkills: [],
      profileSkillNames: ["home:frozen"]
    })).toEqual({ skillsAvailable: true, executableSkillResourcesLoaded: false });
  });
});
