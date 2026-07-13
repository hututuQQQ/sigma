import { lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupWorkspaceTransactionRoot,
  pinWorkspaceTransactionDirectories,
  workspaceTransactionRoot
} from "../packages/agent-platform/src/workspace-transaction-root.js";

const temporaryRoots = new Set<string>();

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "sigma-transaction-root-"));
  temporaryRoots.add(root);
  return root;
}

afterEach(async () => {
  await Promise.all([...temporaryRoots].map(async (root) => await rm(root, { recursive: true, force: true })));
  temporaryRoots.clear();
});

describe("workspace transaction roots", () => {
  it("uses external state and removes empty owned transaction containers", async () => {
    const container = await temporaryRoot();
    const workspace = path.join(container, "workspace");
    const state = path.join(container, "state");
    await mkdir(workspace);
    const root = await workspaceTransactionRoot({
      workspacePath: workspace, stateRootDir: state, namespace: "unit-transaction"
    });
    expect(path.relative(workspace, root).startsWith("..")).toBe(true);
    await cleanupWorkspaceTransactionRoot(root);
    await expect(lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(path.join(state, "transactions"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("falls back beside the workspace without touching user .agent content", async () => {
    const container = await temporaryRoot();
    const workspace = path.join(container, "workspace");
    const agent = path.join(workspace, ".agent");
    await mkdir(agent, { recursive: true });
    await writeFile(path.join(agent, "config.toml"), "user = true\n", "utf8");
    const root = await workspaceTransactionRoot({
      workspacePath: workspace,
      stateRootDir: path.join(agent, "internal-state"),
      namespace: "unit-transaction"
    });
    const fallback = path.dirname(root);
    expect(path.basename(fallback)).toMatch(/^\.sigma-transactions-/u);
    await cleanupWorkspaceTransactionRoot(root);
    await expect(lstat(fallback)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(agent, "config.toml"), "utf8")).resolves.toBe("user = true\n");
    await expect(lstat(path.join(agent, "internal-state"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a preexisting linked state root", async () => {
    const container = await temporaryRoot();
    const workspace = path.join(container, "workspace");
    const outside = path.join(container, "outside");
    const state = path.join(container, "state-link");
    await mkdir(workspace);
    await mkdir(outside);
    const linked = await symlink(outside, state, process.platform === "win32" ? "junction" : "dir")
      .then(() => true, () => false);
    if (!linked) return;
    await expect(workspaceTransactionRoot({
      workspacePath: workspace, stateRootDir: state, namespace: "unit-transaction"
    })).rejects.toMatchObject({ code: "workspace_transaction_root_unavailable" });
  });

  it("detects a directory identity swap while a lease is active", async () => {
    const container = await temporaryRoot();
    const root = path.join(container, "transaction");
    const displaced = path.join(container, "transaction-old");
    await mkdir(root);
    const lease = await pinWorkspaceTransactionDirectories([root]);
    try {
      const moved = await rename(root, displaced).then(() => true, () => false);
      if (!moved) {
        await expect(lstat(root)).resolves.toBeDefined();
        return;
      }
      await mkdir(root);
      await expect(lease.verify()).rejects.toMatchObject({
        code: "workspace_transaction_root_unavailable"
      });
    } finally {
      await lease.close();
    }
  });

  it("pins long Unicode Windows paths through namespaced directory handles", async () => {
    if (process.platform !== "win32") return;
    const container = await temporaryRoot();
    let root = path.join(container, "\u4e2d\u6587\u76ee\u5f55");
    for (let index = 0; root.length < 280; index += 1) {
      root = path.join(root, `segment-${index.toString().padStart(3, "0")}`);
    }
    await mkdir(path.toNamespacedPath(root), { recursive: true });
    expect(root.length).toBeGreaterThan(260);
    const lease = await pinWorkspaceTransactionDirectories([root]);
    try {
      await expect(lease.verify()).resolves.toBeUndefined();
    } finally {
      await lease.close();
    }
  });
});
