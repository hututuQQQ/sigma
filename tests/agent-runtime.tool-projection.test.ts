import { describe, expect, it } from "vitest";
import { registerBuiltinTools, EffectToolRegistry } from "../packages/agent-tools/src/index.js";
import {
  projectModelToolDescriptors,
  sessionSkillProjectionCapabilities
} from "../packages/agent-runtime/src/effect-helpers.js";

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
});
