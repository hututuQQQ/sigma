import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ToolCall, ModelClient, ModelRequest, ModelResponse } from "../packages/agent-ai/src/index.js";
import { listCheckpoints, restoreCheckpoint, runAgent } from "../packages/agent-core/src/index.js";

class WriteModel implements ModelClient {
  readonly provider = "deepseek" as const;
  readonly model = "fake-checkpoint-model";
  private index = 0;

  async complete(_req: ModelRequest): Promise<ModelResponse> {
    const call: ToolCall = {
      id: "write-note",
      type: "function",
      function: {
        name: "write",
        arguments: { path: "note.txt", content: "changed\n", createDirs: true }
      }
    };
    const responses: ModelResponse[] = [
      { message: { role: "assistant", toolCalls: [call] } },
      { message: { role: "assistant", content: "done" } }
    ];
    const response = responses[Math.min(this.index, responses.length - 1)];
    this.index += 1;
    return response;
  }
}

class OneToolModel implements ModelClient {
  readonly provider = "deepseek" as const;
  readonly model = "fake-checkpoint-model";
  private index = 0;

  constructor(private readonly call: ToolCall) {}

  async complete(_req: ModelRequest): Promise<ModelResponse> {
    const responses: ModelResponse[] = [
      { message: { role: "assistant", toolCalls: [this.call] } },
      { message: { role: "assistant", content: "done" } }
    ];
    const response = responses[Math.min(this.index, responses.length - 1)];
    this.index += 1;
    return response;
  }
}

function git(dir: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.AGENT_GIT_PATH || "git", args, { cwd: dir, windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`git ${args.join(" ")} failed: ${stderr}`));
    });
  });
}

async function gitWorkspace(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sigma-checkpoint-"));
  await git(dir, ["init"]);
  await git(dir, ["config", "user.email", "sigma@example.test"]);
  await git(dir, ["config", "user.name", "Sigma Test"]);
  await writeFile(path.join(dir, ".gitignore"), ".agent/\n", "utf8");
  await writeFile(path.join(dir, "note.txt"), "original\n", "utf8");
  await git(dir, ["add", "."]);
  await git(dir, ["commit", "-m", "initial"]);
  return dir;
}

describe("git checkpoints", () => {
  it("creates, lists, shows, and safely restores a mutating tool checkpoint", async () => {
    const dir = await gitWorkspace();
    const result = await runAgent({
      instruction: "change note",
      workspacePath: dir,
      modelClient: new WriteModel(),
      permissionMode: "yolo"
    });

    await expect(readFile(path.join(dir, "note.txt"), "utf8")).resolves.toBe("changed\n");
    const checkpoints = await listCheckpoints({ sessionId: result.sessionId as string, workspacePath: dir });
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]).toMatchObject({
      id: "0001",
      toolName: "write",
      changedFiles: ["note.txt"]
    });
    await expect(readFile(checkpoints[0].patchPath, "utf8")).resolves.toContain("changed");

    const restored = await restoreCheckpoint({
      sessionId: result.sessionId as string,
      checkpointId: checkpoints[0].id,
      workspacePath: dir
    });

    expect(restored.ok).toBe(true);
    await expect(readFile(path.join(dir, "note.txt"), "utf8").then((text) => text.replace(/\r\n/g, "\n"))).resolves.toBe("original\n");
  });

  it("fails checkpoint restore cleanly when the patch file is missing", async () => {
    const dir = await gitWorkspace();
    const result = await runAgent({
      instruction: "change note",
      workspacePath: dir,
      modelClient: new WriteModel(),
      permissionMode: "yolo"
    });
    const checkpoints = await listCheckpoints({ sessionId: result.sessionId as string, workspacePath: dir });
    await rm(checkpoints[0].patchPath, { force: true });

    const restored = await restoreCheckpoint({
      sessionId: result.sessionId as string,
      checkpointId: checkpoints[0].id,
      workspacePath: dir
    });

    expect(restored.ok).toBe(false);
    expect(restored.exitCode).toBe(1);
    expect(restored.stderr).toContain("checkpoint patch is unreadable");
    await expect(readFile(path.join(dir, "note.txt"), "utf8")).resolves.toBe("changed\n");
  });
});

describe("file-backed checkpoints", () => {
  it.each([
    {
      name: "write",
      seed: null,
      call: {
        id: "write-note",
        type: "function" as const,
        function: { name: "write", arguments: { path: "note.txt", content: "created\n", createDirs: true } }
      },
      after: "created\n",
      restored: null
    },
    {
      name: "edit",
      seed: "original\n",
      call: {
        id: "edit-note",
        type: "function" as const,
        function: { name: "edit", arguments: { path: "note.txt", oldString: "original", newString: "changed", expectedReplacements: 1 } }
      },
      after: "changed\n",
      restored: "original\n"
    },
    {
      name: "apply_patch",
      seed: "original\n",
      call: {
        id: "patch-note",
        type: "function" as const,
        function: {
          name: "apply_patch",
          arguments: {
            patch: [
              "diff --git a/note.txt b/note.txt",
              "--- a/note.txt",
              "+++ b/note.txt",
              "@@ -1 +1 @@",
              "-original",
              "+patched",
              ""
            ].join("\n")
          }
        }
      },
      after: "patched\n",
      restored: "original\n"
    }
  ])("creates and restores a non-git $name checkpoint", async ({ seed, call, after, restored }) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sigma-file-checkpoint-"));
    if (seed !== null) await writeFile(path.join(dir, "note.txt"), seed, "utf8");

    const result = await runAgent({
      instruction: "change note",
      workspacePath: dir,
      modelClient: new OneToolModel(call),
      permissionMode: "yolo"
    });

    await expect(readFile(path.join(dir, "note.txt"), "utf8").then((text) => text.replace(/\r\n/g, "\n"))).resolves.toBe(after);
    const checkpoints = await listCheckpoints({ sessionId: result.sessionId as string, workspacePath: dir });
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]).toMatchObject({
      mode: "file",
      toolName: call.function.name,
      changedFiles: ["note.txt"],
      fileSnapshotPath: expect.any(String)
    });

    const restore = await restoreCheckpoint({
      sessionId: result.sessionId as string,
      checkpointId: checkpoints[0].id,
      workspacePath: dir
    });
    expect(restore.ok).toBe(true);
    if (restored === null) {
      await expect(readFile(path.join(dir, "note.txt"), "utf8")).rejects.toThrow();
    } else {
      await expect(readFile(path.join(dir, "note.txt"), "utf8").then((text) => text.replace(/\r\n/g, "\n"))).resolves.toBe(restored);
    }
  });

  it("refuses non-git restore when current files no longer match after-state unless forced", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sigma-file-checkpoint-force-"));
    await writeFile(path.join(dir, "note.txt"), "original\n", "utf8");
    const result = await runAgent({
      instruction: "edit note",
      workspacePath: dir,
      modelClient: new OneToolModel({
        id: "edit-note",
        type: "function",
        function: { name: "edit", arguments: { path: "note.txt", oldString: "original", newString: "changed" } }
      }),
      permissionMode: "yolo"
    });
    const [checkpoint] = await listCheckpoints({ sessionId: result.sessionId as string, workspacePath: dir });
    await writeFile(path.join(dir, "note.txt"), "user change\n", "utf8");

    const refused = await restoreCheckpoint({
      sessionId: result.sessionId as string,
      checkpointId: checkpoint.id,
      workspacePath: dir
    });
    expect(refused.ok).toBe(false);
    expect(refused.stderr).toContain("refusing restore without --force");

    const forced = await restoreCheckpoint({
      sessionId: result.sessionId as string,
      checkpointId: checkpoint.id,
      workspacePath: dir,
      force: true
    });
    expect(forced.ok).toBe(true);
    await expect(readFile(path.join(dir, "note.txt"), "utf8")).resolves.toBe("original\n");
  });
});
