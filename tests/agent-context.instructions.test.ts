import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadNestedInstructions } from "../packages/agent-context/src/instructions.js";

const temporaryRoots = new Set<string>();

afterEach(async () => {
  await Promise.all([...temporaryRoots].map(async (root) => await rm(root, { recursive: true, force: true })));
  temporaryRoots.clear();
});

describe("nested project instructions", () => {
  it("finds instructions for an extensionless file target", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-instructions-"));
    temporaryRoots.add(workspace);
    await mkdir(path.join(workspace, "src"));
    await writeFile(path.join(workspace, "src", "AGENTS.md"), "Use the project conventions.\n", "utf8");
    await writeFile(path.join(workspace, "src", "Makefile"), "all:\n", "utf8");

    await expect(loadNestedInstructions({ workspacePath: workspace, targetPath: "src/Makefile" })).resolves.toEqual([
      expect.objectContaining({ provenance: "src/AGENTS.md" })
    ]);
  });
});
