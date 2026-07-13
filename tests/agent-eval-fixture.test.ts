import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  generateRepoScaleFixtureV1,
  REPO_SCALE_PROFILE_V1
} from "../scripts/eval/fixture-generator.mjs";
import { evaluatorLinkTargetRoot, seedWorkspace, snapshotWorkspace } from "../scripts/eval/workspace.mjs";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function filesBelow(directory: string): Promise<string[]> {
  const result: string[] = [];
  async function visit(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) result.push(absolute);
    }
  }
  await visit(directory);
  return result;
}

describe("agent evaluation fixture realism", () => {
  it("deterministically generates 500 multilingual files and 90,000 physical lines", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-repo-scale-"));
    temporary.push(root);
    const profile = await generateRepoScaleFixtureV1(root, {
      kind: "repo-scale-v1", seed: 20260714, fileCount: 500, lineCount: 90_000
    });
    expect(profile).toMatchObject(REPO_SCALE_PROFILE_V1);

    const files = await filesBelow(root);
    expect(files).toHaveLength(500);
    let physicalLines = 0;
    const extensionCounts = new Map<string, number>();
    for (const file of files) {
      const content = await readFile(file, "utf8");
      physicalLines += content.split(/\r?\n/u).length - 1;
      const extension = path.extname(file);
      extensionCounts.set(extension, (extensionCounts.get(extension) ?? 0) + 1);
    }
    expect(physicalLines).toBe(90_000);
    expect(Object.fromEntries(extensionCounts)).toEqual({ ".rs": 60, ".js": 160, ".py": 80, ".ts": 200 });
    await expect(readFile(path.join(root, "src/typescript/unicode-统计.ts"), "utf8")).resolves.toContain("σ-typescript-1");
    await expect(readFile(path.join(root, "src/typescript/typescript-002.ts"), "utf8")).resolves.toContain("\r\n");
  });

  it("creates valid and dangling evaluator-only directory links without following them", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-link-fixture-"));
    temporary.push(root);
    const fixture = path.join(root, "fixture");
    await mkdir(path.join(fixture, "target"), { recursive: true });
    await writeFile(path.join(fixture, "target", "value.txt"), "value\n", "utf8");
    const workspace = await seedWorkspace({
      attemptRoot: path.join(root, "attempt"),
      fixtureDirectory: fixture,
      setupAfterCommit: [
        { type: "link", path: "links/valid", target: "target", linkKind: "directory" },
        { type: "link", path: "links/dangling", target: "absent/target", linkKind: "directory" },
        {
          type: "link", path: "links/outside", target: "external/target", linkKind: "directory",
          targetScope: "outside_workspace", targetExists: true
        }
      ]
    });
    await expect(lstat(path.join(workspace, "links", "valid"))).resolves.toMatchObject({});
    await expect(lstat(path.join(workspace, "links", "dangling"))).resolves.toMatchObject({});
    expect(await readlink(path.join(workspace, "links", "valid"))).toBeTruthy();
    expect(await readlink(path.join(workspace, "links", "dangling"))).toBeTruthy();
    await expect(readFile(path.join(workspace, "links", "valid", "value.txt"), "utf8")).resolves.toBe("value\n");
    await expect(readFile(path.join(workspace, "links", "dangling", "value.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(path.join(workspace, "links", "outside"))).resolves.toMatchObject({});
    const snapshot = await snapshotWorkspace(workspace, { linkTargetRoots: [
      { root: workspace, label: "workspace" },
      { root: evaluatorLinkTargetRoot(path.join(root, "attempt")), label: "outside_workspace" }
    ] });
    expect(snapshot["links/outside"]).toEqual({
      kind: "symlink", target: "outside_workspace:external/target"
    });
  });
});
