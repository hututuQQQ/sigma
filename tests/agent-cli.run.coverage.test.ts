import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import type {
  ModelCapabilities,
  ModelGateway,
  ModelMessage,
  ModelRequest,
  ModelResponse,
  ModelStreamEvent,
  ModelToolDefinition
} from "../packages/agent-protocol/src/index.js";
import { runCommand } from "../packages/agent-cli/src/commands/run.js";
import { describe, expect, it } from "vitest";
import { typedCompletion } from "./helpers/typed-evidence.js";
import { createHostExecutionBroker } from "./helpers/host-execution-broker.js";

class Capture extends Writable {
  readonly chunks: Buffer[] = [];
  isTTY = false;

  _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    callback();
  }

  text(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

const FIXTURE_USAGE = {
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  providerReported: true,
  costMicroUsd: 0,
  latencyMs: 0,
  retryAttempt: 0
} as const;

function withFixtureUsage(response: ModelResponse): ModelResponse {
  return response.usage ? response : { ...response, usage: FIXTURE_USAGE };
}

type ScriptedResponse = ModelResponse | Error | ((request: ModelRequest) => ModelResponse);

class ScriptedGateway implements ModelGateway {
  readonly provider = "scripted";
  readonly model = "scripted";
  readonly capabilities: ModelCapabilities = {
    contextWindowTokens: 16_000,
    maxOutputTokens: 2_000,
    tools: true,
    parallelTools: true,
    reasoning: false,
    structuredOutput: false,
    promptCache: false,
    tokenizer: "approximate"
  };

  constructor(private readonly script: ScriptedResponse[]) {}

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const next = this.script.shift();
    if (next instanceof Error) throw next;
    if (!next) throw new Error("Scripted gateway exhausted.");
    return withFixtureUsage(typeof next === "function" ? next(request) : next);
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    const response = await this.complete(request);
    if (response.message.content) yield { type: "content", delta: response.message.content };
    yield { type: "done", response };
  }

  async countTokens(messages: ModelMessage[], tools: ModelToolDefinition[] = []): Promise<number> {
    return JSON.stringify({ messages, tools }).length / 4;
  }
}

class IncompleteStreamGateway implements ModelGateway {
  readonly provider = "incomplete";
  readonly model = "incomplete";
  readonly capabilities: ModelCapabilities = {
    contextWindowTokens: 16_000,
    maxOutputTokens: 2_000,
    tools: true,
    parallelTools: false,
    reasoning: true,
    structuredOutput: false,
    promptCache: false,
    tokenizer: "approximate"
  };

  async complete(_request: ModelRequest): Promise<ModelResponse> {
    throw new Error("not used");
  }

  async *stream(_request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    yield { type: "reasoning", delta: "unfinished" };
  }

  async countTokens(messages: ModelMessage[], tools: ModelToolDefinition[] = []): Promise<number> {
    return JSON.stringify({ messages, tools }).length / 4;
  }
}

function complete(summary: string): (request: ModelRequest) => ModelResponse {
  return (request) => typedCompletion(request, {
    id: `complete-${summary}`,
    summary,
    criterion: "The requested CLI test task is complete."
  });
}

function evidenceRequest(callId: string): ModelResponse {
  return {
    message: {
      role: "assistant",
      content: "",
      toolCalls: [{ id: callId, name: "list", arguments: { path: ".", limit: 20 } }]
    },
    finishReason: "tool_calls"
  };
}

function writeRequest(): ModelResponse {
  return {
    message: {
      role: "assistant",
      content: "planning",
      toolCalls: [{
        id: "write-call",
        name: "write",
        arguments: { path: "approval-result.md", content: "approved" }
      }]
    },
    finishReason: "tool_calls"
  };
}

function userInputRequest(): ModelResponse {
  return {
    message: {
      role: "assistant",
      content: "",
      toolCalls: [{
        id: "need-target",
        name: "request_user_input",
        arguments: { message: "Which target should I change?" }
      }]
    },
    finishReason: "tool_calls"
  };
}

async function workspace(prefix: string): Promise<string> {
  return await mkdtemp(path.join(os.tmpdir(), prefix));
}

function gatewayFactory(script: ScriptedResponse[]): () => ModelGateway {
  return () => new ScriptedGateway(script);
}

function runDeps(script: ScriptedResponse[]) {
  return { gatewayFactory: gatewayFactory(script), executionBroker: createHostExecutionBroker() };
}

describe("run command branch coverage", () => {
  it("renders both run and inspect help and reports empty instructions", async () => {
    const runHelp = new Capture();
    await expect(runCommand(["--help"], { stdout: runHelp })).resolves.toBe(0);
    expect(runHelp.text()).toContain("agent run");
    const inspectHelp = new Capture();
    await expect(runCommand(["-h"], { mode: "analyze", stdout: inspectHelp })).resolves.toBe(0);
    expect(inspectHelp.text()).toContain("agent inspect");

    const stderr = new Capture();
    const stdin = Object.assign(new PassThrough(), { isTTY: true });
    await expect(runCommand(["--prompt", ""], { stdin, stderr })).resolves.toBe(1);
    expect(stderr.text()).toContain("non-empty instruction");
  });

  it("loads an instruction from a prompt file and renders text output", async () => {
    const root = await workspace("sigma-run-file-");
    const prompt = path.join(root, "prompt.txt");
    await writeFile(prompt, "inspect from file\n", "utf8");
    const stdout = new Capture();
    const stderr = new Capture();
    const stdin = Object.assign(new PassThrough(), { isTTY: true });
    stdout.isTTY = true;
    const code = await runCommand([
      "--prompt-file", prompt,
      "--workspace", root,
      "--permission-mode", "auto"
    ], { stdin, stdout, stderr, mode: "analyze", ...runDeps([
      evidenceRequest("file-evidence"), complete("file complete")
    ]) });
    expect(code).toBe(0);
    expect(stdout.text()).toContain("file complete");
  });

  it("uses inline prompts and emits streaming JSON events and a result", async () => {
    const root = await workspace("sigma-run-stream-");
    const stdout = new Capture();
    const stderr = new Capture();
    const stdin = Object.assign(new PassThrough(), { isTTY: true });
    stdout.isTTY = true;
    const code = await runCommand([
      "--prompt", "inline prompt",
      "--workspace", root,
      "--permission-mode", "auto",
      "--output-format", "stream-json"
    ], { stdin, stdout, stderr, ...runDeps([
      evidenceRequest("stream-evidence"), complete("stream complete")
    ]) });
    expect(code).toBe(0);
    const records = stdout.text().trim().split(/\r?\n/).map((line) => JSON.parse(line) as { type: string });
    expect(records.some((record) => record.type === "model.started")).toBe(true);
    expect(records.some((record) => record.type === "run.completed")).toBe(true);
    expect(records.at(-1)?.type).toBe("result");
  });

  it.each([true, false])("reads instructions from stdin (explicit=%s)", async (explicit) => {
    const root = await workspace("sigma-run-stdin-");
    const stdin = Object.assign(new PassThrough(), { isTTY: false });
    stdin.end("stdin prompt\n");
    const stdout = new Capture();
    const stderr = new Capture();
    const argv = [
      ...(explicit ? ["--stdin"] : []),
      "--workspace", root,
      "--permission-mode", "auto",
      "--output-format", "json"
    ];
    const code = await runCommand(argv, {
      stdin,
      stdout,
      stderr,
      mode: "analyze",
      ...runDeps([
        evidenceRequest("stdin-evidence"), complete("stdin complete")
      ])
    });
    expect(code).toBe(0);
    expect(JSON.parse(stdout.text())).toMatchObject({ status: "completed", finalMessage: "stdin complete" });
  });

  it("renders non-interactive NeedsInput in text and stream-json formats", async () => {
    for (const format of ["text", "stream-json"] as const) {
      const root = await workspace("sigma-run-needs-input-");
      const stdin = Object.assign(new PassThrough(), { isTTY: false });
      const stdout = new Capture();
      const stderr = new Capture();
      const code = await runCommand([
        "change files", "--workspace", root, "--output-format", format
      ], { stdin, stdout, stderr });
      expect(code).toBe(2);
      if (format === "text") expect(stderr.text()).toContain("cannot resolve tool approvals");
      else expect(JSON.parse(stdout.text())).toMatchObject({ status: "needs_input" });
    }
  });

  it("returns when the model requests user input during a non-TUI run", async () => {
    const root = await workspace("sigma-run-model-input-");
    const stdin = Object.assign(new PassThrough(), { isTTY: true });
    const stdout = new Capture();
    stdout.isTTY = true;
    const stderr = new Capture();
    const running = runCommand([
      "choose a target", "--workspace", root, "--permission-mode", "auto", "--output-format", "json"
    ], { stdin, stdout, stderr, ...runDeps([userInputRequest()]) });
    const code = await Promise.race([
      running,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("run command hung after NeedsInput")), 2_000))
    ]);
    expect(code).toBe(2);
    expect(JSON.parse(stdout.text())).toMatchObject({
      status: "needs_input", finishReason: "needs_input", finalMessage: "Which target should I change?"
    });
  });

  it.each([
    ["a", true, "tool.completed"],
    ["yes", true, "tool.completed"],
    ["n", false, "tool.failed"]
  ] as const)("handles interactive approval answer '%s'", async (answer, allowed, eventType) => {
    const root = await workspace("sigma-run-approval-");
    const stdin = Object.assign(new PassThrough(), { isTTY: true });
    stdin.end(`${answer}\n`);
    const stdout = new Capture();
    stdout.isTTY = true;
    const stderr = new Capture();
    const completion = allowed ? complete("approved complete") : complete("denied complete");
    const script = allowed
      ? [writeRequest(), completion]
      : [writeRequest(), evidenceRequest("denial-evidence"), completion];
    const code = await runCommand([
      "write approval result",
      "--workspace", root,
      "--permission-mode", "ask",
      ...(allowed ? ["--waive-reviewer"] : [])
    ], { stdin, stdout, stderr, ...runDeps(script) });
    expect(code).toBe(0);
    expect(stderr.text()).toContain(eventType);
    if (allowed) expect(await import("node:fs/promises").then((fs) => fs.readFile(path.join(root, "approval-result.md"), "utf8"))).toBe("approved");
  });

  it("maps model failures to an error result and exit code one", async () => {
    const root = await workspace("sigma-run-failure-");
    const stdout = new Capture();
    const stderr = new Capture();
    const stdin = Object.assign(new PassThrough(), { isTTY: true });
    stdout.isTTY = true;
    const code = await runCommand([
      "fail safely",
      "--workspace", root,
      "--permission-mode", "auto",
      "--output-format", "json"
    ], { stdin, stdout, stderr, ...runDeps([new Error("provider unavailable")]) });
    expect(code).toBe(1);
    expect(JSON.parse(stdout.text())).toMatchObject({
      status: "error",
      finalMessage: expect.stringContaining(
        "Model route 'default' failed on 'deepseek/deepseek-v4-pro' (protocol)."
      )
    });
    expect(JSON.parse(stdout.text()).finalMessage).toContain("provider unavailable");
  });

  it("does not exit successfully when a model stream ends without a final response", async () => {
    const root = await workspace("sigma-run-incomplete-stream-");
    const stdout = new Capture();
    const stderr = new Capture();
    const stdin = Object.assign(new PassThrough(), { isTTY: true });
    stdout.isTTY = true;
    const code = await runCommand([
      "fail an incomplete stream safely",
      "--workspace", root,
      "--permission-mode", "auto",
      "--output-format", "stream-json"
    ], {
      stdin,
      stdout,
      stderr,
      gatewayFactory: () => new IncompleteStreamGateway(),
      executionBroker: createHostExecutionBroker()
    });
    const records = stdout.text().trim().split(/\r?\n/).map((line) => JSON.parse(line) as {
      type: string;
      status?: string;
      payload?: { code?: string };
    });

    expect(code).toBe(1);
    expect(records.find((record) => record.type === "model.failed")?.payload?.code)
      .toBe("model_stream_incomplete");
    expect(records.some((record) => record.type === "run.failed")).toBe(true);
    expect(records.at(-1)).toMatchObject({ type: "result", status: "error" });
  });

  it("reports prompt-file read failures through stderr", async () => {
    const stderr = new Capture();
    const stdin = Object.assign(new PassThrough(), { isTTY: true });
    await expect(runCommand(["--prompt-file", path.join(os.tmpdir(), "missing-sigma-prompt")], {
      stdin,
      stderr
    })).resolves.toBe(1);
    expect(stderr.text()).toBeTruthy();
  });

  it("emits a typed stream-json error envelope for pre-run failures", async () => {
    const stdout = new Capture();
    const stderr = new Capture();
    const stdin = Object.assign(new PassThrough(), { isTTY: true });
    await expect(runCommand([
      "--prompt-file", path.join(os.tmpdir(), "missing-sigma-stream-prompt"),
      "--output-format", "stream-json"
    ], { stdin, stdout, stderr })).resolves.toBe(1);
    expect(JSON.parse(stdout.text())).toMatchObject({ schemaVersion: 3, kind: "error", type: "error" });
    expect(stderr.text()).toBe("");
  });
});
