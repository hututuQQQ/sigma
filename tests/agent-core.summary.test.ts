import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ModelClient, ModelRequest, ModelResponse } from "../packages/agent-ai/src/index.js";
import { runAgent } from "../packages/agent-core/src/index.js";

class SummaryModel implements ModelClient {
  readonly provider = "deepseek" as const;
  readonly model = "fake-summary-model";
  private index = 0;
  readonly requests: ModelRequest[] = [];

  async complete(req: ModelRequest): Promise<ModelResponse> {
    this.requests.push(req);
    const responses: ModelResponse[] = [
      {
        message: {
          role: "assistant",
          toolCalls: [
            { id: "write-1", type: "function", function: { name: "write", arguments: { path: "note.txt", content: "hi" } } },
            { id: "todo-1", type: "function", function: { name: "todo", arguments: { action: "add", text: "verify" } } }
          ]
        }
      },
      { message: { role: "assistant", content: "done" } }
    ];
    const response = responses[Math.min(this.index, responses.length - 1)];
    this.index += 1;
    return response;
  }
}

class FinalModel implements ModelClient {
  readonly provider = "deepseek" as const;
  readonly model = "fake-final-model";

  async complete(_req: ModelRequest): Promise<ModelResponse> {
    return { message: { role: "assistant", content: "done" } };
  }
}

class ShellSessionMetricModel implements ModelClient {
  readonly provider = "deepseek" as const;
  readonly model = "fake-shell-session-metric-model";
  private index = 0;

  async complete(_req: ModelRequest): Promise<ModelResponse> {
    const responses: ModelResponse[] = [
      {
        message: {
          role: "assistant",
          toolCalls: [
            { id: "shell-start", type: "function", function: { name: "shell_session", arguments: { action: "start", sessionId: "metric" } } },
            {
              id: "shell-send",
              type: "function",
              function: { name: "shell_session", arguments: { action: "send", sessionId: "metric", input: "printf ok" } }
            }
          ]
        }
      },
      { message: { role: "assistant", content: "done" } }
    ];
    const response = responses[Math.min(this.index, responses.length - 1)];
    this.index += 1;
    return response;
  }
}

describe("summary JSON fields", () => {
  it("includes new fields when relevant", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sigma-summary-"));
    await writeFile(path.join(dir, "AGENTS.md"), "project rule", "utf8");
    const summaryPath = path.join(dir, "summary.json");

    await runAgent({
      instruction: "write and track",
      workspacePath: dir,
      modelClient: new SummaryModel(),
      permissionMode: "yolo",
      contextMode: "repo-map",
      summaryJsonPath: summaryPath
    });

    const summary = JSON.parse(await readFile(summaryPath, "utf8"));
    expect(summary.tools_available).toContain("write");
    expect(summary.changed_files).toEqual(["note.txt"]);
    expect(summary.todo_items).toEqual([{ id: "1", text: "verify", status: "pending" }]);
    expect(summary.project_instruction_sources).toEqual(["AGENTS.md"]);
    expect(summary.context_mode).toBe("repo-map");
    expect(summary.repo_map_chars).toBeGreaterThan(0);
    expect(summary.code_index).toMatchObject({
      file_count: expect.any(Number),
      symbol_count: expect.any(Number),
      dependency_edge_count: expect.any(Number),
      config_files: expect.any(Array)
    });
  });

  it("omits empty optional fields when features are disabled or unused", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sigma-summary-empty-"));
    const summaryPath = path.join(dir, "summary.json");

    await runAgent({
      instruction: "finish",
      workspacePath: dir,
      modelClient: new FinalModel(),
      projectInstructionsEnabled: false,
      contextMode: "off",
      summaryJsonPath: summaryPath
    });

    const summary = JSON.parse(await readFile(summaryPath, "utf8"));
    expect(summary).not.toHaveProperty("changed_files");
    expect(summary).not.toHaveProperty("todo_items");
    expect(summary).not.toHaveProperty("project_instruction_sources");
    expect(summary).not.toHaveProperty("repo_map_chars");
    expect(summary).not.toHaveProperty("mcp_servers");
    expect(summary.context_mode).toBe("off");
  });

  it("counts shell_session.send in command execution metrics", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sigma-summary-shell-session-"));
    const summaryPath = path.join(dir, "summary.json");

    await runAgent({
      instruction: "run a persistent shell command",
      workspacePath: dir,
      modelClient: new ShellSessionMetricModel(),
      permissionMode: "yolo",
      summaryJsonPath: summaryPath
    });

    const summary = JSON.parse(await readFile(summaryPath, "utf8"));
    expect(summary.tool_calls).toBe(2);
    expect(summary.commands_executed).toBe(1);
  });
});
