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
import { runV2Command } from "../packages/agent-cli/src/commands/run-v2.js";
import { describe, expect, it } from "vitest";

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

  constructor(private readonly script: Array<ModelResponse | Error>) {}

  async complete(_request: ModelRequest): Promise<ModelResponse> {
    const next = this.script.shift();
    if (next instanceof Error) throw next;
    if (!next) throw new Error("Scripted gateway exhausted.");
    return next;
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

function complete(summary: string, evidenceCallIds: string[] = []): ModelResponse {
  return {
    message: {
      role: "assistant",
      content: "",
      toolCalls: [{
        id: `complete-${summary}`,
        name: "complete_task",
        arguments: {
          summary,
          criteria: [{
            criterion: "The requested CLI test task is complete.",
            status: "met",
            evidenceCallIds
          }]
        }
      }]
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
        arguments: { path: "approval-result.txt", content: "approved" }
      }]
    },
    finishReason: "tool_calls"
  };
}

async function workspace(prefix: string): Promise<string> {
  return await mkdtemp(path.join(os.tmpdir(), prefix));
}

function gatewayFactory(script: Array<ModelResponse | Error>): () => ModelGateway {
  return () => new ScriptedGateway(script);
}

describe("run v2 command branch coverage", () => {
  it("renders both run and inspect help and reports empty instructions", async () => {
    const runHelp = new Capture();
    await expect(runV2Command(["--help"], { stdout: runHelp })).resolves.toBe(0);
    expect(runHelp.text()).toContain("agent run");
    const inspectHelp = new Capture();
    await expect(runV2Command(["-h"], { mode: "analyze", stdout: inspectHelp })).resolves.toBe(0);
    expect(inspectHelp.text()).toContain("agent inspect");

    const stderr = new Capture();
    const stdin = Object.assign(new PassThrough(), { isTTY: true });
    await expect(runV2Command(["--prompt", ""], { stdin, stderr })).resolves.toBe(1);
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
    const code = await runV2Command([
      "--prompt-file", prompt,
      "--workspace", root,
      "--permission-mode", "auto"
    ], { stdin, stdout, stderr, mode: "analyze", gatewayFactory: gatewayFactory([
      evidenceRequest("file-evidence"), complete("file complete", ["file-evidence"])
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
    const code = await runV2Command([
      "--prompt", "inline prompt",
      "--workspace", root,
      "--permission-mode", "auto",
      "--output-format", "stream-json"
    ], { stdin, stdout, stderr, gatewayFactory: gatewayFactory([
      evidenceRequest("stream-evidence"), complete("stream complete", ["stream-evidence"])
    ]) });
    expect(code).toBe(0);
    const records = stdout.text().trim().split(/\r?\n/).map((line) => JSON.parse(line) as { type: string });
    expect(records.some((record) => record.type === "model.started")).toBe(true);
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
    const code = await runV2Command(argv, {
      stdin,
      stdout,
      stderr,
      mode: "analyze",
      gatewayFactory: gatewayFactory([
        evidenceRequest("stdin-evidence"), complete("stdin complete", ["stdin-evidence"])
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
      const code = await runV2Command([
        "change files", "--workspace", root, "--output-format", format
      ], { stdin, stdout, stderr });
      expect(code).toBe(2);
      if (format === "text") expect(stderr.text()).toContain("cannot resolve tool approvals");
      else expect(JSON.parse(stdout.text())).toMatchObject({ status: "needs_input" });
    }
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
    const completion = allowed ? complete("approved complete", ["write-call"]) : complete("denied complete", ["denial-evidence"]);
    const script = allowed
      ? [writeRequest(), completion]
      : [writeRequest(), evidenceRequest("denial-evidence"), completion];
    const code = await runV2Command([
      "write approval result",
      "--workspace", root,
      "--permission-mode", "ask"
    ], { stdin, stdout, stderr, gatewayFactory: gatewayFactory(script) });
    expect(code).toBe(0);
    expect(stderr.text()).toContain(eventType);
    if (allowed) expect(await import("node:fs/promises").then((fs) => fs.readFile(path.join(root, "approval-result.txt"), "utf8"))).toBe("approved");
  });

  it("maps model failures to an error result and exit code one", async () => {
    const root = await workspace("sigma-run-failure-");
    const stdout = new Capture();
    const stderr = new Capture();
    const stdin = Object.assign(new PassThrough(), { isTTY: true });
    stdout.isTTY = true;
    const code = await runV2Command([
      "fail safely",
      "--workspace", root,
      "--permission-mode", "auto",
      "--output-format", "json"
    ], { stdin, stdout, stderr, gatewayFactory: gatewayFactory([new Error("provider unavailable")]) });
    expect(code).toBe(1);
    expect(JSON.parse(stdout.text())).toMatchObject({ status: "error", finalMessage: "provider unavailable" });
  });

  it("reports prompt-file read failures through stderr", async () => {
    const stderr = new Capture();
    const stdin = Object.assign(new PassThrough(), { isTTY: true });
    await expect(runV2Command(["--prompt-file", path.join(os.tmpdir(), "missing-sigma-prompt")], {
      stdin,
      stderr
    })).resolves.toBe(1);
    expect(stderr.text()).toBeTruthy();
  });
});
