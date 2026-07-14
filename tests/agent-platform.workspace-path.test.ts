import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalWorkspacePath } from "../packages/agent-platform/src/workspace.js";

const temporaryRoots = new Set<string>();

afterEach(async () => {
  await Promise.all([...temporaryRoots].map(async (root) => await rm(root, { recursive: true, force: true })));
  temporaryRoots.clear();
});

describe("canonical workspace paths", () => {
  it("uses a stable path_escape diagnostic for lexical escapes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-workspace-path-"));
    temporaryRoots.add(root);

    await expect(canonicalWorkspacePath(root, path.join(root, "..", "outside"))).rejects.toMatchObject({
      code: "path_escape"
    });
  });

  it("uses the same diagnostic for links that resolve outside the workspace", async () => {
    const container = await mkdtemp(path.join(os.tmpdir(), "sigma-workspace-link-"));
    temporaryRoots.add(container);
    const root = path.join(container, "workspace");
    const outside = path.join(container, "outside");
    await mkdir(root);
    await mkdir(outside);
    const linked = await symlink(outside, path.join(root, "linked"), process.platform === "win32" ? "junction" : "dir")
      .then(() => true, () => false);
    if (!linked) return;

    await expect(canonicalWorkspacePath(root, "linked/file.txt")).rejects.toMatchObject({ code: "path_escape" });
  });
});
