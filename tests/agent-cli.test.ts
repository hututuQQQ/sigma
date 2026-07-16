import { mkdir, mkdtemp, readFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import type { ModelCapabilities, ModelGateway, ModelMessage, ModelRequest, ModelResponse, ModelStreamEvent, ModelToolDefinition } from "../packages/agent-protocol/src/index.js";
import { runAgentCommand } from "../packages/agent-cli/src/index.js";
import { runDoctorCommand } from "../packages/agent-cli/src/commands/doctor.js";
import { runInitCommand } from "../packages/agent-cli/src/commands/init.js";
import { runReplayCommand } from "../packages/agent-cli/src/commands/replay.js";
import { runCommand } from "../packages/agent-cli/src/commands/run.js";
import { runSessionCommand, runSessionsCommand } from "../packages/agent-cli/src/commands/session.js";
import { loadCliConfig, parseArgs } from "../packages/agent-cli/src/config.js";
import { createRuntime } from "../packages/agent-runtime/src/testing.js";
import { repositoryListJsonLines } from "../packages/agent-runtime/src/repository-statistics-provider.js";
import { SegmentedJsonlStore } from "../packages/agent-store/src/index.js";
import { EffectToolRegistry, registerBuiltinTools } from "../packages/agent-tools/src/index.js";
import { createHostExecutionBroker } from "./helpers/host-execution-broker.js";

class Capture extends Writable {
  readonly chunks: Buffer[] = [];
  isTTY = false;
  _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    callback();
  }
  text(): string { return Buffer.concat(this.chunks).toString("utf8"); }
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

class FakeGateway implements ModelGateway {
  readonly provider = "fake";
  readonly model = "fake";
  readonly capabilities: ModelCapabilities = {
    contextWindowTokens: 16_000, maxOutputTokens: 2_000, tools: true, parallelTools: true,
    reasoning: false, structuredOutput: false, promptCache: false, tokenizer: "approximate"
  };
  constructor(private readonly responses: ModelResponse[]) {}
  async complete(request: ModelRequest): Promise<ModelResponse> {
    void request;
    const response = this.responses.shift();
    if (!response) throw new Error("No fake response.");
    return withFixtureUsage(response);
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

async function completedRuntime(workspace: string) {
  const storeRootDir = path.join(workspace, ".agent");
  const runtime = createRuntime({
    gateway: new FakeGateway([{ message: { role: "assistant", content: "done" }, finishReason: "stop" }]),
    store: new SegmentedJsonlStore({ rootDir: storeRootDir }),
    storeRootDir,
    tools: registerBuiltinTools(new EffectToolRegistry(), { repositoryList: repositoryListJsonLines }),
    permissionMode: "auto",
    runDeadlineMs: 5_000
  });
  const session = await runtime.createSession({ workspacePath: workspace, mode: "analyze" });
  await runtime.command({ type: "submit", sessionId: session.sessionId, text: "inspect", mode: "analyze" });
  await runtime.waitForOutcome(session.sessionId);
  return { runtime, sessionId: session.sessionId };
}

describe("Sigma CLI", () => {
  it("rejects unknown options at the schema boundary", () => {
    expect(() => parseArgs(["--validation-mode", "auto"])).toThrow("Unknown option");
  });

  it("creates and loads the TOML configuration", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-cli-init-"));
    const stdout = new Capture();
    await expect(runInitCommand(["--workspace", workspace, "--provider", "glm", "--permission-mode", "auto"], { stdout })).resolves.toBe(0);
    expect(stdout.text()).toContain("initialized");
    const stored = await readFile(path.join(workspace, ".agent", "config.toml"), "utf8");
    expect(stored).toContain("[runtime]");
    expect(loadCliConfig({ workspace }).provider).toBe("glm");
  });

  it("returns NeedsInput before a non-interactive change run in ask mode", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-cli-ask-"));
    const stdout = new Capture();
    const stderr = new Capture();
    const stdin = Object.assign(new PassThrough(), { isTTY: false });
    const code = await runCommand(["change something", "--workspace", workspace, "--output-format", "json"], { stdin, stdout, stderr });
    expect(code).toBe(2);
    expect(JSON.parse(stdout.text())).toMatchObject({ status: "needs_input" });
  });

  it("runs inspect through RuntimeClient in analyze mode", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-cli-inspect-"));
    const stdout = new Capture();
    const stderr = new Capture();
    const stdin = Object.assign(new PassThrough(), { isTTY: false });
    const code = await runCommand(["review architecture", "--workspace", workspace, "--output-format", "json", "--permission-mode", "auto"], {
      mode: "analyze",
      stdin,
      stdout,
      stderr,
      gatewayFactory: () => new FakeGateway([{ message: { role: "assistant", content: "analysis" }, finishReason: "stop" }]),
      executionBroker: createHostExecutionBroker()
    });
    expect(code).toBe(0);
    expect(JSON.parse(stdout.text())).toMatchObject({ status: "completed", finalMessage: "analysis" });
  });

  it("keeps the complete CLI instruction as the semantic goal while shortening only the title", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-cli-goal-"));
    const workspace = path.join(root, "workspace");
    const stateRootDir = path.join(root, "state");
    await mkdir(workspace);
    const instruction = `${"Inspect the repository using general evidence. ".repeat(3)}Retain this trailing requirement.`;
    const stdout = new Capture();
    const stderr = new Capture();
    const stdin = Object.assign(new PassThrough(), { isTTY: false });

    await expect(runCommand([
      instruction, "--workspace", workspace, "--output-format", "json", "--permission-mode", "auto"
    ], {
      mode: "analyze",
      stdin,
      stdout,
      stderr,
      stateRootDir,
      gatewayFactory: () => new FakeGateway([
        { message: { role: "assistant", content: "analysis" }, finishReason: "stop" }
      ]),
      executionBroker: createHostExecutionBroker()
    })).resolves.toBe(0);

    const store = new SegmentedJsonlStore({ rootDir: stateRootDir });
    const session = (await store.listSessions())[0];
    if (!session) throw new Error("Expected a durable CLI session.");
    const events = [];
    for await (const event of store.events(session.sessionId)) events.push(event);
    const initialPlan = events.find((event) => event.type === "plan.updated")?.payload as {
      plan?: { goal?: string; nodes?: Array<{ title?: string }> };
    } | undefined;
    expect(initialPlan?.plan?.goal).toBe(instruction);
    expect(initialPlan?.plan?.nodes?.[0]?.title).toBe(instruction.slice(0, 80));
  });

  it("lists, shows, and replays sessions through RuntimeClient", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-cli-session-"));
    const { runtime, sessionId } = await completedRuntime(workspace);
    const listed = new Capture();
    await expect(runSessionsCommand(["--json"], { runtime, stdout: listed })).resolves.toBe(0);
    expect(JSON.parse(listed.text()).sessions[0].sessionId).toBe(sessionId);
    const shown = new Capture();
    await expect(runSessionCommand(["show", sessionId, "--json"], { runtime, stdout: shown })).resolves.toBe(0);
    expect(JSON.parse(shown.text()).events.length).toBeGreaterThan(0);
    const replayed = new Capture();
    await expect(runReplayCommand([sessionId, "--json", "--timeline"], { runtime, stdout: replayed })).resolves.toBe(0);
    expect(JSON.parse(replayed.text())).toMatchObject({ sessionId, state: { status: "completed" } });
  });

  it("reports readiness without exposing credentials", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-cli-doctor-"));
    const stdout = new Capture();
    await expect(runDoctorCommand(["--workspace", workspace, "--json"], {
      stdout,
      executionBroker: createHostExecutionBroker()
    })).resolves.toBe(0);
    const report = JSON.parse(stdout.text());
    expect(report.checks.some((item: { name: string }) => item.name === "workspace")).toBe(true);
    expect(stdout.text()).not.toContain(process.env.DEEPSEEK_API_KEY ?? "__missing_secret__");
  });

  it("injects the only RuntimeClient boundary into the TUI", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-cli-tui-"));
    const canonicalWorkspace = await realpath(workspace);
    let received = false;
    await expect(runAgentCommand(["tui", "--workspace", workspace], {
      runtimeFactoryDeps: { executionBroker: createHostExecutionBroker() },
      tuiRunner: async (options) => {
        received = typeof options.runtime.command === "function" && options.workspace === canonicalWorkspace;
      }
    })).resolves.toBe(0);
    expect(received).toBe(true);
  });
});
