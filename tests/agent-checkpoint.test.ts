import {
  chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rename, rm, symlink, truncate, writeFile
} from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CheckpointConflictError,
  CheckpointLimitError,
  CheckpointManager,
  CheckpointRecoveryError
} from "../packages/agent-checkpoint/src/index.js";
import { captureCheckpointManifest } from "../packages/agent-checkpoint/src/safe-capture.js";

async function fixture(): Promise<{ root: string; workspace: string; manager: CheckpointManager }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "sigma-checkpoint-"));
  const workspace = path.join(root, "workspace");
  await mkdir(path.join(workspace, ".git"), { recursive: true });
  await writeFile(path.join(workspace, "existing.txt"), "before", "utf8");
  await writeFile(path.join(workspace, "deleted.txt"), "keep me", "utf8");
  await writeFile(path.join(workspace, ".git", "protected"), "user state", "utf8");
  return { root, workspace, manager: new CheckpointManager({ rootDir: path.join(root, "state") }) };
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
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-checkpoint-nongit-"));
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
    await expect(readdir(path.join(workspace, ".agent", "checkpoint-transactions"))).resolves.toEqual([]);

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

  it("replays a write-ahead journal after a crash between rename and completion recording", async () => {
    const { workspace, manager } = await fixture();
    const transaction = path.join(workspace, ".agent", "checkpoint-transactions", "restore-crash");
    await mkdir(path.join(transaction, "backup"), { recursive: true });
    await mkdir(path.join(transaction, "stage"), { recursive: true });
    await rename(path.join(workspace, "existing.txt"), path.join(transaction, "backup", "0"));
    await writeFile(path.join(workspace, "existing.txt"), "partially installed preimage", "utf8");
    await writeFile(path.join(transaction, "journal.json"), JSON.stringify({
      schemaVersion: 1,
      phase: "applying",
      operations: [{
        path: "existing.txt", index: 0, hadCurrent: true, hasDesired: true,
        backupIntent: true, backupMoved: false, installIntent: true, installed: false
      }]
    }));

    await manager.create({
      sessionId: "session-crash-recovery", runId: "run-crash-recovery",
      workspacePath: workspace, scopePaths: ["existing.txt"], baseSeq: 0
    });

    await expect(readFile(path.join(workspace, "existing.txt"), "utf8")).resolves.toBe("before");
    await expect(lstat(transaction)).rejects.toMatchObject({ code: "ENOENT" });
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

    const failure = await transactional.undoLatest(checkpoint.sessionId).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CheckpointRecoveryError);
    expect(failure).toMatchObject({ code: "checkpoint_recovery_failed" });
    await expect(transactional.list(checkpoint.sessionId)).resolves.toContainEqual(expect.objectContaining({
      checkpointId: checkpoint.checkpointId,
      status: "sealed"
    }));
    const transactions = path.join(workspace, ".agent", "checkpoint-transactions");
    const retained = (await readdir(transactions)).find((name) => name.startsWith("restore-"));
    expect(retained).toBeTruthy();
    await expect(readFile(path.join(transactions, retained!, "journal.json"), "utf8")).resolves.toContain("rolling_back");
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

  it("never follows a linked .agent directory while creating its restore journal", async () => {
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

    await expect(manager.undoLatest(checkpoint.sessionId)).rejects.toBeInstanceOf(CheckpointConflictError);
    await expect(readFile(path.join(workspace, "existing.txt"), "utf8")).resolves.toBe("after");
    await expect(lstat(path.join(outside, "checkpoint-transactions"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("streams pinned file capture in bounded chunks and preflights a near-2-GiB limit failure", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-checkpoint-stream-"));
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

    await truncate(streamed, 2 * 1024 * 1024 * 1024 - 1);
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
