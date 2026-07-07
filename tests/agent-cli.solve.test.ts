import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
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

  it("parses new tool, context, MCP, and stream flags", () => {
    const config = loadCliConfig({
      workspace: "work",
      provider: "deepseek",
      "allowed-tools": "read,grep",
      "disabled-tools": "bash",
      "no-project-instructions": true,
      "project-doc-max-bytes": "1234",
      "context-mode": "off",
      "repo-map-max-chars": "5678",
      "enable-mcp": true,
      "mcp-config": ".agent/custom-mcp.json",
      "no-stream-ui": true
    });

    expect(config).toMatchObject({
      allowedTools: ["read", "grep"],
      disabledTools: ["bash"],
      noProjectInstructions: true,
      projectDocMaxBytes: 1234,
      contextMode: "off",
      repoMapMaxChars: 5678,
      enableMcp: true,
      mcpConfig: ".agent/custom-mcp.json",
      noStreamUi: true
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

  it("prints live stream UI to stderr unless disabled", async () => {
    const dir = await mkdir(path.join(os.tmpdir(), `agent-cli-stream-${Date.now()}`), { recursive: true });
    const stderr = new MemoryWritable();
    const stdout = new MemoryWritable();

    const code = await runSolveCommand(
      ["--workspace", dir, "--instruction", "finish immediately", "--provider", "deepseek", "--permission-mode", "yolo"],
      {
        stdout,
        stderr,
        modelClientFactory: (_provider: ProviderName, _options: ProviderOptions) => new FinalModel()
      }
    );

    expect(code).toBe(0);
    expect(stderr.text()).toContain("run_start");
    expect(stdout.text()).toContain("status=completed");

    const quietStderr = new MemoryWritable();
    const quietStdout = new MemoryWritable();
    const quietDir = await mkdir(path.join(os.tmpdir(), `agent-cli-no-stream-${Date.now()}`), { recursive: true });
    await runSolveCommand(
      [
        "--workspace",
        quietDir,
        "--instruction",
        "finish immediately",
        "--provider",
        "deepseek",
        "--permission-mode",
        "yolo",
        "--no-stream-ui"
      ],
      {
        stdout: quietStdout,
        stderr: quietStderr,
        modelClientFactory: (_provider: ProviderName, _options: ProviderOptions) => new FinalModel()
      }
    );
    expect(quietStderr.text()).toBe("");
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

  it("prints enabled MCP server errors to stderr and preserves summary data", async () => {
    const dir = await mkdir(path.join(os.tmpdir(), `agent-cli-mcp-${Date.now()}`), { recursive: true });
    const agentDir = path.join(dir, ".agent");
    await mkdir(agentDir, { recursive: true });
    const summaryPath = path.join(dir, "summary.json");
    await writeFile(
      path.join(agentDir, "mcp.json"),
      `${JSON.stringify(
        {
          servers: {
            local: {
              command: process.execPath,
              args: ["missing-mcp-server.mjs"],
              startupTimeoutSec: 1
            }
          }
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const stdout = new MemoryWritable();
    const stderr = new MemoryWritable();
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
        "--enable-mcp",
        "--mcp-config",
        ".agent/mcp.json",
        "--summary-json",
        summaryPath,
        "--no-stream-ui"
      ],
      {
        stdout,
        stderr,
        modelClientFactory: (_provider: ProviderName, _options: ProviderOptions) => new FinalModel()
      }
    );

    expect(code).toBe(0);
    expect(stderr.text()).toContain("[sigma] mcp_error server=local error=");
    expect(stdout.text()).toContain("status=completed");
    const summary = JSON.parse(await readFile(summaryPath, "utf8"));
    expect(summary.mcp_servers).toEqual([
      expect.objectContaining({
        name: "local",
        enabled: true,
        tools_loaded: 0,
        error: expect.any(String)
      })
    ]);
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
