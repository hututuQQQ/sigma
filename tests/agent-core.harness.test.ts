import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ModelClient, ModelRequest, ModelResponse } from "../packages/agent-ai/src/index.js";
import { runHarnessCommand } from "../packages/agent-core/src/harness/validation.js";
import { planValidationCommandSpecs } from "../packages/agent-core/src/harness/validation-planner.js";
import {
  runAgentHarness,
  runAgentWithController,
  AgentEventBus,
  listSessions,
  type AgentRunControllerConfig,
  type AgentRunControllerSummary,
  type RunControllerCleanupResult,
  type RunControllerCommandResult,
  type RunControllerRetryDecision,
  type RunControllerServiceCleanupResult,
  type SandboxAdapter,
  type SandboxExecRequest
} from "../packages/agent-core/src/index.js";

class SequenceModel implements ModelClient {
  readonly provider = "deepseek" as const;
  readonly model = "fake-run-controller-model";
  readonly requests: ModelRequest[] = [];
  private index = 0;

  constructor(private readonly responses: ModelResponse[]) {}

  async complete(req: ModelRequest): Promise<ModelResponse> {
    this.requests.push(req);
    const response = this.responses[Math.min(this.index, this.responses.length - 1)];
    this.index += 1;
    return response;
  }
}

function finalResponse(content = "done"): ModelResponse {
  return { message: { role: "assistant", content } };
}

function writeResponse(filePath: string, content: string): ModelResponse {
  return {
    message: {
      role: "assistant",
      toolCalls: [
        {
          id: `write-${filePath}-${Math.random()}`,
          type: "function",
          function: { name: "write", arguments: { path: filePath, content, createDirs: true } }
        }
      ]
    }
  };
}

function bashResponse(command: string): ModelResponse {
  return {
    message: {
      role: "assistant",
      toolCalls: [
        {
          id: `bash-${Math.random()}`,
          type: "function",
          function: { name: "bash", arguments: { command } }
        }
      ]
    }
  };
}

class AbortStreamingModel implements ModelClient {
  readonly provider = "deepseek" as const;
  readonly model = "fake-abort-stream-model";
  readonly requests: ModelRequest[] = [];

  constructor(private readonly controller: AbortController) {}

  async complete(_req: ModelRequest): Promise<ModelResponse> {
    throw new Error("complete should not be called when stream is available");
  }

  async *stream(req: ModelRequest) {
    this.requests.push(req);
    yield { type: "message_delta" as const, data: { delta: "partial" } };
    this.controller.abort();
    yield { type: "message_delta" as const, data: { delta: " ignored" } };
  }
}

class AwaitEventModel implements ModelClient {
  readonly provider = "deepseek" as const;
  readonly model = "fake-event-model";

  constructor(private readonly ready: () => Promise<void>) {}

  async complete(_req: ModelRequest): Promise<ModelResponse> {
    await this.ready();
    return finalResponse("events written");
  }
}

async function tempWorkspace(): Promise<string> {
  return await mkdtemp(path.join(os.tmpdir(), "agent-run-controller-"));
}

async function waitForFileContaining(filePath: string, needle: string, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      if ((await readFile(filePath, "utf8")).includes(needle)) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${needle} in ${filePath}: ${lastError instanceof Error ? lastError.message : ""}`);
}

function acceptRunControllerAliases(
  _config: AgentRunControllerConfig,
  _summary: AgentRunControllerSummary,
  _command: RunControllerCommandResult,
  _decision: RunControllerRetryDecision,
  _cleanup: RunControllerCleanupResult,
  _serviceCleanup: RunControllerServiceCleanupResult
): void {}

describe("agent-core harness", () => {
  it("exports run-controller aliases for the existing controller API", () => {
    expect(runAgentWithController).toBe(runAgentHarness);
    acceptRunControllerAliases(
      {} as AgentRunControllerConfig,
      {} as AgentRunControllerSummary,
      {} as RunControllerCommandResult,
      {} as RunControllerRetryDecision,
      {} as RunControllerCleanupResult,
      {} as RunControllerServiceCleanupResult
    );
  });

  it("kills timed-out validation commands that ignore SIGTERM", async () => {
    const dir = await tempWorkspace();
    const startedAt = Date.now();

    const result = await runHarnessCommand({
      kind: "validation",
      source: "test",
      command: 'trap "" TERM; sleep 5',
      workspacePath: dir,
      attempt: 1,
      timeoutSec: 0.1
    });

    expect(result).toMatchObject({
      exit_code: 124,
      timed_out: true,
      settled_on: expect.any(String)
    });
    expect(result.signal).toEqual(expect.any(String));
    expect(Date.now() - startedAt).toBeLessThan(3000);
  });

  it("returns after shell exit even when a background child keeps stdout open", async () => {
    const dir = await tempWorkspace();
    const startedAt = Date.now();

    const result = await runHarnessCommand({
      kind: "validation",
      source: "test",
      command: "sleep 5 & printf done",
      workspacePath: dir,
      attempt: 1,
      timeoutSec: 2
    });

    expect(result.exit_code).toBe(0);
    expect(result.stdout_tail).toContain("done");
    expect(result.settled_on).toMatch(/close|exit-drain/);
    expect(result.timed_out).toBeUndefined();
    expect(Date.now() - startedAt).toBeLessThan(3000);
  });

  it("runs harness commands through the sandbox adapter and records metadata", async () => {
    const dir = await tempWorkspace();
    const seenRequests: SandboxExecRequest[] = [];
    const adapter: SandboxAdapter = {
      async prepareExec(request) {
        seenRequests.push(request);
        return {
          allowed: true,
          command: process.execPath,
          args: ["-e", "process.stdout.write('sandboxed')"],
          cwd: request.cwd,
          env: request.env,
          metadata: { enforcement: "test-sandbox", fallbackAllowed: false }
        };
      }
    };

    const result = await runHarnessCommand({
      kind: "validation",
      source: "test",
      command: "echo should-be-transformed",
      workspacePath: dir,
      attempt: 1,
      timeoutSec: 5,
      sandbox: { mode: "workspace-write", backend: "external" },
      sandboxAdapter: adapter
    });

    expect(result.exit_code).toBe(0);
    expect(result.stdout_tail).toBe("sandboxed");
    expect(result.sandbox).toMatchObject({ enforcement: "test-sandbox", fallbackAllowed: false });
    expect(seenRequests[0]).toMatchObject({
      toolName: "harness.validation",
      command: "echo should-be-transformed",
      workspacePath: dir
    });
  });

  it("plans cheap syntax checks for changed files", async () => {
    const dir = await tempWorkspace();
    const specs = await planValidationCommandSpecs({
      workspacePath: dir,
      changedFiles: [
        "check.py",
        "check-cert.py",
        "check.cert.py",
        "validate.sh",
        "test.js",
        "verify-log.py",
        "main.py",
        "parser.js"
      ]
    });
    const commands = specs.map((spec) => spec.command);

    expect(commands).toContain("python -m py_compile check.py");
    expect(commands).toContain("python -m py_compile check-cert.py");
    expect(commands).toContain("python -m py_compile check.cert.py");
    expect(commands).toContain("bash -n validate.sh");
    expect(commands).toContain("python -m py_compile verify-log.py");
    expect(commands).toContain("python -m py_compile main.py");
    expect(commands.some((command) => command.includes("node --check parser.js"))).toBe(true);
    expect(commands.some((command) => /(?:^|[ ;])node parser\.js(?:[ ;]|$)/.test(command))).toBe(false);
  });

  it("combines explicitly configured validation with v2 changed-file checks", async () => {
    const dir = await tempWorkspace();
    const specs = await planValidationCommandSpecs({
      workspacePath: dir,
      configuredCommands: ["npm test"],
      changedFiles: ["main.py"]
    });

    expect(specs.map((spec) => spec.source)).toEqual(["configured", "changed-file"]);
    expect(specs.map((spec) => spec.command)).toEqual(["npm test", "python -m py_compile main.py"]);
  });

  it("keeps validationMode=off as a single agent run", async () => {
    const dir = await tempWorkspace();
    const model = new SequenceModel([finalResponse("all set")]);

    const result = await runAgentHarness({
      instruction: "finish",
      workspacePath: dir,
      modelClient: model,
      validationMode: "off",
      permissionMode: "yolo"
    });

    expect(result.status).toBe("completed");
    expect(result.harness).toBeUndefined();
    expect(model.requests).toHaveLength(1);
  });

  it("runs generic validation for changed JavaScript files", async () => {
    const dir = await tempWorkspace();
    const summaryPath = path.join(dir, "summary.json");
    const model = new SequenceModel([writeResponse("parser.js", "const answer = 42;\n"), finalResponse()]);

    const result = await runAgentHarness({
      instruction: "write js",
      workspacePath: dir,
      modelClient: model,
      validationMode: "auto",
      validationTimeoutSec: 5,
      permissionMode: "yolo",
      summaryJsonPath: summaryPath
    });

    expect(result.status).toBe("completed");
    const summary = JSON.parse(await readFile(summaryPath, "utf8"));
    expect(summary.validation_plan.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          command: expect.stringContaining("node --check parser.js"),
          scope: "syntax",
          kind: "compile",
          reason: expect.any(String)
        })
      ])
    );
    expect(summary.harness.validation_results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ command: expect.stringContaining("node --check parser.js"), exit_code: 0 })
      ])
    );
    expect(summary.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          toolName: "harness.validation",
          executable: true,
          command: expect.stringContaining("node --check parser.js"),
          exitCode: 0
        })
      ])
    );
  });

  it("keeps stream cancellation from being overwritten by validation or retry", async () => {
    const dir = await tempWorkspace();
    const controller = new AbortController();

    const result = await runAgentHarness({
      instruction: "abort stream",
      workspacePath: dir,
      modelClient: new AbortStreamingModel(controller),
      validationMode: "auto",
      validationCommands: ["node -e \"process.exit(1)\""],
      validationRetryLimit: 1,
      validationTimeoutSec: 5,
      permissionMode: "yolo",
      abortSignal: controller.signal
    });

    expect(result.status).toBe("stopped");
    expect(result.finishReason).toBe("cancelled");
    expect(result.harness?.attempts).toHaveLength(1);
    expect(result.harness?.validation_results).toEqual([]);
    expect(result.harness?.retry_decisions).toEqual([]);
  });

  it("keeps tool cancellation from being overwritten by validation or retry", async () => {
    const dir = await tempWorkspace();
    const controller = new AbortController();
    const eventBus = new AgentEventBus();
    eventBus.on((event) => {
      if (event.type === "tool_start") controller.abort();
    });
    const model = new SequenceModel([bashResponse("node -e \"setTimeout(() => {}, 5000)\"")]);

    const result = await runAgentHarness({
      instruction: "abort tool",
      workspacePath: dir,
      modelClient: model,
      validationMode: "auto",
      validationCommands: ["node -e \"process.exit(1)\""],
      validationRetryLimit: 1,
      validationTimeoutSec: 5,
      commandTimeoutSec: 10,
      permissionMode: "yolo",
      eventBus,
      abortSignal: controller.signal
    });

    expect(result.status).toBe("stopped");
    expect(result.finishReason).toBe("cancelled");
    expect(result.harness?.attempts).toHaveLength(1);
    expect(result.harness?.validation_results).toEqual([]);
    expect(result.harness?.retry_decisions).toEqual([]);
  });

  it("retries after validation failure and preserves attempt artifacts", async () => {
    const dir = await tempWorkspace();
    const summaryPath = path.join(dir, "summary.json");
    const attemptsDir = path.join(dir, "attempts");
    const model = new SequenceModel([
      writeResponse("bad.js", "function nope(\n"),
      finalResponse("first done"),
      writeResponse("bad.js", "function ok() { return 1; }\n"),
      finalResponse("fixed")
    ]);

    const result = await runAgentHarness({
      instruction: "fix js",
      workspacePath: dir,
      modelClient: model,
      validationMode: "auto",
      finalEvidenceMode: "off",
      validationRetryLimit: 1,
      validationTimeoutSec: 5,
      permissionMode: "yolo",
      summaryJsonPath: summaryPath,
      attemptsDir
    });

    expect(result.status).toBe("completed");
    const retryRequest = model.requests.find((request) =>
      request.messages.some((message) => message.role === "user" && String(message.content).includes("Validation failure 1"))
    );
    expect(retryRequest).toBeTruthy();
    const retryInstruction = retryRequest?.messages.find((message) => message.role === "user")?.content;
    expect(String(retryInstruction)).toContain("The previous attempt failed post-run checks.");
    expect(String(retryInstruction).toLowerCase()).not.toContain("harness");
    const summary = JSON.parse(await readFile(summaryPath, "utf8"));
    expect(summary.harness.retry_decisions).toEqual([expect.objectContaining({ action: "started", trigger: "validation" })]);
    await expect(stat(path.join(attemptsDir, "attempt-1", "summary.json"))).resolves.toBeTruthy();
    await expect(stat(path.join(attemptsDir, "attempt-2", "summary.json"))).resolves.toBeTruthy();
  });

  it("stores large tool output artifacts under attempt directories", async () => {
    const dir = await tempWorkspace();
    const runDir = await mkdtemp(path.join(os.tmpdir(), "sigma-harness-artifacts-"));
    const attemptsDir = path.join(runDir, "attempts");
    const summaryPath = path.join(runDir, "summary.json");
    const payload = "HARNESS_FULL_OUTPUT_".repeat(80);
    const model = new SequenceModel([
      bashResponse(`printf '${payload}'`),
      finalResponse("done")
    ]);

    const result = await runAgentHarness({
      instruction: "capture large output",
      workspacePath: dir,
      modelClient: model,
      validationMode: "off",
      finalEvidenceMode: "off",
      reviewAntiGaming: false,
      permissionMode: "yolo",
      maxToolOutputChars: 80,
      summaryJsonPath: summaryPath,
      attemptsDir
    });

    const artifact = result.toolRuntime?.artifacts[0];
    expect(result.status).toBe("completed");
    expect(artifact?.path).toContain(attemptsDir.split(path.sep).join("/"));
    await expect(readFile(artifact?.path ?? "", "utf8")).resolves.toContain(payload);
    await expect(stat(path.join(dir, ".agent", "artifacts"))).rejects.toThrow();
  });

  it("returns a failed result when validation retry limit is exhausted", async () => {
    const dir = await tempWorkspace();
    const model = new SequenceModel([writeResponse("bad.js", "function nope(\n"), finalResponse()]);

    const result = await runAgentHarness({
      instruction: "write invalid js",
      workspacePath: dir,
      modelClient: model,
      validationMode: "auto",
      validationRetryLimit: 0,
      validationTimeoutSec: 5,
      permissionMode: "yolo"
    });

    expect(result.status).toBe("error");
    expect(result.finishReason).toBe("validation_failed");
  });

  it("records validation failure as the final durable session status", async () => {
    const dir = await tempWorkspace();
    const model = new SequenceModel([finalResponse("attempt completed")]);

    const result = await runAgentHarness({
      instruction: "finish but fail validation",
      workspacePath: dir,
      modelClient: model,
      validationMode: "auto",
      validationCommands: ["node -e \"process.stderr.write('validation failed'); process.exit(1)\""],
      validationRetryLimit: 0,
      validationTimeoutSec: 5,
      permissionMode: "yolo"
    });

    expect(result.status).toBe("error");
    expect(result.finishReason).toBe("validation_failed");
    expect(result.sessionId).toEqual(expect.any(String));

    const sessions = await listSessions({ workspacePath: dir });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      sessionId: result.sessionId,
      status: "error",
      finishReason: "validation_failed"
    });
    const summary = JSON.parse(await readFile(sessions[0].summaryPath, "utf8"));
    expect(summary).toMatchObject({
      status: "error",
      finish_reason: "validation_failed",
      harness: {
        validation_results: [
          expect.objectContaining({
            kind: "validation",
            exit_code: 1
          })
        ]
      }
    });
    const eventsText = await readFile(sessions[0].eventsPath, "utf8");
    expect(eventsText).toContain("\"attempt\":1");
    expect(eventsText).toContain("harness_check_start");
    expect(eventsText).toContain("run_start");
  });

  it("appends parent durable events while the attempt is still running", async () => {
    const dir = await tempWorkspace();
    const sessionRootDir = path.join(dir, ".agent", "sessions");
    const eventBus = new AgentEventBus();
    let resolveRunStart!: () => void;
    let rejectRunStart!: (error: unknown) => void;
    const runStartWritten = new Promise<void>((resolve, reject) => {
      resolveRunStart = resolve;
      rejectRunStart = reject;
    });
    let armed = false;
    eventBus.on((event) => {
      if (armed || event.type !== "run_start" || !event.sessionId) return;
      armed = true;
      const eventsPath = path.join(sessionRootDir, event.sessionId, "events.jsonl");
      void waitForFileContaining(eventsPath, "\"type\":\"run_start\"").then(resolveRunStart, rejectRunStart);
    });

    const result = await runAgentHarness({
      instruction: "finish after parent event write",
      workspacePath: dir,
      sessionRootDir,
      modelClient: new AwaitEventModel(() => runStartWritten),
      validationMode: "auto",
      validationCommands: ["node -e \"process.exit(0)\""],
      validationRetryLimit: 0,
      validationTimeoutSec: 5,
      permissionMode: "yolo",
      eventBus
    });

    expect(result.status).toBe("completed");
    expect(result.sessionId).toEqual(expect.any(String));
    const eventsPath = path.join(sessionRootDir, result.sessionId ?? "", "events.jsonl");
    const events = (await readFile(eventsPath, "utf8"))
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { type: string; metadata?: { attempt?: number } });
    expect(events.filter((event) => event.type === "run_start")).toHaveLength(1);
    expect(events.filter((event) => event.type === "harness_check_start")).toHaveLength(1);
    expect(events.find((event) => event.type === "run_start")?.metadata?.attempt).toBe(1);
    expect(events.find((event) => event.type === "harness_check_start")?.metadata?.attempt).toBe(1);
  });

  it("records precheck failure as the final durable session status", async () => {
    const dir = await tempWorkspace();
    const model = new SequenceModel([finalResponse("attempt completed")]);

    const result = await runAgentHarness({
      instruction: "finish but fail precheck",
      workspacePath: dir,
      modelClient: model,
      validationMode: "off",
      validationRetryLimit: 0,
      precheckCommand: "node -e \"process.stderr.write('precheck failed'); process.exit(1)\"",
      precheckTimeoutSec: 5,
      permissionMode: "yolo"
    });

    expect(result.status).toBe("error");
    expect(result.finishReason).toBe("precheck_failed");
    expect(model.requests).toHaveLength(0);

    const sessions = await listSessions({ workspacePath: dir });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      sessionId: result.sessionId,
      status: "error",
      finishReason: "precheck_failed"
    });
    const summary = JSON.parse(await readFile(sessions[0].summaryPath, "utf8"));
    expect(summary.harness.attempts).toEqual([]);
    expect(summary.harness.precheck_results).toEqual([
      expect.objectContaining({
        kind: "precheck",
        exit_code: 1
      })
    ]);
  });

  it("runs a passing precheck before the agent attempt", async () => {
    const dir = await tempWorkspace();
    const model = new SequenceModel([finalResponse("first")]);

    const result = await runAgentHarness({
      instruction: "finish",
      workspacePath: dir,
      modelClient: model,
      validationMode: "off",
      validationRetryLimit: 1,
      precheckCommand: "node -e \"process.exit(0)\"",
      precheckTimeoutSec: 5,
      permissionMode: "yolo"
    });

    expect(result.status).toBe("completed");
    expect(model.requests).toHaveLength(1);
    expect(result.harness?.precheck_results).toEqual([
      expect.objectContaining({ kind: "precheck", exit_code: 0, attempt: 1 })
    ]);
  });

  it("runs post-run cleanup and records warnings separately from success", async () => {
    const dir = await tempWorkspace();
    const target = path.join(dir, "cleanup.tmp");
    await writeFile(target, "cleanup", "utf8");
    const summaryPath = path.join(dir, "summary.json");
    const model = new SequenceModel([finalResponse("done")]);

    const result = await runAgentHarness({
      instruction: "finish",
      workspacePath: dir,
      modelClient: model,
      validationMode: "off",
      postRunCleanupGlobs: [target],
      permissionMode: "yolo",
      summaryJsonPath: summaryPath
    });

    expect(result.status).toBe("completed");
    const summary = JSON.parse(await readFile(summaryPath, "utf8"));
    expect(summary.harness.post_run_cleanup).toMatchObject({ patterns: [target], exit_code: 0 });
    await expect(stat(target)).rejects.toThrow();
  });
});
