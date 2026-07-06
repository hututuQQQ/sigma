import { mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ModelClient, ModelRequest, ModelResponse, ProviderName, ProviderOptions } from "../packages/agent-ai/src/index.js";
import { runSolveCommand } from "../packages/agent-cli/src/commands/solve.js";

class FinalModel implements ModelClient {
  readonly provider = "deepseek" as const;
  readonly model = "fake-cli-model";

  async complete(_req: ModelRequest): Promise<ModelResponse> {
    return {
      message: { role: "assistant", content: "all set" },
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 }
    };
  }
}

describe("agent-cli solve", () => {
  it("runs with an injected fake provider and writes summary JSON", async () => {
    const dir = await mkdir(path.join(os.tmpdir(), `agent-cli-${Date.now()}`), { recursive: true });
    const summaryPath = path.join(dir, "summary.json");
    const tracePath = path.join(dir, "trace.jsonl");

    const code = await runSolveCommand(
      [
        "--workspace",
        dir,
        "--instruction",
        "finish immediately",
        "--provider",
        "deepseek",
        "--permission-mode",
        "yolo",
        "--summary-json",
        summaryPath,
        "--trace-jsonl",
        tracePath
      ],
      {
        modelClientFactory: (_provider: ProviderName, _options: ProviderOptions) => new FinalModel()
      }
    );

    expect(code).toBe(0);
    const summary = JSON.parse(await readFile(summaryPath, "utf8")) as { status: string; provider: string; model: string };
    expect(summary).toMatchObject({ status: "completed", provider: "deepseek", model: "fake-cli-model" });
    await expect(readFile(tracePath, "utf8")).resolves.toContain("run_end");
  });
});
