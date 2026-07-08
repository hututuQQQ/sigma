import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import type { ModelClient, ModelRequest, ModelResponse, ProviderName, ProviderOptions } from "../packages/agent-ai/src/index.js";
import { loadCliConfig, parseArgs } from "../packages/agent-cli/src/config.js";
import { runAgentCommand } from "../packages/agent-cli/src/index.js";
import { runRunCommand } from "../packages/agent-cli/src/commands/run.js";

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

class WriteThenFinalModel implements ModelClient {
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
              id: "write-file",
              type: "function",
              function: { name: "write", arguments: { path: "approval.txt", content: "approved\n", createDirs: true } }
            }
          ]
        }
      },
      {
        message: { role: "assistant", content: "done after approval" },
        usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 }
      }
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

function ttyReadable(input: string): NodeJS.ReadableStream & { isTTY?: boolean } {
  const stream = Readable.from([input]) as NodeJS.ReadableStream & { isTTY?: boolean };
  stream.isTTY = true;
  return stream;
}

describe("agent-cli run", () => {
  it("parses harness flags", () => {
    const config = loadCliConfig({
      workspace: "work",
      provider: "deepseek",
      "validation-mode": "auto",
      "validation-command": "npm test",
      "validation-retry-limit": "2",
      "validation-timeout-sec": "45",
      "precheck-command": "pytest",
      "precheck-timeout-sec": "30",
      "post-run-cleanup-globs": "/tmp/cache*.tmp,/tmp/other*.tmp",
      "harness-timeout-sec": "600",
      "retry-min-budget-sec": "90",
      "attempts-dir": "/tmp/agent/attempts"
    });

    expect(config).toMatchObject({
      validationMode: "auto",
      validationCommands: ["npm test"],
      validationRetryLimit: 2,
      validationTimeoutSec: 45,
      precheckCommand: "pytest",
      precheckTimeoutSec: 30,
      postRunCleanupGlobs: ["/tmp/cache*.tmp", "/tmp/other*.tmp"],
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
      "compaction-mode": "model-sub-session",
      "compaction-model": "compact-model",
      "compaction-provider": "glm",
      "compaction-max-input-chars": "1111",
      "compaction-max-output-chars": "2222",
      "compaction-timeout-sec": "42",
      "compaction-fallback": "fail",
      "final-evidence-mode": "auto",
      "skills-mode": "off",
      "skills-max-chars": "123",
      "no-subagents": true,
      "subagent-max-turns": "3",
      "subagent-max-output-chars": "4567",
      "no-review-anti-gaming": true,
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
      compactionMode: "model_sub_session",
      compactionModel: "compact-model",
      compactionProvider: "glm",
      compactionMaxInputChars: 1111,
      compactionMaxOutputChars: 2222,
      compactionTimeoutSec: 42,
      compactionFallback: "fail",
      finalEvidenceMode: "auto",
      skillsMode: "off",
      skillsMaxChars: 123,
      subagentsEnabled: false,
      subagentMaxTurns: 3,
      subagentMaxOutputChars: 4567,
      reviewAntiGaming: false,
      enableMcp: true,
      mcpConfig: ".agent/custom-mcp.json",
      noStreamUi: true
    });
  });

  it("parses output flags and positional instructions", () => {
    const parsed = parseArgs(["Fix failing tests", "--json", "--quiet"]);
    expect(parsed.positionals).toEqual(["Fix failing tests"]);
    const flagFirst = parseArgs(["--json", "Fix failing tests"]);
    expect(flagFirst.flags.json).toBe(true);
    expect(flagFirst.positionals).toEqual(["Fix failing tests"]);
    expect(loadCliConfig({ workspace: "work", provider: "deepseek", "output-format": "stream-json" })).toMatchObject({
      outputFormat: "stream-json",
      noStreamUi: true
    });
    expect(loadCliConfig({ workspace: "work", provider: "deepseek", json: true, quiet: true })).toMatchObject({
      outputFormat: "json",
      quiet: true,
      noStreamUi: true
    });
  });

  it("defaults MVP capability layers on and supports explicit off switches", () => {
    expect(loadCliConfig({ workspace: "work", provider: "deepseek" })).toMatchObject({
      compactionMode: "model_sub_session",
      maxMessageHistoryChars: 120000,
      validationMode: "auto",
      finalEvidenceMode: "auto",
      subagentsEnabled: true
    });
    expect(loadCliConfig({ workspace: "work", provider: "deepseek", "compaction-mode": "deterministic" }).compactionMode).toBe("deterministic");
    expect(loadCliConfig({ workspace: "work", provider: "deepseek", "compaction-mode": "off" }).compactionMode).toBe("off");
    expect(loadCliConfig({ workspace: "work", provider: "deepseek", "max-message-history-chars": "0" }).maxMessageHistoryChars).toBe(0);
    expect(loadCliConfig({ workspace: "work", provider: "deepseek", "validation-mode": "off" }).validationMode).toBe("off");
    expect(loadCliConfig({ workspace: "work", provider: "deepseek", "final-evidence-mode": "off" }).finalEvidenceMode).toBe("off");
    expect(loadCliConfig({ workspace: "work", provider: "deepseek", "no-subagents": true }).subagentsEnabled).toBe(false);
  });

  it("loads sectioned TOML config with arrays, booleans, and numbers", async () => {
    const dir = await mkdir(path.join(os.tmpdir(), `agent-cli-config-${Date.now()}`), { recursive: true });
    await mkdir(path.join(dir, ".agent"), { recursive: true });
    await writeFile(
      path.join(dir, ".agent", "config.toml"),
      [
        "[run]",
        'provider = "glm"',
        'model = "glm-config"',
        "max_turns = 30",
        "max_wall_time_sec = 1800",
        'permission_mode = "yolo"',
        "",
        "[validation]",
        'mode = "auto"',
        "retry_limit = 1",
        'commands = ["pnpm test", "pnpm lint"]',
        "",
        "[context]",
        'compaction_mode = "off"',
        "compaction_timeout_sec = 7",
        "",
        "[subagents]",
        "enabled = true",
        "max_turns = 2",
        "",
        "[review]",
        "anti_gaming = false",
        "",
        "[tools]",
        'allowed = ["read", "write"]',
        'disabled = ["bash"]',
        "",
        "[mcp]",
        "enabled = true",
        'config = ".agent/mcp.json"',
        "",
        "[tui]",
        "stream_ui = true"
      ].join("\n"),
      "utf8"
    );

    const config = loadCliConfig({ workspace: dir });

    expect(config).toMatchObject({
      provider: "glm",
      model: "glm-config",
      maxTurns: 30,
      maxWallTimeSec: 1800,
      permissionMode: "yolo",
      validationMode: "auto",
      validationRetryLimit: 1,
      validationCommands: ["pnpm test", "pnpm lint"],
      compactionMode: "off",
      compactionTimeoutSec: 7,
      subagentsEnabled: true,
      subagentMaxTurns: 2,
      reviewAntiGaming: false,
      allowedTools: ["read", "write"],
      disabledTools: ["bash"],
      enableMcp: true,
      mcpConfig: ".agent/mcp.json",
      noStreamUi: false
    });
  });

  it("applies root CLI config precedence to agent tui dispatch", async () => {
    const dir = await mkdir(path.join(os.tmpdir(), `agent-cli-tui-config-${Date.now()}`), { recursive: true });
    await mkdir(path.join(dir, ".agent"), { recursive: true });
    await writeFile(
      path.join(dir, ".agent", "config.toml"),
      [
        "[run]",
        'provider = "glm"',
        'permission_mode = "yolo"',
        "",
        "[validation]",
        'mode = "auto"'
      ].join("\n"),
      "utf8"
    );
    const calls: Array<{ provider: string; permissionMode: string; validationMode?: string; workspace: string }> = [];

    await expect(
      runAgentCommand(["tui", "--workspace", dir], {
        tuiRunner: async (options) => {
          calls.push(options);
        }
      })
    ).resolves.toBe(0);

    expect(calls[0]).toMatchObject({
      workspace: dir,
      provider: "glm",
      permissionMode: "yolo",
      validationMode: "auto"
    });

    await expect(
      runAgentCommand(["tui", "--workspace", dir, "--provider", "deepseek", "--permission-mode", "ask", "--validation-mode", "off"], {
        tuiRunner: async (options) => {
          calls.push(options);
        }
      })
    ).resolves.toBe(0);

    expect(calls[1]).toMatchObject({
      provider: "deepseek",
      permissionMode: "ask",
      validationMode: "off"
    });
  });

  it("ignores top-level config keys and keeps env and CLI precedence", async () => {
    const dir = await mkdir(path.join(os.tmpdir(), `agent-cli-config-legacy-${Date.now()}`), { recursive: true });
    await mkdir(path.join(dir, ".agent"), { recursive: true });
    await writeFile(
      path.join(dir, ".agent", "config.toml"),
      [
        'provider = "glm"',
        'model = "from-config"',
        "max_turns = 11",
        'allowed_tools = ["read"]'
      ].join("\n"),
      "utf8"
    );
    const previousModel = process.env.AGENT_MODEL;
    process.env.AGENT_MODEL = "from-env";
    try {
      expect(loadCliConfig({ workspace: dir })).toMatchObject({
        provider: "deepseek",
        model: "from-env",
        maxTurns: 20,
        allowedTools: []
      });
      expect(loadCliConfig({ workspace: dir, model: "from-cli", "max-turns": "22" })).toMatchObject({
        model: "from-cli",
        maxTurns: 22
      });
    } finally {
      if (previousModel === undefined) delete process.env.AGENT_MODEL;
      else process.env.AGENT_MODEL = previousModel;
    }
  });

  it("runs with an injected fake provider and writes summary JSON", async () => {
    const dir = await mkdir(path.join(os.tmpdir(), `agent-cli-${Date.now()}`), { recursive: true });
    const summaryPath = path.join(dir, "summary.json");
    const tracePath = path.join(dir, "trace.jsonl");

    const code = await runRunCommand(
      [
        "--workspace",
        dir,
        "--instruction",
        "finish immediately",
        "--provider",
        "deepseek",
        "--permission-mode",
        "yolo",
        "--validation-mode",
        "off",
        "--final-evidence-mode",
        "off",
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

  it("supports agent run with a positional instruction", async () => {
    const dir = await mkdir(path.join(os.tmpdir(), `agent-cli-run-${Date.now()}`), { recursive: true });
    const stdout = new MemoryWritable();

    const code = await runRunCommand(
      ["finish immediately", "--workspace", dir, "--provider", "deepseek", "--permission-mode", "yolo", "--no-stream-ui"],
      {
        stdout,
        modelClientFactory: (_provider: ProviderName, _options: ProviderOptions) => new FinalModel()
      }
    );

    expect(code).toBe(0);
    expect(stdout.text()).toContain("status=completed");
  });

  it("prints exactly one parseable JSON result in json mode", async () => {
    const dir = await mkdir(path.join(os.tmpdir(), `agent-cli-json-${Date.now()}`), { recursive: true });
    const stdout = new MemoryWritable();
    const stderr = new MemoryWritable();

    const code = await runRunCommand(
      ["finish immediately", "--workspace", dir, "--provider", "deepseek", "--permission-mode", "yolo", "--json"],
      {
        stdout,
        stderr,
        modelClientFactory: (_provider: ProviderName, _options: ProviderOptions) => new FinalModel()
      }
    );

    expect(code).toBe(0);
    expect(stderr.text()).toBe("");
    const parsed = JSON.parse(stdout.text()) as { status?: string; finalMessage?: string };
    expect(parsed).toMatchObject({ status: "completed", finalMessage: "all set" });
    expect(stdout.text()).not.toContain("status=completed");
  });

  it("keeps JSON stdout pure when interactive approval is requested", async () => {
    const dir = await mkdir(path.join(os.tmpdir(), `agent-cli-json-approval-${Date.now()}`), { recursive: true });
    const stdin = ttyReadable("n\n");
    const stdout = new MemoryWritable();
    const stderr = new MemoryWritable();

    const code = await runRunCommand(
      ["write a file", "--workspace", dir, "--provider", "deepseek", "--permission-mode", "ask", "--json"],
      {
        stdin,
        stdout,
        stderr,
        modelClientFactory: (_provider: ProviderName, _options: ProviderOptions) => new WriteThenFinalModel()
      }
    );

    expect(code).toBe(0);
    const stdoutText = stdout.text();
    const stdoutLines = stdoutText.trim().split(/\r?\n/);
    expect(stdoutLines).toHaveLength(1);
    const parsed = JSON.parse(stdoutText) as { status?: string; finalMessage?: string };
    expect(parsed).toMatchObject({ status: "completed", finalMessage: "done after approval" });
    expect(stdoutText).not.toMatch(/Tool:|Risk:|Allow\?|\[sigma\]|status=completed/);
    expect(stderr.text()).toContain("Tool: write");
    expect(stderr.text()).toContain("Risk: write");
    expect(stderr.text()).toContain("Allow?");
  });

  it("prints valid JSONL events and a final result in stream-json mode", async () => {
    const dir = await mkdir(path.join(os.tmpdir(), `agent-cli-stream-json-${Date.now()}`), { recursive: true });
    const stdout = new MemoryWritable();
    const stderr = new MemoryWritable();

    const code = await runRunCommand(
      [
        "finish immediately",
        "--workspace",
        dir,
        "--provider",
        "deepseek",
        "--permission-mode",
        "yolo",
        "--output-format",
        "stream-json"
      ],
      {
        stdout,
        stderr,
        modelClientFactory: (_provider: ProviderName, _options: ProviderOptions) => new FinalModel()
      }
    );

    expect(code).toBe(0);
    expect(stderr.text()).toBe("");
    const lines = stdout.text().trim().split(/\r?\n/);
    const records = lines.map((line) => JSON.parse(line) as { type: string });
    expect(records.length).toBeGreaterThan(0);
    expect(records.some((record) => record.type === "event")).toBe(true);
    expect(records[records.length - 1]).toMatchObject({ type: "result" });
  });

  it("keeps stream-json stdout pure while --stream-ui writes human lines to stderr", async () => {
    const dir = await mkdir(path.join(os.tmpdir(), `agent-cli-stream-json-ui-${Date.now()}`), { recursive: true });
    const stdout = new MemoryWritable();
    const stderr = new MemoryWritable();

    const code = await runRunCommand(
      [
        "finish immediately",
        "--workspace",
        dir,
        "--provider",
        "deepseek",
        "--permission-mode",
        "yolo",
        "--output-format",
        "stream-json",
        "--stream-ui"
      ],
      {
        stdout,
        stderr,
        modelClientFactory: (_provider: ProviderName, _options: ProviderOptions) => new FinalModel()
      }
    );

    expect(code).toBe(0);
    const records = stdout.text().trim().split(/\r?\n/).map((line) => JSON.parse(line) as { type: string });
    expect(records.length).toBeGreaterThan(0);
    expect(records[records.length - 1]).toMatchObject({ type: "result" });
    expect(stderr.text()).toContain("[sigma] run_start");
  });

  it("prints run help and rejects removed command aliases", async () => {
    const runStdout = new MemoryWritable();
    await expect(runRunCommand(["--help"], { stdout: runStdout })).resolves.toBe(0);
    expect(runStdout.text()).toContain("agent run [instruction] [flags]");
    expect(runStdout.text()).toContain("Run the autonomous coding agent once.");

    const stdout = new MemoryWritable();
    const stderr = new MemoryWritable();
    const previousWrite = process.stdout.write;
    const previousErrorWrite = process.stderr.write;
    try {
      process.stdout.write = stdout.write.bind(stdout) as typeof process.stdout.write;
      process.stderr.write = stderr.write.bind(stderr) as typeof process.stderr.write;
      await expect(runAgentCommand(["solve", "--help"], { tuiRunner: async () => {} })).resolves.toBe(1);
      await expect(runAgentCommand(["history"], { tuiRunner: async () => {} })).resolves.toBe(1);
      await expect(runAgentCommand(["completion", "bash"])).resolves.toBe(0);
    } finally {
      process.stdout.write = previousWrite;
      process.stderr.write = previousErrorWrite;
    }
    expect(stderr.text()).toContain("Unknown command: solve");
    expect(stderr.text()).toContain("Unknown command: history");
    expect(stdout.text()).not.toContain("solve");
    expect(stdout.text()).toContain('compgen -W "run tui chat sessions session checkpoints checkpoint completion doctor replay"');
  });

  it("prints only the final message in quiet text mode", async () => {
    const dir = await mkdir(path.join(os.tmpdir(), `agent-cli-quiet-${Date.now()}`), { recursive: true });
    const stdout = new MemoryWritable();

    const code = await runRunCommand(
      ["finish immediately", "--workspace", dir, "--provider", "deepseek", "--permission-mode", "yolo", "--quiet"],
      {
        stdout,
        modelClientFactory: (_provider: ProviderName, _options: ProviderOptions) => new FinalModel()
      }
    );

    expect(code).toBe(0);
    expect(stdout.text()).toBe("all set\n");
  });

  it("prints live stream UI to stderr unless disabled", async () => {
    const dir = await mkdir(path.join(os.tmpdir(), `agent-cli-stream-${Date.now()}`), { recursive: true });
    const stderr = new MemoryWritable();
    const stdout = new MemoryWritable();

    const code = await runRunCommand(
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
    await runRunCommand(
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

    const code = await runRunCommand(
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
    const code = await runRunCommand(
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
        transport: "stdio",
        tools_loaded: 0,
        error: expect.any(String)
      })
    ]);
  });

  it("returns non-zero when harness validation fails", async () => {
    const dir = await mkdir(path.join(os.tmpdir(), `agent-cli-harness-fail-${Date.now()}`), { recursive: true });
    const summaryPath = path.join(dir, "summary.json");

    const code = await runRunCommand(
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
