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
import {
  runCommand,
  runOutcomeExitCode,
  runOutcomeResult
} from "../packages/agent-cli/src/commands/run.js";
import { createModelGateway } from "../packages/agent-model/src/index.js";
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

function complete(summary: string): (request: ModelRequest) => ModelResponse {
  return (request) => typedCompletion(request, {
    id: `complete-${summary}`,
    summary,
    criterion: "The requested CLI test task is complete."
  });
}

function confirmNoChange(id: string): ModelResponse {
  return {
    message: {
      role: "assistant",
      content: "",
      toolCalls: [{ id, name: "confirm_no_change", arguments: {} }]
    },
    finishReason: "tool_calls"
  };
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

function validationRequest(): ModelResponse {
  return {
    message: {
      role: "assistant",
      content: "",
      toolCalls: [{
        id: "validate-approval-result",
        name: "validate",
        arguments: {
          shell: process.platform === "win32" ? "cmd" : "bash",
          command: "npm run build",
          cwd: ".",
          network: "none"
        }
      }]
    },
    finishReason: "tool_calls"
  };
}

function networkExecutionRequest(): ModelResponse {
  return {
    message: {
      role: "assistant",
      content: "",
      toolCalls: [{
        id: "network-exec",
        name: "exec",
        arguments: {
          executable: "node",
          args: ["-e", "process.stdout.write('network-auto-ok')"],
          network: "full"
        }
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
  it("preserves completed-with-limitations status while returning success", () => {
    const outcome = {
      kind: "completed_with_limitations" as const,
      message: "artifact produced",
      evidence: [],
      limitations: [{
        kind: "validation_capability_unavailable" as const,
        claim: "unit" as const,
        attemptedCommandSummary: "pnpm test",
        capabilityEvidenceId: "validation-proof",
        reason: "The test runner is unavailable."
      }]
    };
    expect(runOutcomeExitCode(outcome)).toBe(0);
    expect(runOutcomeResult(outcome, "session-limited")).toMatchObject({
      status: "completed_with_limitations",
      finishReason: "completed_with_limitations",
      sessionId: "session-limited",
      finalMessage: "artifact produced",
      limitations: [{ capabilityEvidenceId: "validation-proof" }]
    });
  });

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
    expect(code, `${stderr.text()}\nSTDOUT:\n${stdout.text()}`).toBe(0);
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
      evidenceRequest("stream-evidence"), complete("stream complete"), confirmNoChange("confirm-stream")
    ]) });
    expect(code).toBe(0);
    const records = stdout.text().trim().split(/\r?\n/).map((line) => JSON.parse(line) as {
      type: string;
      payload?: { validationRequirement?: string };
    });
    expect(records.find((record) => record.type === "run.started")?.payload)
      .toMatchObject({ validationRequirement: "default" });
    expect(records.some((record) => record.type === "model.started")).toBe(true);
    expect(records.some((record) => record.type === "run.completed")).toBe(true);
    expect(records.at(-1)?.type).toBe("result");
  });

  it("runs a non-interactive auto-approved network call without opening readline", async () => {
    const root = await workspace("sigma-run-network-auto-");
    const stdout = new Capture();
    const stderr = new Capture();
    const stdin = Object.assign(new PassThrough(), { isTTY: false });
    const code = await runCommand([
      "run a network-enabled process",
      "--workspace", root,
      "--network", "full",
      "--permission-mode", "auto",
      "--output-format", "stream-json"
    ], { stdin, stdout, stderr, mode: "analyze", ...runDeps([
      networkExecutionRequest(), evidenceRequest("network-evidence"), complete("network complete")
    ]) });

    expect(code).toBe(0);
    const records = stdout.text().trim().split(/\r?\n/).map((line) => JSON.parse(line) as {
      type: string;
      payload?: { approvalMode?: string; decision?: string };
    });
    expect(records.find((record) => record.type === "tool.approval_requested")?.payload)
      .toMatchObject({ approvalMode: "automatic" });
    expect(records.find((record) => record.type === "tool.approval_resolved")?.payload)
      .toMatchObject({ decision: "allow" });
    expect(records.some((record) => record.type === "tool.completed")).toBe(true);
    expect(records.some((record) => record.type === "run.completed")).toBe(true);
    expect(stderr.text()).not.toContain("Allow exec");
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
        "change files", "--workspace", root, "--output-format", format, "--permission-mode", "ask"
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
    await writeFile(path.join(root, "package.json"), JSON.stringify({
      scripts: {
        build: "node -e \"const fs=require('node:fs');process.exit(fs.readFileSync('approval-result.md','utf8')==='approved'?0:1)\""
      }
    }), "utf8");
    const stdin = Object.assign(new PassThrough(), { isTTY: true });
    const stdout = new Capture();
    stdout.isTTY = true;
    const stderr = new Capture();
    const completion = allowed ? complete("approved complete") : complete("denied complete");
    const script = allowed
      ? [writeRequest(), validationRequest(), completion]
      : [writeRequest(), evidenceRequest("denial-evidence"), completion, confirmNoChange("confirm-denial")];
    // Explicit ask mode prompts for both the mutation and its process validation.
    const responses = allowed ? [answer, "a"] : [answer];
    let sent = 0;
    const feeder = setInterval(() => {
      const promptCount = stderr.text().match(/Allow /g)?.length ?? 0;
      while (sent < promptCount && sent < responses.length) {
        stdin.write(`${responses[sent]}\n`);
        sent += 1;
      }
    }, 5);
    const code = await runCommand([
      "write approval result",
      "--workspace", root,
      "--permission-mode", "ask",
      ...(allowed ? ["--waive-reviewer"] : [])
    ], { stdin, stdout, stderr, ...runDeps(script) }).finally(() => {
      clearInterval(feeder);
      stdin.end();
    });
    expect(code, `${stderr.text()}\nSTDOUT:\n${stdout.text()}`).toBe(0);
    expect(stderr.text()).toContain(eventType);
    expect(stderr.text()).toContain("command=write; read=approval-result.md; write=approval-result.md");
    expect(stderr.text()).toContain("backend=native; risk=medium");
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
    let requestBody: Record<string, unknown> | undefined;
    const code = await runCommand([
      "fail an incomplete stream safely",
      "--workspace", root,
      "--permission-mode", "auto",
      "--output-format", "stream-json"
    ], {
      stdin,
      stdout,
      stderr,
      gatewayFactory: () => createModelGateway({
        provider: "deepseek",
        apiKey: "secret",
        maxRetries: 0,
        fetchImpl: (async (_url, init) => {
          requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return new Response(
            `data: ${JSON.stringify({
              choices: [{ delta: { reasoning_content: "unfinished" }, finish_reason: null }]
            })}\n\n`,
            { status: 200, headers: { "content-type": "text/event-stream" } }
          );
        }) as typeof fetch
      }),
      executionBroker: createHostExecutionBroker()
    });
    const records = stdout.text().trim().split(/\r?\n/).map((line) => JSON.parse(line) as {
      type: string;
      status?: string;
      payload?: { code?: string; diagnostics?: Record<string, unknown>; ledger?: {
        reserved?: Record<string, number>;
      } };
    });

    expect(code).toBe(1);
    expect(records.find((record) => record.type === "model.failed")?.payload?.code)
      .toBe("model_stream_protocol_error");
    expect(records.find((record) => record.type === "model.failed")?.payload?.diagnostics).toMatchObject({
      provider: "deepseek",
      model: "deepseek-v4-pro",
      category: "protocol",
      httpStatus: 200,
      doneReceived: false,
      transportEnded: true,
      lastEventType: "reasoning",
      hasContent: false,
      hasReasoning: true,
      hasToolCall: false,
      retryAttempts: 1,
      sseFrames: 1,
      ssePayloads: 1,
      sseTrailingBytes: 0
    });
    expect(records.find((record) => record.type === "budget.committed")?.payload?.ledger?.reserved)
      .toMatchObject({ inputTokens: 0, outputTokens: 0, costMicroUsd: 0, modelTurns: 0 });
    expect(records.some((record) => record.type === "run.failed")).toBe(true);
    expect(records.at(-1)).toMatchObject({ type: "result", status: "error" });
    expect(requestBody).toMatchObject({
      stream: true,
      thinking: { type: "enabled" },
      tools: expect.any(Array)
    });
    expect((requestBody?.tools as unknown[]).length).toBeGreaterThan(0);
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

  it("returns container_unavailable instead of running on the host", async () => {
    const root = await workspace("sigma-run-container-unavailable-");
    const stdout = new Capture();
    const stderr = new Capture();
    const stdin = Object.assign(new PassThrough(), { isTTY: false });
    const code = await runCommand([
      "change one file", "--workspace", root, "--execution-mode", "container", "--output-format", "json"
    ], { stdin, stdout, stderr, ...runDeps([]) });

    expect(code).toBe(1);
    expect(JSON.parse(stdout.text())).toMatchObject({
      status: "error",
      finishReason: "container_unavailable",
      finalMessage: expect.stringContaining("OCI execution backend is not installed")
    });
    expect(stderr.text()).toBe("");
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
