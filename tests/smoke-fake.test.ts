import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runAgent } from "../packages/agent-core/src/index.js";
import { SmokeFakeModel, smokeTaskNames } from "../scripts/smoke-fake-model.mjs";

const taskNames = ["create-file", "edit-file", "fix-test", "inspect-and-summarize"];

function bashExecutable(): string {
  if (process.env.AGENT_BASH_PATH) return process.env.AGENT_BASH_PATH;
  if (process.platform === "win32") {
    const candidates = [
      "C:\\Program Files\\Git\\bin\\bash.exe",
      "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
      "C:\\msys64\\usr\\bin\\bash.exe"
    ];
    const found = candidates.find((candidate) => existsSync(candidate));
    if (found) return found;
  }
  return "bash";
}

async function runShellScript(scriptPath: string, cwd: string): Promise<void> {
  const script = await readFile(scriptPath, "utf8");
  const child = spawn(bashExecutable(), ["-s"], { cwd, windowsHide: true });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  child.stdin.end(script);

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });

  if (exitCode !== 0) {
    throw new Error(`Script failed: ${scriptPath}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }
}

describe("smoke fake model", () => {
  it("passes all local smoke tasks through the normal agent loop", async () => {
    expect(smokeTaskNames).toEqual(taskNames);

    for (const taskName of taskNames) {
      const taskDir = path.resolve("examples", "smoke-tasks", taskName);
      const workspace = await mkdtemp(path.join(os.tmpdir(), `sigma-smoke-${taskName}-`));
      const seedPath = path.join(taskDir, "seed.sh");
      if (existsSync(seedPath)) {
        await runShellScript(seedPath, workspace);
      }

      const result = await runAgent({
        instruction: await readFile(path.join(taskDir, "instruction.md"), "utf8"),
        workspacePath: workspace,
        modelClient: new SmokeFakeModel(taskName),
        maxTurns: 8,
        maxWallTimeSec: 300,
        commandTimeoutSec: 60,
        permissionMode: "yolo"
      });

      expect(result.status, taskName).toBe("completed");
      expect(result.toolCalls, taskName).toBeGreaterThan(0);
      await runShellScript(path.join(taskDir, "verify.sh"), workspace);
    }
  }, 20000);
});
