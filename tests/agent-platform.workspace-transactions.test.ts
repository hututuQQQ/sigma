import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
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

  it("checks canonical state containment before creating directories", async () => {
    const container = await temporaryRoot();
    const workspace = path.join(container, "workspace");
    const linkedWorkspace = path.join(container, "linked-workspace");
    const unintendedState = path.join(workspace, "unintended-state");
    await mkdir(workspace);
    const linked = await symlink(
      workspace,
      linkedWorkspace,
      process.platform === "win32" ? "junction" : "dir"
    ).then(() => true, () => false);
    if (!linked) return;
    const root = await workspaceTransactionRoot({
      workspacePath: workspace,
      stateRootDir: path.join(linkedWorkspace, "unintended-state"),
      namespace: "unit-transaction"
    });
    expect(path.relative(workspace, root).startsWith("..")).toBe(true);
    await expect(lstat(unintendedState)).rejects.toMatchObject({ code: "ENOENT" });
    await cleanupWorkspaceTransactionRoot(root);
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

  it.skipIf(process.platform !== "darwin")(
    "accepts a state root beneath the macOS system /var alias",
    async () => {
      const aliasInfo = await lstat("/var");
      if (!aliasInfo.isSymbolicLink()) return;
      expect(aliasInfo.uid).toBe(0);
      await expect(realpath("/var")).resolves.toBe("/private/var");

      const container = await mkdtemp(path.join("/var", "tmp", "sigma-system-alias-"));
      temporaryRoots.add(container);
      const workspace = path.join(container, "workspace");
      const state = path.join(container, "state");
      await mkdir(workspace);
      const root = await workspaceTransactionRoot({
        workspacePath: workspace, stateRootDir: state, namespace: "unit-transaction"
      });
      expect(root.startsWith("/private/var/")).toBe(true);
      await cleanupWorkspaceTransactionRoot(root);
    }
  );

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

  it("reads only stable direct regular-file children through a directory lease", async () => {
    const container = await temporaryRoot();
    const root = path.join(container, "transaction");
    await mkdir(root);
    await writeFile(path.join(root, "value.txt"), "leased value\n", "utf8");
    const lease = await pinWorkspaceTransactionDirectories([root]);
    const signal = new AbortController().signal;
    try {
      await expect(lease.readDirectoryFile(root, "value.txt", 1024, signal)).resolves
        .toEqual({ bytes: Buffer.from("leased value\n"), rejected: false });
      await expect(lease.readDirectoryFile(root, "missing.txt", 1024, signal)).resolves
        .toEqual({ bytes: null, rejected: false });
      await expect(lease.readDirectoryFile(root, "../value.txt", 1024, signal)).rejects
        .toMatchObject({ code: "workspace_transaction_root_unavailable" });
    } finally {
      await lease.close();
    }
    await expect(lease.readDirectoryFile(root, "value.txt", 1024, signal)).rejects
      .toMatchObject({ code: "workspace_transaction_root_unavailable" });
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
