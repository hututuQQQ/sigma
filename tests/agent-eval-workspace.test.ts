import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { copyWorkspaceEvidence } from "../scripts/eval/workspace.mjs";

describe("evaluation workspace evidence", () => {
  it("can build a verifier witness without repository metadata", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-verifier-witness-"));
    const source = path.join(root, "source");
    const destination = path.join(root, "destination");
    try {
      await mkdir(path.join(source, ".git"), { recursive: true });
      await writeFile(path.join(source, ".git", "HEAD"), "ref: refs/heads/main\n", "utf8");
      await writeFile(path.join(source, "answer.txt"), "verified\n", "utf8");

      await copyWorkspaceEvidence(source, destination, { excludeRepositoryMetadata: true });

      await expect(readFile(path.join(destination, "answer.txt"), "utf8"))
        .resolves.toBe("verified\n");
      await expect(access(path.join(destination, ".git"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
