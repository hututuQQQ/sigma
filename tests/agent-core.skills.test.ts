import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { formatSelectedSkills } from "../packages/agent-core/src/skills/format-skills.js";
import { loadAllSkills, loadWorkspaceSkills } from "../packages/agent-core/src/skills/load-skills.js";
import { retrieveSkills } from "../packages/agent-core/src/skills/retrieve-skills.js";

async function tempWorkspace(): Promise<string> {
  return await mkdtemp(path.join(os.tmpdir(), "sigma-skills-"));
}

describe("skills", () => {
  it("loads built-in skills", async () => {
    const dir = await tempWorkspace();
    const skills = await loadAllSkills(dir);

    expect(skills.map((skill) => skill.name)).toContain("node-typescript");
    expect(skills.map((skill) => skill.name)).toContain("python-packaging-and-pytest");
  });

  it("loads workspace skills from .agent/skills", async () => {
    const dir = await tempWorkspace();
    await mkdir(path.join(dir, ".agent", "skills"), { recursive: true });
    await writeFile(
      path.join(dir, ".agent", "skills", "custom.md"),
      [
        "name: custom-data",
        "triggers: feather, parquet",
        "summary: Handle local data files.",
        "",
        "## inspect",
        "- Check schema",
        "## implement",
        "- Keep conversion deterministic",
        "## verify",
        "- Parse the output"
      ].join("\n"),
      "utf8"
    );

    const skills = await loadWorkspaceSkills(dir);

    expect(skills).toEqual([
      expect.objectContaining({
        name: "custom-data",
        triggers: ["feather", "parquet"],
        inspectSteps: ["Check schema"],
        source: "workspace"
      })
    ]);
  });

  it("retrieves skills by trigger and project hints", async () => {
    const dir = await tempWorkspace();
    const skills = await loadAllSkills(dir);
    const selected = retrieveSkills(skills, {
      instruction: "Fix the TypeScript package tests",
      projectHints: ["package.json", "typescript"]
    });

    expect(selected[0].name).toBe("node-typescript");
  });

  it("respects max char budget when formatting", async () => {
    const dir = await tempWorkspace();
    const skills = await loadAllSkills(dir);
    const formatted = formatSelectedSkills(skills.slice(0, 3), 500);

    expect(formatted.length).toBeLessThanOrEqual(500);
  });

  it("tolerates malformed workspace skill files", async () => {
    const dir = await tempWorkspace();
    await mkdir(path.join(dir, ".agent", "skills"), { recursive: true });
    await writeFile(path.join(dir, ".agent", "skills", "broken.md"), "---\n::::\n", "utf8");

    await expect(loadWorkspaceSkills(dir)).resolves.toEqual([
      expect.objectContaining({ name: "broken", source: "workspace" })
    ]);
  });
});
