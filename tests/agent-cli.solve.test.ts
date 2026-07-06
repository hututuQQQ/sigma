import { mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ModelClient, ModelRequest, ModelResponse, ProviderName, ProviderOptions } from "../packages/agent-ai/src/index.js";
import { loadCliConfig } from "../packages/agent-cli/src/config.js";
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

class WriteInvalidJsModel implements ModelClient {
  readonly provider = "deepseek" as const;
  readonly model = "fake-cli-model";
  private index = 0;

  async complete(_req: ModelRequest): Promise<ModelResponse> {
    const responses: ModelResponse[] = [
      {
        message: {
          role: "assistant",
          toolCalls: [
            {
              id: "write-bad",
              type: "function",
              function: { name: "write", arguments: { path: "bad.js", content: "function nope(\n", createDirs: true } }
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

describe("agent-cli solve", () => {
  it("parses harness flags", () => {
    const config = loadCliConfig({
      workspace: "work",
      provider: "deepseek",
      "validation-mode": "auto",
      "validation-retry-limit": "2",
      "validation-timeout-sec": "45",
      "precheck-command": "pytest",
      "precheck-timeout-sec": "30",
      "pre-verifier-cleanup-globs": "/tmp/cache*.tmp,/tmp/other*.tmp",
      "harness-timeout-sec": "600",
      "retry-min-budget-sec": "90",
      "attempts-dir": "/tmp/agent/attempts"
    });

    expect(config).toMatchObject({
      validationMode: "auto",
      validationRetryLimit: 2,
      validationTimeoutSec: 45,
      precheckCommand: "pytest",
      precheckTimeoutSec: 30,
      preVerifierCleanupGlobs: ["/tmp/cache*.tmp", "/tmp/other*.tmp"],
      harnessTimeoutSec: 600,
      retryMinBudgetSec: 90,
      attemptsDir: "/tmp/agent/attempts"
    });
  });

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
    expect(summary).not.toHaveProperty("harness");
    await expect(readFile(tracePath, "utf8")).resolves.toContain("run_end");
  });

  it("uses the harness runner when validation mode is auto", async () => {
    const dir = await mkdir(path.join(os.tmpdir(), `agent-cli-harness-${Date.now()}`), { recursive: true });
    const summaryPath = path.join(dir, "summary.json");

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
        "--validation-mode",
        "auto"
      ],
      {
        modelClientFactory: (_provider: ProviderName, _options: ProviderOptions) => new FinalModel()
      }
    );

    expect(code).toBe(0);
    const summary = JSON.parse(await readFile(summaryPath, "utf8"));
    expect(summary.harness.attempts).toHaveLength(1);
  });

  it("returns non-zero when harness validation fails", async () => {
    const dir = await mkdir(path.join(os.tmpdir(), `agent-cli-harness-fail-${Date.now()}`), { recursive: true });
    const summaryPath = path.join(dir, "summary.json");

    const code = await runSolveCommand(
      [
        "--workspace",
        dir,
        "--instruction",
        "write invalid js",
        "--provider",
        "deepseek",
        "--permission-mode",
        "yolo",
        "--summary-json",
        summaryPath,
        "--validation-mode",
        "auto",
        "--validation-timeout-sec",
        "5"
      ],
      {
        modelClientFactory: (_provider: ProviderName, _options: ProviderOptions) => new WriteInvalidJsModel()
      }
    );

    expect(code).toBe(1);
    const summary = JSON.parse(await readFile(summaryPath, "utf8"));
    expect(summary).toMatchObject({ status: "error", finish_reason: "validation_failed" });
    expect(summary.harness.validation_results[0]).toMatchObject({ exit_code: expect.any(Number) });
  });
});
