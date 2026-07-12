import {
  chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rename, rm, symlink, writeFile
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CheckpointConflictError,
  CheckpointLimitError,
  CheckpointManager,
  CheckpointRecoveryError
} from "../packages/agent-checkpoint/src/index.js";
import {
  captureCheckpointManifest,
  preflightCheckpointByteReservation
} from "../packages/agent-checkpoint/src/safe-capture.js";
import { workspaceTransactionRoot } from "../packages/agent-platform/src/workspace-transaction-root.js";

const checkpointTemporaryRoots = new Set<string>();

async function checkpointTemporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  checkpointTemporaryRoots.add(root);
  return root;
}

afterEach(async () => {
  const roots = [...checkpointTemporaryRoots];
  checkpointTemporaryRoots.clear();
  await Promise.all(roots.map(async (root) => {
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
  }));
});

async function fixture(): Promise<{ root: string; workspace: string; manager: CheckpointManager }> {
  const root = await checkpointTemporaryRoot("sigma-checkpoint-");
  const workspace = path.join(root, "workspace");
  await mkdir(path.join(workspace, ".git"), { recursive: true });
  await writeFile(path.join(workspace, "existing.txt"), "before", "utf8");
  await writeFile(path.join(workspace, "deleted.txt"), "keep me", "utf8");
  await writeFile(path.join(workspace, ".git", "protected"), "user state", "utf8");
  return { root, workspace, manager: new CheckpointManager({ rootDir: path.join(root, "state") }) };
}

async function checkpointTransactionRoot(root: string, workspacePath: string): Promise<string> {
  return await workspaceTransactionRoot({
    workspacePath,
    stateRootDir: path.join(root, "state"),
    namespace: "checkpoint-restore"
  });
}

async function checkpointFileImage(target: string): Promise<{
  kind: "file";
  mode: number;
  size: number;
  digest: string;
}> {
  const [info, content] = await Promise.all([lstat(target), readFile(target)]);
  return {
    kind: "file",
    mode: info.mode,
    size: content.byteLength,
    digest: createHash("sha256").update(content).digest("hex")
  };
}

function validRecoveryFinalization(workspacePath: string, digest = "0".repeat(64)) {
  const now = new Date().toISOString();
  return {
    desiredManifestDigest: digest,
    record: {
      schemaVersion: 1 as const,
      checkpointId: "recovery-checkpoint",
      sessionId: "recovery-session",
      runId: "recovery-run",
      status: "restored" as const,
      workspacePath,
      scopePaths: ["existing.txt"],
      baseSeq: 0,
      createdAt: now,
      restoredAt: now,
      preManifestDigest: digest
    }
  };
}

describe("CheckpointManager", () => {
  it("seals a delta and restores the exact preimage", async () => {
    const { workspace, manager } = await fixture();
    const checkpoint = await manager.create({
      sessionId: "session-1",
      runId: "run-1",
      workspacePath: workspace,
      scopePaths: ["."],
      baseSeq: 7
    });
    await writeFile(path.join(workspace, "existing.txt"), "after", "utf8");
    await writeFile(path.join(workspace, "added.txt"), "new", "utf8");
    await rm(path.join(workspace, "deleted.txt"));
    await writeFile(path.join(workspace, ".git", "protected"), "changed outside checkpoint", "utf8");

    const sealed = await manager.seal(checkpoint.sessionId, checkpoint.checkpointId);
    expect(sealed.status).toBe("sealed");
    expect(sealed.delta).toEqual({
      added: ["added.txt"],
      modified: ["existing.txt"],
      deleted: ["deleted.txt"]
    });
    await expect(manager.reviewDiff(checkpoint.sessionId, checkpoint.checkpointId)).resolves.toContain("[before]\nbefore\n[after]\nafter");

    const restored = await manager.undoLatest(checkpoint.sessionId);
    expect(restored.status).toBe("restored");
    await expect(readFile(path.join(workspace, "existing.txt"), "utf8")).resolves.toBe("before");
    await expect(readFile(path.join(workspace, "deleted.txt"), "utf8")).resolves.toBe("keep me");
    await expect(readFile(path.join(workspace, "added.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(workspace, ".git", "protected"), "utf8")).resolves.toBe("changed outside checkpoint");
    await expect(lstat(path.join(workspace, ".agent"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a conflicting undo before changing files", async () => {
    const { workspace, manager } = await fixture();
    const checkpoint = await manager.create({
      sessionId: "session-2", runId: "run-2", workspacePath: workspace, scopePaths: ["existing.txt"], baseSeq: 0
    });
    await writeFile(path.join(workspace, "existing.txt"), "sealed", "utf8");
    await manager.seal(checkpoint.sessionId, checkpoint.checkpointId);
    await writeFile(path.join(workspace, "existing.txt"), "user edit", "utf8");

    await expect(manager.undoLatest(checkpoint.sessionId)).rejects.toBeInstanceOf(CheckpointConflictError);
    await expect(readFile(path.join(workspace, "existing.txt"), "utf8")).resolves.toBe("user edit");
  });

  it("validates every desired CAS object before starting any workspace mutation", async () => {
    const { root, workspace, manager } = await fixture();
    const checkpoint = await manager.create({
      sessionId: "session-corrupt-cas", runId: "run-corrupt-cas",
      workspacePath: workspace, scopePaths: ["existing.txt", "deleted.txt"], baseSeq: 0
    });
    await writeFile(path.join(workspace, "existing.txt"), "after existing", "utf8");
    await writeFile(path.join(workspace, "deleted.txt"), "after deleted", "utf8");
    await manager.seal(checkpoint.sessionId, checkpoint.checkpointId);
    const manifest = JSON.parse(await readFile(
      path.join(root, "state", "checkpoints", "cas", checkpoint.preManifestDigest),
      "utf8"
    )) as { entries: Array<{ path: string; digest?: string }> };
    const desired = manifest.entries.find((entry) => entry.path === "deleted.txt")!;
    await writeFile(path.join(root, "state", "checkpoints", "cas", desired.digest!), "corrupt", "utf8");

    await expect(manager.undoLatest(checkpoint.sessionId)).rejects.toBeInstanceOf(CheckpointConflictError);
    await expect(readFile(path.join(workspace, "existing.txt"), "utf8")).resolves.toBe("after existing");
    await expect(readFile(path.join(workspace, "deleted.txt"), "utf8")).resolves.toBe("after deleted");
    await expect(lstat(path.join(workspace, ".agent"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports changed open checkpoints and enforces preimage limits", async () => {
    const { root, workspace, manager } = await fixture();
    const checkpoint = await manager.create({
      sessionId: "session-3", runId: "run-3", workspacePath: workspace, scopePaths: ["existing.txt"], baseSeq: 0
    });
    await writeFile(path.join(workspace, "existing.txt"), "partial write", "utf8");
    const inspection = await manager.inspectOpen(checkpoint.sessionId, checkpoint.checkpointId);
    expect(inspection.changed).toBe(true);
    expect(inspection.delta.modified).toEqual(["existing.txt"]);

    const limited = new CheckpointManager({ rootDir: path.join(root, "limited"), maxBytes: 2 });
    await expect(limited.create({
      sessionId: "session-4", runId: "run-4", workspacePath: workspace, scopePaths: ["existing.txt"], baseSeq: 0
    })).rejects.toBeInstanceOf(CheckpointLimitError);
  });

  it("undoes sealed checkpoints strictly in LIFO order", async () => {
    const { workspace, manager } = await fixture();
    const first = await manager.create({
      sessionId: "session-lifo", runId: "run-lifo", workspacePath: workspace,
      scopePaths: ["existing.txt"], baseSeq: 1
    });
    await writeFile(path.join(workspace, "existing.txt"), "first postimage", "utf8");
    await manager.seal(first.sessionId, first.checkpointId);
    const second = await manager.create({
      sessionId: "session-lifo", runId: "run-lifo", workspacePath: workspace,
      scopePaths: ["existing.txt"], baseSeq: 2
    });
    await writeFile(path.join(workspace, "existing.txt"), "second postimage", "utf8");
    await manager.seal(second.sessionId, second.checkpointId);

    await expect(manager.undoLatest(first.sessionId)).resolves.toMatchObject({ checkpointId: second.checkpointId });
    await expect(readFile(path.join(workspace, "existing.txt"), "utf8")).resolves.toBe("first postimage");
    await expect(manager.undoLatest(first.sessionId)).resolves.toMatchObject({ checkpointId: first.checkpointId });
    await expect(readFile(path.join(workspace, "existing.txt"), "utf8")).resolves.toBe("before");
  });

  it("never skips a newer open checkpoint to undo an older sealed checkpoint", async () => {
    const { workspace, manager } = await fixture();
    const sealed = await manager.create({
      sessionId: "session-open-head", runId: "run-open-head", workspacePath: workspace,
      scopePaths: ["existing.txt"], baseSeq: 1
    });
    await writeFile(path.join(workspace, "existing.txt"), "sealed postimage", "utf8");
    await manager.seal(sealed.sessionId, sealed.checkpointId);
    await manager.create({
      sessionId: "session-open-head", runId: "run-open-head", workspacePath: workspace,
      scopePaths: ["existing.txt"], baseSeq: 2
    });
    await writeFile(path.join(workspace, "existing.txt"), "partial mutation", "utf8");

    await expect(manager.undoLatest(sealed.sessionId)).rejects.toBeInstanceOf(CheckpointConflictError);
    await expect(readFile(path.join(workspace, "existing.txt"), "utf8")).resolves.toBe("partial mutation");
  });

  it("restores an open checkpoint only if its recovery postimage is unchanged", async () => {
    const { workspace, manager } = await fixture();
    const checkpoint = await manager.create({
      sessionId: "session-open-restore", runId: "run-open-restore", workspacePath: workspace,
      scopePaths: ["existing.txt"], baseSeq: 1
    });
    await writeFile(path.join(workspace, "existing.txt"), "partial mutation", "utf8");
    const offered = await manager.inspectOpen(checkpoint.sessionId, checkpoint.checkpointId);
    await writeFile(path.join(workspace, "existing.txt"), "edit after prompt", "utf8");

    await expect(manager.restoreOpen(
      checkpoint.sessionId,
      checkpoint.checkpointId,
      offered.currentManifestDigest
    )).rejects.toBeInstanceOf(CheckpointConflictError);
    await expect(readFile(path.join(workspace, "existing.txt"), "utf8")).resolves.toBe("edit after prompt");

    const refreshed = await manager.inspectOpen(checkpoint.sessionId, checkpoint.checkpointId);
    await expect(manager.restoreOpen(
      checkpoint.sessionId,
      checkpoint.checkpointId,
      refreshed.currentManifestDigest
    )).resolves.toMatchObject({ status: "restored" });
    await expect(readFile(path.join(workspace, "existing.txt"), "utf8")).resolves.toBe("before");
  });

  it("round-trips non-Git binary content, file modes, and safe symlinks", async () => {
    const root = await checkpointTemporaryRoot("sigma-checkpoint-nongit-");
    const workspace = path.join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    const binary = path.join(workspace, "data.bin");
    const executable = path.join(workspace, "tool.sh");
    await writeFile(binary, Buffer.from([0, 1, 2, 255]));
    await writeFile(executable, "#!/bin/sh\nexit 0\n", "utf8");
    if (process.platform !== "win32") await chmod(executable, 0o744);
    const link = path.join(workspace, "tool-link");
    const hasSymlink = await symlink("tool.sh", link, "file").then(() => true, () => false);
    const manager = new CheckpointManager({ rootDir: path.join(root, "state") });
    const checkpoint = await manager.create({
      sessionId: "session-nongit", runId: "run-nongit", workspacePath: workspace,
      scopePaths: ["."], baseSeq: 0
    });

    await writeFile(binary, Buffer.from([9, 8, 7]));
    if (process.platform !== "win32") await chmod(executable, 0o600);
    if (hasSymlink) {
      await rm(link);
      await symlink("data.bin", link, "file");
    }
    await manager.seal(checkpoint.sessionId, checkpoint.checkpointId);
    await manager.undoLatest(checkpoint.sessionId);

    expect(await readFile(binary)).toEqual(Buffer.from([0, 1, 2, 255]));
    if (process.platform !== "win32") expect((await lstat(executable)).mode & 0o777).toBe(0o744);
    if (hasSymlink) expect(await readlink(link)).toBe("tool.sh");
  });

  it("rejects an explicit scope whose parent link escapes the workspace", async () => {
    const { root, workspace, manager } = await fixture();
    const outside = path.join(root, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "secret.txt"), "must-not-enter-cas", "utf8");
    const linked = path.join(workspace, "linked");
    const created = await symlink(outside, linked, process.platform === "win32" ? "junction" : "dir")
      .then(() => true, () => false);
    if (!created) return;
    await expect(manager.create({
      sessionId: "session-linked-scope",
      runId: "run-linked-scope",
      workspacePath: workspace,
      scopePaths: ["linked/secret.txt"],
      baseSeq: 0
    })).rejects.toBeInstanceOf(CheckpointConflictError);
    await expect(manager.list("session-linked-scope")).resolves.toEqual([]);
  });

  it("replaces a postimage link with the preimage directory before restoring children", async () => {
    const { root, workspace, manager } = await fixture();
    const directory = path.join(workspace, "tree");
    const outside = path.join(root, "restore-outside");
    await mkdir(directory);
    await mkdir(outside);
    await writeFile(path.join(directory, "inside.txt"), "preimage", "utf8");
    await writeFile(path.join(outside, "sentinel.txt"), "outside", "utf8");
    const checkpoint = await manager.create({
      sessionId: "session-link-restore", runId: "run-link-restore",
      workspacePath: workspace, scopePaths: ["tree"], baseSeq: 0
    });
    await rm(directory, { recursive: true });
    const linked = await symlink(outside, directory, process.platform === "win32" ? "junction" : "dir")
      .then(() => true, () => false);
    if (!linked) return;
    await manager.seal(checkpoint.sessionId, checkpoint.checkpointId);
    await manager.undoLatest(checkpoint.sessionId);
    expect((await lstat(directory)).isDirectory()).toBe(true);
    expect((await lstat(directory)).isSymbolicLink()).toBe(false);
    await expect(readFile(path.join(directory, "inside.txt"), "utf8")).resolves.toBe("preimage");
    await expect(readFile(path.join(outside, "sentinel.txt"), "utf8")).resolves.toBe("outside");
    await expect(readFile(path.join(outside, "inside.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rolls back every installed path when a multi-file restore fails midway", async () => {
    const { root, workspace, manager } = await fixture();
    await writeFile(path.join(workspace, "second.txt"), "second before", "utf8");
    const checkpoint = await manager.create({
      sessionId: "session-transaction-failure", runId: "run-transaction-failure",
      workspacePath: workspace, scopePaths: ["existing.txt", "second.txt"], baseSeq: 1
    });
    await writeFile(path.join(workspace, "existing.txt"), "first after", "utf8");
    await writeFile(path.join(workspace, "second.txt"), "second after", "utf8");
    await manager.seal(checkpoint.sessionId, checkpoint.checkpointId);
    const transactional = new CheckpointManager({
      rootDir: path.join(root, "state"),
      restoreFaultInjector: ({ point, operationIndex }) => {
        if (point === "after_install" && operationIndex === 0) throw new Error("injected commit failure");
      }
    });

    await expect(transactional.undoLatest(checkpoint.sessionId)).rejects.toThrow("injected commit failure");
    await expect(readFile(path.join(workspace, "existing.txt"), "utf8")).resolves.toBe("first after");
    await expect(readFile(path.join(workspace, "second.txt"), "utf8")).resolves.toBe("second after");
    await expect(transactional.list(checkpoint.sessionId)).resolves.toContainEqual(expect.objectContaining({
      checkpointId: checkpoint.checkpointId,
      status: "sealed"
    }));
    await expect(lstat(path.join(workspace, ".agent"))).rejects.toMatchObject({ code: "ENOENT" });

    const beforeRecord = new CheckpointManager({
      rootDir: path.join(root, "state"),
      restoreFaultInjector: ({ point }) => {
        if (point === "before_record") throw new Error("injected record failure");
      }
    });
    await expect(beforeRecord.undoLatest(checkpoint.sessionId)).rejects.toThrow("injected record failure");
    await expect(readFile(path.join(workspace, "existing.txt"), "utf8")).resolves.toBe("first after");
    await expect(readFile(path.join(workspace, "second.txt"), "utf8")).resolves.toBe("second after");
    await expect(beforeRecord.list(checkpoint.sessionId)).resolves.toContainEqual(expect.objectContaining({ status: "sealed" }));
  });

  it("rechecks the complete current file image immediately before its backup rename", async () => {
    const { root, workspace, manager } = await fixture();
    const checkpoint = await manager.create({
      sessionId: "session-current-cas-race", runId: "run-current-cas-race",
      workspacePath: workspace, scopePaths: ["existing.txt"], baseSeq: 1
    });
    await writeFile(path.join(workspace, "existing.txt"), "after", "utf8");
    await manager.seal(checkpoint.sessionId, checkpoint.checkpointId);
    const transactional = new CheckpointManager({
      rootDir: path.join(root, "state"),
      restoreFaultInjector: async ({ point }) => {
        if (point === "before_backup_move") {
          await writeFile(path.join(workspace, "existing.txt"), "concurrent current image", "utf8");
        }
      }
    });

    await expect(transactional.undoLatest(checkpoint.sessionId)).rejects.toBeInstanceOf(CheckpointConflictError);
    await expect(readFile(path.join(workspace, "existing.txt"), "utf8")).resolves.toBe("concurrent current image");
  });

  it("does not clobber a current-absent target that appears at the install boundary", async () => {
    const { root, workspace, manager } = await fixture();
    const restoredPath = path.join(workspace, "restore-me.txt");
    await writeFile(restoredPath, "checkpoint preimage", "utf8");
    const checkpoint = await manager.create({
      sessionId: "session-absent-install-race", runId: "run-absent-install-race",
      workspacePath: workspace, scopePaths: ["restore-me.txt"], baseSeq: 1
    });
    await rm(restoredPath);
    await manager.seal(checkpoint.sessionId, checkpoint.checkpointId);
    const transactional = new CheckpointManager({
      rootDir: path.join(root, "state"),
      restoreFaultInjector: async ({ point }) => {
        if (point === "before_install_move") await writeFile(restoredPath, "concurrent owner", "utf8");
      }
    });

    await expect(transactional.undoLatest(checkpoint.sessionId)).rejects.toBeInstanceOf(CheckpointConflictError);
    await expect(readFile(restoredPath, "utf8")).resolves.toBe("concurrent owner");
  });

  it("never removes a concurrently replaced installed postimage during rollback", async () => {
    const { root, workspace, manager } = await fixture();
    const checkpoint = await manager.create({
      sessionId: "session-installed-race", runId: "run-installed-race",
      workspacePath: workspace, scopePaths: ["existing.txt"], baseSeq: 1
    });
    await writeFile(path.join(workspace, "existing.txt"), "after", "utf8");
    await manager.seal(checkpoint.sessionId, checkpoint.checkpointId);
    const transactional = new CheckpointManager({
      rootDir: path.join(root, "state"),
      restoreFaultInjector: async ({ point }) => {
        if (point === "after_install") {
          await writeFile(path.join(workspace, "existing.txt"), "concurrent postimage", "utf8");
          throw new Error("fail after concurrent replacement");
        }
      }
    });

    await expect(transactional.undoLatest(checkpoint.sessionId)).rejects.toBeInstanceOf(CheckpointRecoveryError);
    await expect(readFile(path.join(workspace, "existing.txt"), "utf8")).resolves.toBe("concurrent postimage");
  });

  it("replays a write-ahead journal after a crash between rename and completion recording", async () => {
    const { root, workspace, manager } = await fixture();
    const transactions = await checkpointTransactionRoot(root, workspace);
    const transaction = path.join(transactions, "restore-crash");
    await mkdir(path.join(transaction, "backup"), { recursive: true });
    await mkdir(path.join(transaction, "stage"), { recursive: true });
    await rename(path.join(workspace, "existing.txt"), path.join(transaction, "backup", "0"));
    await writeFile(path.join(workspace, "existing.txt"), "partially installed preimage", "utf8");
    const currentImage = await checkpointFileImage(path.join(transaction, "backup", "0"));
    const installedImage = await checkpointFileImage(path.join(workspace, "existing.txt"));
    await writeFile(path.join(transaction, "journal.json"), JSON.stringify({
      schemaVersion: 3,
      phase: "applying",
      finalization: validRecoveryFinalization(workspace),
      directoryModes: [],
      operations: [{
        path: "existing.txt", index: 0, hadCurrent: true, hasDesired: true,
        backupIntent: true, backupMoved: false, installIntent: true, installed: false,
        currentImage, installedImage
      }]
    }));

    await manager.create({
      sessionId: "session-crash-recovery", runId: "run-crash-recovery",
      workspacePath: workspace, scopePaths: ["existing.txt"], baseSeq: 0
    });

    await expect(readFile(path.join(workspace, "existing.txt"), "utf8")).resolves.toBe("before");
    await expect(lstat(transaction)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(path.join(workspace, ".agent"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    ["after installed removal", true, false, true, true],
    ["after backup restoration", false, true, true, true],
    ["while clearing recorded flags", false, true, false, false]
  ])("re-enters rollback idempotently %s", async (
    _label, keepBackup, keepTarget, installed, installIntent
  ) => {
    const { root, workspace, manager } = await fixture();
    const target = path.join(workspace, "existing.txt");
    const currentImage = await checkpointFileImage(target);
    const installedSource = path.join(root, "installed-image.txt");
    await writeFile(installedSource, "partially installed preimage", "utf8");
    const installedImage = await checkpointFileImage(installedSource);
    const transactions = await checkpointTransactionRoot(root, workspace);
    const transaction = path.join(transactions, `restore-second-crash-${keepBackup}-${keepTarget}`);
    await mkdir(path.join(transaction, "backup"), { recursive: true });
    await mkdir(path.join(transaction, "stage"), { recursive: true });
    if (keepBackup) await rename(target, path.join(transaction, "backup", "0"));
    if (!keepTarget && !keepBackup) await rm(target);
    await writeFile(path.join(transaction, "journal.json"), JSON.stringify({
      schemaVersion: 3,
      phase: "rolling_back",
      finalization: validRecoveryFinalization(workspace),
      directoryModes: [],
      operations: [{
        path: "existing.txt", index: 0, hadCurrent: true, hasDesired: true,
        backupIntent: true, backupMoved: true, installIntent, installed,
        currentImage, installedImage
      }]
    }));

    await manager.create({
      sessionId: `session-second-crash-${keepBackup}-${keepTarget}`,
      runId: "run-second-crash", workspacePath: workspace,
      scopePaths: ["existing.txt"], baseSeq: 0
    });
    await expect(readFile(target, "utf8")).resolves.toBe("before");
    await expect(lstat(transaction)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.skipIf(process.platform === "win32")("restores a pure directory mode change from a v3 recovery journal", async () => {
    const { root, workspace, manager } = await fixture();
    const directory = path.join(workspace, "mode-only");
    await mkdir(directory);
    await chmod(directory, 0o700);
    const currentMode = (await lstat(directory)).mode;
    await chmod(directory, 0o755);
    const desiredMode = (await lstat(directory)).mode;
    const transactions = await checkpointTransactionRoot(root, workspace);
    const transaction = path.join(transactions, "restore-mode-only");
    await mkdir(path.join(transaction, "backup"), { recursive: true });
    await mkdir(path.join(transaction, "stage"), { recursive: true });
    await writeFile(path.join(transaction, "journal.json"), JSON.stringify({
      schemaVersion: 3,
      phase: "applying",
      finalization: validRecoveryFinalization(workspace),
      directoryModes: [{ path: "mode-only", currentMode, desiredMode }],
      operations: []
    }));

    await manager.create({
      sessionId: "session-mode-recovery", runId: "run-mode-recovery",
      workspacePath: workspace, scopePaths: ["existing.txt"], baseSeq: 0
    });
    expect((await lstat(directory)).mode).toBe(currentMode);
  });

  it.each([
    ["coerced phase", ["applying"], validRecoveryFinalization],
    ["malformed finalization record", "applying", () => ({
      desiredManifestDigest: "0".repeat(64), record: []
    })]
  ])("rejects a v3 journal with %s", async (_label, phase, finalizationFactory) => {
    const { root, workspace, manager } = await fixture();
    const transactions = await checkpointTransactionRoot(root, workspace);
    const transaction = path.join(transactions, `restore-invalid-${String(_label).replaceAll(" ", "-")}`);
    await mkdir(path.join(transaction, "backup"), { recursive: true });
    await mkdir(path.join(transaction, "stage"), { recursive: true });
    await writeFile(path.join(transaction, "journal.json"), JSON.stringify({
      schemaVersion: 3,
      phase,
      finalization: finalizationFactory(workspace),
      directoryModes: [],
      operations: []
    }));

    await expect(manager.create({
      sessionId: "session-invalid-recovery", runId: "run-invalid-recovery",
      workspacePath: workspace, scopePaths: ["existing.txt"], baseSeq: 0
    })).rejects.toBeInstanceOf(CheckpointRecoveryError);
    await expect(readFile(path.join(workspace, "existing.txt"), "utf8")).resolves.toBe("before");
    await expect(lstat(transaction)).resolves.toBeDefined();
  });

  it("finalizes a schema v2 verified restore journal before the next checkpoint operation", async () => {
    const { root, workspace, manager } = await fixture();
    const checkpoint = await manager.create({
      sessionId: "session-verified-finalize", runId: "run-verified-finalize",
      workspacePath: workspace, scopePaths: ["existing.txt"], baseSeq: 1
    });
    await writeFile(path.join(workspace, "existing.txt"), "after", "utf8");
    const sealed = await manager.seal(checkpoint.sessionId, checkpoint.checkpointId);
    await writeFile(path.join(workspace, "existing.txt"), "before", "utf8");
    const restored = { ...sealed, status: "restored" as const, restoredAt: new Date().toISOString() };
    const transactions = await checkpointTransactionRoot(root, workspace);
    const transaction = path.join(transactions, "restore-verified");
    await mkdir(transaction, { recursive: true });
    await writeFile(path.join(transaction, "journal.json"), JSON.stringify({
      schemaVersion: 2,
      phase: "verified",
      finalization: { record: restored, desiredManifestDigest: sealed.preManifestDigest },
      operations: []
    }), "utf8");

    await manager.create({
      sessionId: checkpoint.sessionId, runId: "run-after-recovery",
      workspacePath: workspace, scopePaths: ["existing.txt"], baseSeq: 2
    });
    await expect(manager.list(checkpoint.sessionId)).resolves.toContainEqual(expect.objectContaining({
      checkpointId: checkpoint.checkpointId,
      status: "restored"
    }));
    await expect(lstat(transaction)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(path.join(workspace, ".agent"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("recovers finalization after a subprocess is killed at the verified boundary", async () => {
    const root = await checkpointTemporaryRoot("sigma-checkpoint-hard-crash-");
    const stateRoot = path.join(root, "state");
    const workspace = path.join(root, "workspace");
    const marker = path.join(root, "verified.marker");
    const fixturePath = path.resolve("tests", "fixtures", "checkpoint-verified-crash.mjs");
    const child = spawn(process.execPath, [fixturePath, stateRoot, workspace, marker], {
      cwd: path.resolve("."),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    await expect(readFile(marker, "utf8")).resolves.toBe("verified");
    expect(result.code === 0).toBe(false);
    expect(stderr).not.toContain("Error:");

    const transactions = await workspaceTransactionRoot({
      workspacePath: workspace,
      stateRootDir: stateRoot,
      namespace: "checkpoint-restore"
    });
    const manager = new CheckpointManager({ rootDir: stateRoot });
    await manager.create({
      sessionId: "session-verified-crash",
      runId: "run-after-hard-crash",
      workspacePath: workspace,
      scopePaths: ["target.txt"],
      baseSeq: 2
    });
    const records = await manager.list("session-verified-crash");
    expect(records[0]).toMatchObject({ status: "restored" });
    await expect(readFile(path.join(workspace, "target.txt"), "utf8")).resolves.toBe("before");
    await expect(lstat(transactions)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(path.join(workspace, ".agent"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never scans or applies a forged legacy journal from workspace .agent state", async () => {
    const { workspace, manager } = await fixture();
    const transaction = path.join(workspace, ".agent", "checkpoint-transactions", "restore-forged");
    await mkdir(path.join(transaction, "backup"), { recursive: true });
    await mkdir(path.join(transaction, "stage"), { recursive: true });
    await writeFile(path.join(transaction, "backup", "0"), "forged replacement", "utf8");
    const currentImage = await checkpointFileImage(path.join(transaction, "backup", "0"));
    const installedImage = await checkpointFileImage(path.join(workspace, "existing.txt"));
    await writeFile(path.join(transaction, "journal.json"), JSON.stringify({
      schemaVersion: 3,
      phase: "applying",
      finalization: {
        desiredManifestDigest: "0".repeat(64),
        record: { schemaVersion: 1, status: "restored" }
      },
      operations: [{
        path: "existing.txt", index: 0,
        backupIntent: true, backupMoved: true, installIntent: true, installed: true,
        currentImage, installedImage
      }]
    }), "utf8");

    await expect(manager.create({
      sessionId: "session-legacy-verified", runId: "run-legacy-verified",
      workspacePath: workspace, scopePaths: ["existing.txt"], baseSeq: 0
    })).resolves.toMatchObject({ status: "open" });
    await expect(readFile(path.join(workspace, "existing.txt"), "utf8")).resolves.toBe("before");
    await expect(lstat(transaction)).resolves.toBeDefined();
  });

  it("surfaces a typed recovery error and never marks restored when rollback itself fails", async () => {
    const { root, workspace, manager } = await fixture();
    const checkpoint = await manager.create({
      sessionId: "session-rollback-failure", runId: "run-rollback-failure",
      workspacePath: workspace, scopePaths: ["existing.txt"], baseSeq: 1
    });
    await writeFile(path.join(workspace, "existing.txt"), "after", "utf8");
    await manager.seal(checkpoint.sessionId, checkpoint.checkpointId);
    const transactional = new CheckpointManager({
      rootDir: path.join(root, "state"),
      restoreFaultInjector: ({ point }) => {
        if (point === "after_install") throw new Error("injected commit failure");
        if (point === "before_rollback_restore") throw new Error("injected rollback failure");
      }
    });
    const transactions = await checkpointTransactionRoot(root, workspace);

    const failure = await transactional.undoLatest(checkpoint.sessionId).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CheckpointRecoveryError);
    expect(failure).toMatchObject({ code: "checkpoint_recovery_failed" });
    await expect(transactional.list(checkpoint.sessionId)).resolves.toContainEqual(expect.objectContaining({
      checkpointId: checkpoint.checkpointId,
      status: "sealed"
    }));
    const retained = (await readdir(transactions)).find((name) => name.startsWith("restore-"));
    expect(retained).toBeTruthy();
    await expect(readFile(path.join(transactions, retained!, "journal.json"), "utf8")).resolves.toContain("rolling_back");
    await expect(lstat(path.join(workspace, ".agent"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("restores a preimage symlink over a real directory without mutating its external target", async () => {
    const { root, workspace, manager } = await fixture();
    const outside = path.join(root, "symlink-preimage-outside");
    const tree = path.join(workspace, "tree-preimage-link");
    await mkdir(outside);
    await writeFile(path.join(outside, "sentinel.txt"), "outside", "utf8");
    const linked = await symlink(outside, tree, process.platform === "win32" ? "junction" : "dir")
      .then(() => true, () => false);
    if (!linked) return;
    const checkpoint = await manager.create({
      sessionId: "session-preimage-link", runId: "run-preimage-link",
      workspacePath: workspace, scopePaths: ["tree-preimage-link"], baseSeq: 1
    });
    if (process.platform === "win32") {
      const manifest = JSON.parse(await readFile(
        path.join(root, "state", "checkpoints", "cas", checkpoint.preManifestDigest), "utf8"
      )) as { entries: Array<{ path: string; linkType?: string }> };
      expect(manifest.entries.find((entry) => entry.path === "tree-preimage-link")?.linkType).toBe("directory");
    }
    await rm(tree);
    await mkdir(tree);
    await writeFile(path.join(tree, "local.txt"), "postimage", "utf8");
    await manager.seal(checkpoint.sessionId, checkpoint.checkpointId);
    await manager.undoLatest(checkpoint.sessionId);

    expect((await lstat(tree)).isSymbolicLink()).toBe(true);
    await expect(readFile(path.join(outside, "sentinel.txt"), "utf8")).resolves.toBe("outside");
    await expect(readFile(path.join(outside, "local.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.runIf(process.platform === "win32")("round-trips a directory link after its target becomes dangling", async () => {
    const { root, workspace, manager } = await fixture();
    const target = path.join(root, "removed-directory-target");
    const link = path.join(workspace, "dangling-directory-link");
    await mkdir(target);
    await symlink(target, link, "junction");
    const checkpoint = await manager.create({
      sessionId: "session-dangling-directory-link", runId: "run-dangling-directory-link",
      workspacePath: workspace, scopePaths: ["dangling-directory-link"], baseSeq: 1
    });
    await rm(link);
    await rm(target, { recursive: true });
    await mkdir(link);
    await manager.seal(checkpoint.sessionId, checkpoint.checkpointId);
    await manager.undoLatest(checkpoint.sessionId);

    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    await expect(readlink(link)).resolves.toBe(target);
  });

  it("fails closed on a real-directory to linked-parent race and leaves the external target unchanged", async () => {
    const { root, workspace, manager } = await fixture();
    const outside = path.join(root, "race-outside");
    const tree = path.join(workspace, "race-tree");
    await mkdir(outside);
    await mkdir(tree);
    await writeFile(path.join(outside, "sentinel.txt"), "outside", "utf8");
    await writeFile(path.join(tree, "inside.txt"), "before", "utf8");
    const checkpoint = await manager.create({
      sessionId: "session-parent-race", runId: "run-parent-race",
      workspacePath: workspace, scopePaths: ["race-tree"], baseSeq: 1
    });
    await writeFile(path.join(tree, "inside.txt"), "after", "utf8");
    await manager.seal(checkpoint.sessionId, checkpoint.checkpointId);
    let swapped = false;
    const transactional = new CheckpointManager({
      rootDir: path.join(root, "state"),
      restoreFaultInjector: async ({ point }) => {
        if (point !== "before_commit" || swapped) return;
        await rm(tree, { recursive: true });
        swapped = await symlink(outside, tree, process.platform === "win32" ? "junction" : "dir")
          .then(() => true, () => false);
      }
    });
    if (!await symlink(outside, path.join(workspace, "probe-link"), process.platform === "win32" ? "junction" : "dir")
      .then(async () => { await rm(path.join(workspace, "probe-link")); return true; }, () => false)) return;

    await expect(transactional.undoLatest(checkpoint.sessionId)).rejects.toBeInstanceOf(CheckpointConflictError);
    expect(swapped).toBe(true);
    await expect(readFile(path.join(outside, "sentinel.txt"), "utf8")).resolves.toBe("outside");
    await expect(readFile(path.join(outside, "inside.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(transactional.list(checkpoint.sessionId)).resolves.toContainEqual(expect.objectContaining({ status: "sealed" }));
  });

  it.runIf(process.platform === "win32")(
    "locks every restore parent across the verify-to-rename window",
    async () => {
      const { root, workspace, manager } = await fixture();
      const outside = path.join(root, "locked-race-outside");
      const nested = path.join(workspace, "locked-parent");
      await mkdir(outside);
      await mkdir(nested);
      await writeFile(path.join(nested, "inside.txt"), "before", "utf8");
      await writeFile(path.join(outside, "sentinel.txt"), "outside", "utf8");
      const checkpoint = await manager.create({
        sessionId: "session-locked-parent", runId: "run-locked-parent",
        workspacePath: workspace, scopePaths: ["locked-parent/inside.txt"], baseSeq: 1
      });
      await writeFile(path.join(nested, "inside.txt"), "after", "utf8");
      await manager.seal(checkpoint.sessionId, checkpoint.checkpointId);
      let swapAttempted = false;
      const transactional = new CheckpointManager({
        rootDir: path.join(root, "state"),
        restoreFaultInjector: async ({ point }) => {
          if (point !== "before_backup_move") return;
          swapAttempted = true;
          await rename(nested, `${nested}-displaced`);
          await symlink(outside, nested, "junction");
        }
      });
      await expect(transactional.undoLatest(checkpoint.sessionId)).rejects.toThrow();
      expect(swapAttempted).toBe(true);
      await expect(readFile(path.join(outside, "sentinel.txt"), "utf8")).resolves.toBe("outside");
      await expect(readFile(path.join(outside, "inside.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(path.join(nested, "inside.txt"), "utf8")).resolves.toBe("after");
    }
  );

  it("keeps restore state external when the legacy .agent directory is linked", async () => {
    const { root, workspace, manager } = await fixture();
    const outside = path.join(root, "agent-link-outside");
    await mkdir(outside);
    const linked = await symlink(outside, path.join(workspace, ".agent"), process.platform === "win32" ? "junction" : "dir")
      .then(() => true, () => false);
    if (!linked) return;
    const checkpoint = await manager.create({
      sessionId: "session-agent-link", runId: "run-agent-link",
      workspacePath: workspace, scopePaths: ["existing.txt"], baseSeq: 1
    });
    await writeFile(path.join(workspace, "existing.txt"), "after", "utf8");
    await manager.seal(checkpoint.sessionId, checkpoint.checkpointId);
    const transactions = await checkpointTransactionRoot(root, workspace);

    await expect(manager.undoLatest(checkpoint.sessionId)).resolves.toMatchObject({ status: "restored" });
    await expect(readFile(path.join(workspace, "existing.txt"), "utf8")).resolves.toBe("before");
    await expect(lstat(transactions)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(path.join(outside, "checkpoint-transactions"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("streams pinned file capture in bounded chunks and preflights a near-2-GiB limit failure", async () => {
    const root = await checkpointTemporaryRoot("sigma-checkpoint-stream-");
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);
    const streamed = path.join(workspace, "streamed.txt");
    await writeFile(streamed, Buffer.alloc(1024 * 1024, 0x61));
    const chunkSizes: number[] = [];
    const manifest = await captureCheckpointManifest({
      workspacePath: workspace,
      scopePaths: ["streamed.txt"],
      maxFiles: 10,
      maxBytes: 2 * 1024 * 1024,
      excludedNames: new Set(),
      putCas: async (source) => {
        const hash = createHash("sha256");
        let size = 0;
        for await (const chunk of source) {
          chunkSizes.push(chunk.byteLength);
          hash.update(chunk);
          size += chunk.byteLength;
        }
        return {
          digest: hash.digest("hex"),
          size,
          identity: { dev: "1", ino: "1", mode: "1", size: String(size), mtimeNs: "1", ctimeNs: "1" }
        };
      }
    });
    expect(manifest.totalBytes).toBe(1024 * 1024);
    expect(chunkSizes.length).toBeGreaterThan(1);
    expect(Math.max(...chunkSizes)).toBeLessThanOrEqual(64 * 1024);

    const twoGiB = 2 * 1024 * 1024 * 1024;
    const nearTwoGiB = twoGiB - 1;
    expect(() => preflightCheckpointByteReservation({
      maxBytes: twoGiB,
      totalBytes: 0,
      expectedSize: nearTwoGiB
    })).not.toThrow();
    expect(() => preflightCheckpointByteReservation({
      maxBytes: twoGiB,
      totalBytes: nearTwoGiB,
      expectedSize: 2
    })).toThrow(CheckpointLimitError);

    const limitedRoot = path.join(root, "limited-state");
    const limited = new CheckpointManager({ rootDir: limitedRoot, maxBytes: 1024 });
    await expect(limited.create({
      sessionId: "session-sparse-limit", runId: "run-sparse-limit", workspacePath: workspace,
      scopePaths: ["streamed.txt"], baseSeq: 0
    })).rejects.toBeInstanceOf(CheckpointLimitError);
    await expect(readdir(path.join(limitedRoot, "checkpoints", "cas"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps review output UTF-8 safe and visibly truncated within the exact byte budget", async () => {
    const { workspace, manager } = await fixture();
    await writeFile(path.join(workspace, "existing.txt"), "你好🙂".repeat(1024), "utf8");
    const checkpoint = await manager.create({
      sessionId: "session-review-budget", runId: "run-review-budget", workspacePath: workspace,
      scopePaths: ["existing.txt"], baseSeq: 0
    });
    await writeFile(path.join(workspace, "existing.txt"), "再见🚀".repeat(1024), "utf8");
    await manager.seal(checkpoint.sessionId, checkpoint.checkpointId);

    const review = await manager.reviewDiff(checkpoint.sessionId, checkpoint.checkpointId, 191);
    expect(Buffer.byteLength(review, "utf8")).toBeLessThanOrEqual(191);
    expect(review.endsWith("[review diff truncated]")).toBe(true);
    expect(review).not.toContain("\uFFFD");
  });

  it("fails review and CAS reuse when a content-addressed object was replaced", async () => {
    const { root, workspace, manager } = await fixture();
    const checkpoint = await manager.create({
      sessionId: "session-review-corrupt", runId: "run-review-corrupt", workspacePath: workspace,
      scopePaths: ["existing.txt"], baseSeq: 0
    });
    await writeFile(path.join(workspace, "existing.txt"), "after!", "utf8");
    const sealed = await manager.seal(checkpoint.sessionId, checkpoint.checkpointId);
    const post = JSON.parse(await readFile(
      path.join(root, "state", "checkpoints", "cas", sealed.postManifestDigest!),
      "utf8"
    )) as { entries: Array<{ path: string; digest?: string }> };
    const digest = post.entries.find((entry) => entry.path === "existing.txt")!.digest!;
    await writeFile(path.join(root, "state", "checkpoints", "cas", digest), "forged!", "utf8");

    await expect(manager.reviewDiff(checkpoint.sessionId, checkpoint.checkpointId))
      .rejects.toBeInstanceOf(CheckpointConflictError);
    const second = new CheckpointManager({ rootDir: path.join(root, "state") });
    await expect(second.create({
      sessionId: "session-reuse-corrupt", runId: "run-reuse-corrupt", workspacePath: workspace,
      scopePaths: ["existing.txt"], baseSeq: 0
    })).rejects.toBeInstanceOf(CheckpointConflictError);
  });
});
