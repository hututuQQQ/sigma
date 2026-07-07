import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import type { ModelClient, ModelRequest, ModelResponse, ProviderName, ProviderOptions } from "../packages/agent-ai/src/index.js";
import { loadSessionMeta } from "../packages/agent-core/src/index.js";
import { runSessionCommand, runSessionsCommand } from "../packages/agent-cli/src/commands/session.js";
import { runRunCommand } from "../packages/agent-cli/src/commands/solve.js";

class FinalModel implements ModelClient {
  readonly provider = "deepseek" as const;
  readonly model = "fake-cli-session-model";

  async complete(_req: ModelRequest): Promise<ModelResponse> {
    return { message: { role: "assistant", content: "cli session done" } };
  }
}

class MemoryWritable extends Writable {
  readonly chunks: string[] = [];
  isTTY = true;

  _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk);
    callback();
  }

  text(): string {
    return this.chunks.join("");
  }
}

async function workspace(): Promise<string> {
  return await mkdtemp(path.join(os.tmpdir(), "sigma-cli-session-"));
}

function fakeFactory(_provider: ProviderName, _options: ProviderOptions): ModelClient {
  return new FinalModel();
}

describe("agent-cli sessions", () => {
  it("lists, shows, and searches durable sessions", async () => {
    const dir = await workspace();
    const runStdout = new MemoryWritable();
    const code = await runRunCommand(
      ["Investigate flaky parser", "--workspace", dir, "--provider", "deepseek", "--permission-mode", "yolo", "--no-stream-ui"],
      { stdout: runStdout, modelClientFactory: fakeFactory }
    );
    expect(code).toBe(0);

    const sessionsStdout = new MemoryWritable();
    await expect(runSessionsCommand(["--workspace", dir], { stdout: sessionsStdout })).resolves.toBe(0);
    expect(sessionsStdout.text()).toContain("Investigate flaky parser");

    const records = JSON.parse(await readFile(path.join(dir, ".agent", "sessions", "index.jsonl"), "utf8")
      .then((text) => `[${text.trim().split(/\r?\n/).join(",")}]`)) as Array<{ sessionId: string }>;
    const sessionId = records[records.length - 1].sessionId;

    const showStdout = new MemoryWritable();
    await expect(runSessionCommand(["show", sessionId, "--workspace", dir, "--json"], { stdout: showStdout })).resolves.toBe(0);
    expect(JSON.parse(showStdout.text())).toMatchObject({
      meta: { sessionId, title: "Investigate flaky parser" },
      eventCount: expect.any(Number)
    });

    const searchStdout = new MemoryWritable();
    await expect(runSessionCommand(["search", "flaky parser", "--workspace", dir], { stdout: searchStdout })).resolves.toBe(0);
    expect(searchStdout.text()).toContain(sessionId);
  });

  it("resumes a session by starting a linked child run", async () => {
    const dir = await workspace();
    await mkdir(path.join(dir, ".agent"), { recursive: true });
    const createStdout = new MemoryWritable();
    await runRunCommand(
      ["Initial work", "--workspace", dir, "--provider", "deepseek", "--permission-mode", "yolo", "--no-stream-ui"],
      { stdout: createStdout, modelClientFactory: fakeFactory }
    );
    const records = JSON.parse(await readFile(path.join(dir, ".agent", "sessions", "index.jsonl"), "utf8")
      .then((text) => `[${text.trim().split(/\r?\n/).join(",")}]`)) as Array<{ sessionId: string }>;
    const parentSessionId = records[records.length - 1].sessionId;

    const resumeStdout = new MemoryWritable();
    const resumeCode = await runSessionCommand(
      [
        "resume",
        parentSessionId,
        "Continue carefully",
        "--workspace",
        dir,
        "--provider",
        "deepseek",
        "--permission-mode",
        "yolo",
        "--no-stream-ui"
      ],
      { stdout: resumeStdout, modelClientFactory: fakeFactory }
    );

    expect(resumeCode).toBe(0);
    const updatedRecords = JSON.parse(await readFile(path.join(dir, ".agent", "sessions", "index.jsonl"), "utf8")
      .then((text) => `[${text.trim().split(/\r?\n/).join(",")}]`)) as Array<{ sessionId: string }>;
    const childSessionId = updatedRecords[updatedRecords.length - 1].sessionId;
    expect(childSessionId).not.toBe(parentSessionId);
    const childMeta = await loadSessionMeta({ sessionId: childSessionId, workspacePath: dir });
    expect(childMeta?.parentSessionId).toBe(parentSessionId);
  });
});
