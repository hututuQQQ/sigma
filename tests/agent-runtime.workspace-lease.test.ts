import { mkdir, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { WorkspaceMutationLease } from "../packages/agent-runtime/src/workspace-mutation-lease.js";

describe("cross-process workspace mutation lease", () => {
  it("serializes independent runtime lease instances for one canonical workspace", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-runtime-workspace-lease-"));
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let firstEntered!: () => void;
    const entered = new Promise<void>((resolve) => { firstEntered = resolve; });
    const first = new WorkspaceMutationLease().withLease(workspace, undefined, async () => {
      firstEntered();
      await firstGate;
    });
    await entered;
    let secondEntered = false;
    const second = new WorkspaceMutationLease().withLease(workspace, undefined, async () => {
      secondEntered = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(secondEntered).toBe(false);
    releaseFirst();
    await Promise.all([first, second]);
    expect(secondEntered).toBe(true);
  });
});
