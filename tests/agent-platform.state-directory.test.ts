import { chmod, lstat, mkdir, mkdtemp, rm, stat, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanupWorkspaceTransactionRoot,
  ensurePrivateStateDirectory,
  WorkspaceTransactionCleanupWarning,
  WorkspaceTransactionRootError,
  workspaceTransactionRoot
} from "../packages/agent-platform/src/index.js";
import {
  createConfiguredRuntime,
  type RuntimeCompositionConfig
} from "../packages/agent-runtime/src/testing.js";

const temporaryRoots: string[] = [];

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

async function installDirectoryLink(target: string, link: string): Promise<boolean> {
  try {
    await symlink(target, link, process.platform === "win32" ? "junction" : "dir");
    return true;
  } catch (error) {
    if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") return false;
    throw error;
  }
}

function runtimeConfig(workspace: string): RuntimeCompositionConfig {
  return {
    workspace,
    provider: "deepseek",
    model: "deepseek-v4-pro",
    permissionMode: "deny",
    runDeadlineSec: 30,
    modelDeadlineSec: 10,
    streamIdleSec: 5,
    maxParallelTools: 1,
    maxParallelAgents: 1,
    mcpServers: [],
    mcpSource: "none"
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of temporaryRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("private state directory boundaries", () => {
  it("rejects a linked ancestor instead of traversing it", async () => {
    const root = await temporaryRoot("sigma-private-state-link-");
    const outside = path.join(root, "outside");
    const linkedParent = path.join(root, "linked-parent");
    await mkdir(outside);
    if (!await installDirectoryLink(outside, linkedParent)) return;

    await expect(ensurePrivateStateDirectory(path.join(linkedParent, "state")))
      .rejects.toThrow(/unsafe directory entry|reparse point/iu);
    await expect(lstat(path.join(outside, "state"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.skipIf(process.platform === "win32")(
    "creates managed directories as owner-only and rejects broad existing permissions",
    async () => {
      const root = await temporaryRoot("sigma-private-state-mode-");
      const state = path.join(root, "nested", "state");
      const canonical = await ensurePrivateStateDirectory(state);
      expect((await stat(canonical)).mode & 0o777).toBe(0o700);
      expect((await stat(path.dirname(canonical))).mode & 0o777).toBe(0o700);

      await chmod(canonical, 0o750);
      await expect(ensurePrivateStateDirectory(canonical))
        .rejects.toThrow(/unsafe ownership or permissions/iu);
    }
  );

  it.skipIf(process.platform === "win32")(
    "requires an existing managed directory to belong to the current uid",
    async () => {
      const root = await temporaryRoot("sigma-private-state-owner-");
      const state = await ensurePrivateStateDirectory(path.join(root, "state"));
      vi.spyOn(process, "getuid").mockReturnValue(process.getuid() + 1);
      await expect(ensurePrivateStateDirectory(state))
        .rejects.toThrow(/unsafe ownership or permissions/iu);
    }
  );

  it("applies the ancestor-link boundary to workspace transaction roots", async () => {
    const root = await temporaryRoot("sigma-transaction-state-link-");
    const workspace = path.join(root, "workspace");
    const outside = path.join(root, "outside");
    const linkedParent = path.join(root, "linked-state");
    await mkdir(workspace);
    await mkdir(outside);
    if (!await installDirectoryLink(outside, linkedParent)) return;

    await expect(workspaceTransactionRoot({
      workspacePath: workspace,
      stateRootDir: path.join(linkedParent, "state"),
      namespace: "neutral-test"
    })).rejects.toBeInstanceOf(WorkspaceTransactionRootError);
    await expect(lstat(path.join(outside, "state"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("applies the ancestor-link boundary to configured runtime state", async () => {
    const root = await temporaryRoot("sigma-runtime-state-link-");
    const workspace = path.join(root, "workspace");
    const outside = path.join(root, "outside");
    const linkedParent = path.join(root, "linked-state");
    await mkdir(workspace);
    await mkdir(outside);
    if (!await installDirectoryLink(outside, linkedParent)) return;

    await expect(createConfiguredRuntime(runtimeConfig(workspace), {
      stateRootDir: path.join(linkedParent, "state")
    }, { connectMcp: false })).rejects.toThrow(/unsafe directory entry|reparse point/iu);
    await expect(lstat(path.join(outside, "state"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects configured runtime state inside the workspace before creating it", async () => {
    const root = await temporaryRoot("sigma-runtime-state-containment-");
    const workspace = path.join(root, "workspace");
    const state = path.join(workspace, "state");
    await mkdir(workspace);

    await expect(createConfiguredRuntime(runtimeConfig(workspace), {
      stateRootDir: state
    }, { connectMcp: false })).rejects.toThrow("Runtime state root must be outside the workspace.");
    await expect(lstat(state)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("returns cleanup warnings without replacing an active failure", async () => {
    const root = await temporaryRoot("sigma-transaction-cleanup-warning-");
    const invalidPath = `${root}\0invalid`;
    const warnings = await cleanupWorkspaceTransactionRoot(invalidPath);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toBeInstanceOf(WorkspaceTransactionCleanupWarning);

    const primary = new Error("primary failure");
    let observed: unknown;
    try {
      try {
        throw primary;
      } finally {
        await cleanupWorkspaceTransactionRoot(invalidPath);
      }
    } catch (error) {
      observed = error;
    }
    expect(observed).toBe(primary);
  });
});
