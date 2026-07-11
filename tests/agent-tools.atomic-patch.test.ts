import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyUnifiedPatch, AtomicPatchError, AtomicPatchRollbackError
} from "../packages/agent-tools/src/atomic-patch.js";

async function workspace(): Promise<string> {
  return await mkdtemp(path.join(os.tmpdir(), "sigma-patch-"));
}

describe("applyUnifiedPatch", () => {
  it("applies a CRLF modification atomically and reports hashes", async () => {
    const root = await workspace();
    await writeFile(path.join(root, "one.txt"), "alpha\r\nbeta\r\n", "utf8");
    const before = createHash("sha256").update("alpha\r\nbeta\r\n").digest("hex");
    const result = await applyUnifiedPatch(root, [
      "--- a/one.txt",
      "+++ b/one.txt",
      "@@ -1,2 +1,2 @@",
      " alpha",
      "-beta",
      "+gamma"
    ].join("\n"), { preimageHashes: { "one.txt": before } });
    expect(result.delta).toEqual({ added: [], modified: ["one.txt"], deleted: [] });
    expect(result.preimageHashes["one.txt"]).toBe(before);
    expect(result.postimageHashes["one.txt"]).toBe(
      createHash("sha256").update("alpha\r\ngamma\r\n").digest("hex")
    );
    await expect(readFile(path.join(root, "one.txt"), "utf8")).resolves.toBe("alpha\r\ngamma\r\n");
  });

  it("rejects staged content replacement and restores the original", async () => {
    const root = await workspace();
    await writeFile(path.join(root, "target.txt"), "before\n", "utf8");
    await expect(applyUnifiedPatch(root, [
      "--- a/target.txt", "+++ b/target.txt", "@@ -1 +1 @@", "-before", "+expected"
    ].join("\n"), {
      beforeCommit: async () => {
        const transactions = path.join(root, ".agent", "patch-transactions");
        const transaction = (await readdir(transactions)).find((entry) => entry.startsWith("patch-"));
        await writeFile(path.join(transactions, transaction!, "staged", "0"), "attacker\n", "utf8");
      }
    })).rejects.toThrow(/installed path changed|postimage|prepared content/iu);
    await expect(readFile(path.join(root, "target.txt"), "utf8")).resolves.toBe("before\n");
  });

  it.runIf(process.platform !== "win32")("rejects a staged file replaced by a symlink", async () => {
    const root = await workspace();
    const outside = path.join(await workspace(), "outside.txt");
    await writeFile(outside, "attacker\n", "utf8");
    await expect(applyUnifiedPatch(root, [
      "diff --git a/new.txt b/new.txt", "new file mode 100644",
      "--- /dev/null", "+++ b/new.txt", "@@ -0,0 +1 @@", "+expected"
    ].join("\n"), {
      beforeCommit: async () => {
        const transactions = path.join(root, ".agent", "patch-transactions");
        const transaction = (await readdir(transactions)).find((entry) => entry.startsWith("patch-"));
        const staged = path.join(transactions, transaction!, "staged", "0");
        await rm(staged);
        await symlink(outside, staged, "file");
      }
    })).rejects.toThrow(/installed path changed/iu);
    await expect(lstat(path.join(root, "new.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(outside, "utf8")).resolves.toBe("attacker\n");
  });

  it("preflights every hunk before making any filesystem change", async () => {
    const root = await workspace();
    await writeFile(path.join(root, "one.txt"), "one\n", "utf8");
    await writeFile(path.join(root, "two.txt"), "two\n", "utf8");
    const patch = [
      "diff --git a/one.txt b/one.txt", "--- a/one.txt", "+++ b/one.txt",
      "@@ -1 +1 @@", "-one", "+changed",
      "diff --git a/two.txt b/two.txt", "--- a/two.txt", "+++ b/two.txt",
      "@@ -1 +1 @@", "-not-two", "+changed"
    ].join("\n");
    await expect(applyUnifiedPatch(root, patch)).rejects.toBeInstanceOf(AtomicPatchError);
    await expect(readFile(path.join(root, "one.txt"), "utf8")).resolves.toBe("one\n");
    await expect(readFile(path.join(root, "two.txt"), "utf8")).resolves.toBe("two\n");
  });

  it("rolls back an earlier commit when a later commit I/O operation fails", async () => {
    const root = await workspace();
    await writeFile(path.join(root, "old.txt"), "rename me\n", "utf8");
    await chmod(path.join(root, "old.txt"), 0o644);
    await writeFile(path.join(root, "delete.txt"), "restore me\n", "utf8");
    await writeFile(path.join(root, "later.txt"), "unchanged\n", "utf8");
    const patch = [
      "diff --git a/old.txt b/moved.txt", "old mode 100644", "new mode 100755",
      "rename from old.txt", "rename to moved.txt",
      "diff --git a/delete.txt b/delete.txt", "deleted file mode 100644",
      "--- a/delete.txt", "+++ /dev/null", "@@ -1 +0,0 @@", "-restore me",
      "diff --git a/later.txt b/later.txt", "--- a/later.txt", "+++ b/later.txt",
      "@@ -1 +1 @@", "-unchanged", "+changed"
    ].join("\n");
    await expect(applyUnifiedPatch(root, patch, {
      beforeMutation: async (operation) => {
        if (operation.direction === "commit" && operation.phase === "backup_source" && operation.changeIndex === 2) {
          throw Object.assign(new Error("simulated commit I/O failure"), { code: "EIO" });
        }
      }
    })).rejects.toThrow("simulated commit I/O failure");
    await expect(readFile(path.join(root, "old.txt"), "utf8")).resolves.toBe("rename me\n");
    await expect(lstat(path.join(root, "moved.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(root, "delete.txt"), "utf8")).resolves.toBe("restore me\n");
    await expect(readFile(path.join(root, "later.txt"), "utf8")).resolves.toBe("unchanged\n");
    if (process.platform !== "win32") expect((await lstat(path.join(root, "old.txt"))).mode & 0o777).toBe(0o644);
    expect((await readdir(root)).some((entry) => entry.startsWith(".sigma-patch-"))).toBe(false);
  });

  it("removes parent directories created by a rolled-back commit", async () => {
    const root = await workspace();
    await writeFile(path.join(root, "later.txt"), "unchanged\n", "utf8");
    const patch = [
      "diff --git a/nested/deep/new.txt b/nested/deep/new.txt", "new file mode 100644",
      "--- /dev/null", "+++ b/nested/deep/new.txt", "@@ -0,0 +1 @@", "+created",
      "diff --git a/later.txt b/later.txt", "--- a/later.txt", "+++ b/later.txt",
      "@@ -1 +1 @@", "-unchanged", "+changed"
    ].join("\n");
    await expect(applyUnifiedPatch(root, patch, {
      beforeMutation: async (operation) => {
        if (operation.direction === "commit" && operation.phase === "backup_source" && operation.changeIndex === 1) {
          throw new Error("stop after nested install");
        }
      }
    })).rejects.toThrow("stop after nested install");
    await expect(lstat(path.join(root, "nested"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(root, "later.txt"), "utf8")).resolves.toBe("unchanged\n");
  });

  it("surfaces rollback failures and preserves recovery data", async () => {
    const root = await workspace();
    await writeFile(path.join(root, "one.txt"), "one\n", "utf8");
    await writeFile(path.join(root, "two.txt"), "two\n", "utf8");
    const patch = [
      "diff --git a/one.txt b/one.txt", "--- a/one.txt", "+++ b/one.txt",
      "@@ -1 +1 @@", "-one", "+changed",
      "diff --git a/two.txt b/two.txt", "--- a/two.txt", "+++ b/two.txt",
      "@@ -1 +1 @@", "-two", "+changed"
    ].join("\n");
    const error = await applyUnifiedPatch(root, patch, {
      beforeMutation: async (operation) => {
        if (operation.direction === "commit" && operation.phase === "backup_source" && operation.changeIndex === 1) {
          throw new Error("commit failed");
        }
        if (operation.direction === "rollback" && operation.phase === "restore_source") {
          throw new Error("rollback failed");
        }
      }
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AtomicPatchRollbackError);
    const rollbackError = error as AtomicPatchRollbackError;
    expect(rollbackError.rollbackErrors.length).toBeGreaterThan(0);
    await expect(lstat(rollbackError.recoveryPath)).resolves.toBeDefined();
    await rm(root, { recursive: true, force: true });
  });

  it("creates, deletes and renames files in one transaction", async () => {
    const root = await workspace();
    await writeFile(path.join(root, "delete.txt"), "gone\n", "utf8");
    await writeFile(path.join(root, "old.txt"), "renamed\n", "utf8");
    const patch = [
      "diff --git a/new.txt b/new.txt", "new file mode 100644", "--- /dev/null", "+++ b/new.txt",
      "@@ -0,0 +1 @@", "+created",
      "diff --git a/delete.txt b/delete.txt", "deleted file mode 100644", "--- a/delete.txt", "+++ /dev/null",
      "@@ -1 +0,0 @@", "-gone",
      "diff --git a/old.txt b/moved.txt", "rename from old.txt", "rename to moved.txt"
    ].join("\n");
    const result = await applyUnifiedPatch(root, patch);
    expect(result.delta).toEqual({
      added: ["moved.txt", "new.txt"], modified: [], deleted: ["delete.txt", "old.txt"]
    });
    await expect(readFile(path.join(root, "new.txt"), "utf8")).resolves.toBe("created\n");
    await expect(readFile(path.join(root, "moved.txt"), "utf8")).resolves.toBe("renamed\n");
    await expect(lstat(path.join(root, "delete.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(path.join(root, "old.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.runIf(process.platform !== "win32")("supports symlink mode while protecting control directories", async () => {
    const root = await workspace();
    const outside = await workspace();
    await mkdir(path.join(root, ".git"));
    await chmod(path.join(root, ".git"), 0o700);
    const patch = [
      "diff --git a/link b/link", "new file mode 120000", "--- /dev/null", "+++ b/link",
      "@@ -0,0 +1 @@", "+target.txt"
    ].join("\n");
    await applyUnifiedPatch(root, patch);
    await expect(readlink(path.join(root, "link"))).resolves.toBe("target.txt");
    await symlink(outside, path.join(root, "outside-alias"), "dir");
    await expect(applyUnifiedPatch(root, [
      "diff --git a/chained-link b/chained-link", "new file mode 120000",
      "--- /dev/null", "+++ b/chained-link", "@@ -0,0 +1 @@", "+outside-alias/secret.txt"
    ].join("\n"))).rejects.toThrow("Unsafe symlink target");
    await expect(applyUnifiedPatch(root, "--- a/.git/config\n+++ b/.git/config\n@@ -0,0 +1 @@\n+x"))
      .rejects.toBeInstanceOf(AtomicPatchError);
  });

  it.runIf(process.platform === "linux")("pins the commit parent so a linked-parent swap cannot reach outside files", async () => {
    const root = await workspace();
    const outside = await workspace();
    await mkdir(path.join(root, "tree"));
    await writeFile(path.join(root, "tree", "victim.txt"), "before\n", "utf8");
    await writeFile(path.join(outside, "victim.txt"), "before\n", "utf8");
    await writeFile(path.join(outside, "sentinel.txt"), "outside", "utf8");
    let swapped = false;
    await expect(applyUnifiedPatch(root, [
      "--- a/tree/victim.txt", "+++ b/tree/victim.txt", "@@ -1 +1 @@", "-before", "+after"
    ].join("\n"), {
      beforeMutation: async (operation) => {
        if (swapped || operation.direction !== "commit" || operation.phase !== "backup_source") return;
        swapped = true;
        await rm(path.join(root, "tree"), { recursive: true });
        await symlink(outside, path.join(root, "tree"), "dir");
      }
    })).rejects.toBeInstanceOf(AtomicPatchError);

    await expect(readFile(path.join(outside, "victim.txt"), "utf8")).resolves.toBe("before\n");
    await expect(readFile(path.join(outside, "sentinel.txt"), "utf8")).resolves.toBe("outside");
  });

  it.runIf(process.platform !== "win32")("preserves Unicode paths and applies executable modes", async () => {
    const root = await workspace();
    await writeFile(path.join(root, "说明.txt"), "你好\n", { encoding: "utf8", mode: 0o644 });
    const patch = [
      "diff --git a/说明.txt b/说明.txt", "old mode 100644", "new mode 100755",
      "--- a/说明.txt", "+++ b/说明.txt", "@@ -1 +1 @@", "-你好", "+再见"
    ].join("\n");
    await applyUnifiedPatch(root, patch);
    await expect(readFile(path.join(root, "说明.txt"), "utf8")).resolves.toBe("再见\n");
    expect((await lstat(path.join(root, "说明.txt"))).mode & 0o777).toBe(0o755);
  });

  it("rejects binary input before changing any file", async () => {
    const root = await workspace();
    await writeFile(path.join(root, "binary.dat"), Buffer.from([0, 1, 2, 3]));
    await writeFile(path.join(root, "plain.txt"), "before\n", "utf8");
    const patch = [
      "diff --git a/plain.txt b/plain.txt", "--- a/plain.txt", "+++ b/plain.txt",
      "@@ -1 +1 @@", "-before", "+after",
      "diff --git a/binary.dat b/binary.dat", "--- a/binary.dat", "+++ b/binary.dat",
      "@@ -1 +1 @@", "-ignored", "+changed"
    ].join("\n");
    await expect(applyUnifiedPatch(root, patch)).rejects.toThrow("Binary patching is not supported");
    await expect(readFile(path.join(root, "plain.txt"), "utf8")).resolves.toBe("before\n");
    await expect(readFile(path.join(root, "binary.dat"))).resolves.toEqual(Buffer.from([0, 1, 2, 3]));
  });

  it("rejects malformed UTF-8 before changing any file", async () => {
    const root = await workspace();
    await writeFile(path.join(root, "invalid.txt"), Buffer.from([0xc3, 0x28]));
    await writeFile(path.join(root, "plain.txt"), "before\n", "utf8");
    const patch = [
      "diff --git a/plain.txt b/plain.txt", "--- a/plain.txt", "+++ b/plain.txt",
      "@@ -1 +1 @@", "-before", "+after",
      "diff --git a/invalid.txt b/invalid.txt", "--- a/invalid.txt", "+++ b/invalid.txt",
      "@@ -1 +1 @@", "-ignored", "+changed"
    ].join("\n");
    await expect(applyUnifiedPatch(root, patch)).rejects.toThrow("not valid UTF-8");
    await expect(readFile(path.join(root, "plain.txt"), "utf8")).resolves.toBe("before\n");
    await expect(readFile(path.join(root, "invalid.txt"))).resolves.toEqual(Buffer.from([0xc3, 0x28]));
  });

  it("handles zero-count insertion positions and no-newline markers", async () => {
    const root = await workspace();
    await writeFile(path.join(root, "append.txt"), "one\n", "utf8");
    await applyUnifiedPatch(root, "--- a/append.txt\n+++ b/append.txt\n@@ -1,0 +2 @@\n+two");
    await expect(readFile(path.join(root, "append.txt"), "utf8")).resolves.toBe("one\ntwo\n");

    await writeFile(path.join(root, "unicode.txt"), "你好", "utf8");
    const patch = [
      "--- a/unicode.txt", "+++ b/unicode.txt", "@@ -1 +1 @@",
      "-你好", "\\ No newline at end of file", "+再见", "\\ No newline at end of file"
    ].join("\n");
    await applyUnifiedPatch(root, patch);
    await expect(readFile(path.join(root, "unicode.txt"), "utf8")).resolves.toBe("再见");
  });

  it("rejects escaping symlinks and portable-unsafe control paths", async () => {
    const root = await workspace();
    const escapingLink = [
      "diff --git a/link b/link", "new file mode 120000", "--- /dev/null", "+++ b/link",
      "@@ -0,0 +1 @@", "+../outside"
    ].join("\n");
    await expect(applyUnifiedPatch(root, escapingLink)).rejects.toThrow("Unsafe symlink target");
    await expect(applyUnifiedPatch(root, [
      "diff --git a/nested/.GIT/config b/nested/.GIT/config", "new file mode 100644",
      "--- /dev/null", "+++ b/nested/.GIT/config", "@@ -0,0 +1 @@", "+unsafe"
    ].join("\n"))).rejects.toBeInstanceOf(AtomicPatchError);
    await expect(applyUnifiedPatch(root, [
      "diff --git a/file.txt:stream b/file.txt:stream", "new file mode 100644",
      "--- /dev/null", "+++ b/file.txt:stream", "@@ -0,0 +1 @@", "+unsafe"
    ].join("\n"))).rejects.toBeInstanceOf(AtomicPatchError);
    expect(await readdir(root)).toEqual([]);
  });

  it("rejects a parent-directory symlink swap before commit", async () => {
    const root = await workspace();
    const outside = await mkdtemp(path.join(os.tmpdir(), "sigma-patch-outside-"));
    await mkdir(path.join(root, "nested"));
    await writeFile(path.join(root, "nested", "file.txt"), "inside\n", "utf8");
    await writeFile(path.join(outside, "file.txt"), "outside\n", "utf8");
    const patch = "--- a/nested/file.txt\n+++ b/nested/file.txt\n@@ -1 +1 @@\n-inside\n+changed";
    await expect(applyUnifiedPatch(root, patch, {
      beforeCommit: async () => {
        await rm(path.join(root, "nested"), { recursive: true });
        await symlink(outside, path.join(root, "nested"), process.platform === "win32" ? "junction" : "dir");
      }
    })).rejects.toBeInstanceOf(AtomicPatchError);
    await expect(readFile(path.join(outside, "file.txt"), "utf8")).resolves.toBe("outside\n");
  });

  it.runIf(process.platform === "win32")(
    "locks a patch parent across the verify-to-rename window",
    async () => {
      const root = await workspace();
      const outside = await mkdtemp(path.join(os.tmpdir(), "sigma-patch-locked-outside-"));
      const nested = path.join(root, "nested");
      await mkdir(nested);
      await writeFile(path.join(nested, "file.txt"), "inside\n", "utf8");
      await writeFile(path.join(outside, "file.txt"), "outside\n", "utf8");
      let attempted = false;
      await expect(applyUnifiedPatch(root,
        "--- a/nested/file.txt\n+++ b/nested/file.txt\n@@ -1 +1 @@\n-inside\n+changed", {
          beforeMutation: async ({ phase }) => {
            if (phase !== "backup_source_pinned") return;
            attempted = true;
            await rename(nested, `${nested}-displaced`);
            await symlink(outside, nested, "junction");
          }
        })).rejects.toThrow();
      expect(attempted).toBe(true);
      await expect(readFile(path.join(nested, "file.txt"), "utf8")).resolves.toBe("inside\n");
      await expect(readFile(path.join(outside, "file.txt"), "utf8")).resolves.toBe("outside\n");
    }
  );
});
