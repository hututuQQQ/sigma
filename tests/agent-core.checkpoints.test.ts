import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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
});
