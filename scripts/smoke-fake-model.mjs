import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

export const fakeToolCall = (id, name, args) => ({ id, name, arguments: args });

export function fakeToolTurn(toolCalls) {
  return {
    message: { role: "assistant", content: "", toolCalls },
    finishReason: "tool_calls",
    inputTokens: 1,
    outputTokens: 1
  };
}

export function fakeValidationTurn(id, checks) {
  return fakeToolTurn([fakeToolCall(id, "verify_smoke_files", { checks })]);
}

export function fakeProcessValidationTurn(id, relativePath, expected) {
  return () => fakeToolTurn([fakeToolCall(id, "validate", {
      executable: "./pnpm",
      args: ["run", "verify-smoke", relativePath, expected],
      access: "readonly"
    })]);
}

export function fakeReviewerTurn() {
  return {
    message: { role: "assistant", content: JSON.stringify({ verdict: "approved", findings: [] }) },
    finishReason: "stop",
    inputTokens: 1,
    outputTokens: 1
  };
}

export function smokeRuntimeConfig(workspace) {
  return {
    workspace,
    provider: "deepseek",
    model: "smoke-fake-model",
    permissionMode: "auto",
    runDeadlineSec: 30,
    modelDeadlineSec: 10,
    streamIdleSec: 5,
    maxParallelTools: 4,
    maxParallelAgents: 1,
    mcpServers: [],
    mcpSource: "none",
    sandboxMode: "required",
    networkMode: "none"
  };
}

export function createSmokeExecutionBroker() {
  const report = {
    protocolVersion: 1,
    brokerVersion: "smoke",
    platform: process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux",
    architecture: process.arch,
    sandbox: { available: true, backend: "smoke", selfTestPassed: true, setupRequired: false },
    capabilities: {
      foreground: true, background: false, stdin: false, pty: false, networkModes: ["none"], shells: []
    }
  };
  const exited = (ok, output) => ({
    state: "exited", exitCode: ok ? 0 : 1, signal: null, durationMs: 1,
    timedOut: false, idleTimedOut: false, cancelled: false,
    stdout: ok ? output : "", stderr: ok ? "" : output,
    stdoutDroppedBytes: 0, stderrDroppedBytes: 0, outputTruncated: false
  });
  return {
    lostProcessHandles: [],
    connect: async () => report,
    doctor: async () => report,
    execute: async (input) => {
      const [run, script, relativePath, expected] = input.command.args;
      if (path.basename(input.command.executable).replace(/\.(?:cmd|exe)$/iu, "").toLowerCase() !== "pnpm"
        || run !== "run" || script !== "verify-smoke") {
        return exited(false, "unexpected smoke validation command");
      }
      try {
        const actual = await readFile(path.resolve(input.command.cwd, relativePath), "utf8");
        return exited(actual === expected, actual === expected ? "validation passed" : "content mismatch");
      } catch (error) {
        return exited(false, error instanceof Error ? error.message : String(error));
      }
    },
    spawn: async () => { throw new Error("Smoke broker does not support background processes."); },
    poll: async () => { throw new Error("Smoke broker has no background processes."); },
    write: async () => { throw new Error("Smoke broker has no background processes."); },
    terminate: async () => { throw new Error("Smoke broker has no background processes."); },
    close: async () => undefined
  };
}

export function registerSmokeValidator(registry) {
  registry.register({
    descriptor: {
      name: "verify_smoke_files",
      description: "Verify smoke file postconditions and return linked validation evidence.",
      inputSchema: { type: "object" },
      possibleEffects: ["filesystem.read", "validation"],
      executionMode: "parallel",
      resourceKeys: ["workspace:read"],
      approval: "auto",
      idempotent: true,
      timeoutMs: 5_000
    },
    async execute(request, context) {
      const startedAt = new Date().toISOString();
      const failures = [];
      for (const check of request.arguments.checks ?? []) {
        try {
          const content = await readFile(path.resolve(context.workspacePath, check.path), "utf8");
          if (content !== check.expected) failures.push(`${check.path} content mismatch`);
        } catch (error) {
          failures.push(`${check.path}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      const completedAt = new Date().toISOString();
      const ok = failures.length === 0;
      return {
        callId: request.callId,
        ok,
        output: ok ? "smoke validation passed" : failures.join("\n"),
        observedEffects: ["filesystem.read", "validation"],
        actualEffects: ["filesystem.read", "validation"],
        artifacts: [],
        diagnostics: failures,
        evidence: [{
          evidenceId: `raw-validation:${request.callId}`,
          sessionId: context.sessionId,
          runId: context.runId,
          kind: "validation",
          status: ok ? "passed" : "failed",
          createdAt: completedAt,
          producer: { authority: "tool", id: request.callId },
          summary: ok ? "Smoke postconditions passed." : "Smoke postconditions failed.",
          data: { validator: "smoke_content_check", artifactIds: [], workspaceDeltaEvidenceIds: [] }
        }],
        startedAt,
        completedAt
      };
    }
  });
  return registry;
}

export function createSmokeReviewer() {
  return {
    reviewerId: "smoke-independent-reviewer",
    async review(input) {
      return {
        evidenceId: randomUUID(),
        sessionId: input.sessionId,
        runId: input.runId,
        kind: "review",
        status: "passed",
        createdAt: new Date().toISOString(),
        producer: { authority: "runtime", id: "smoke-independent-reviewer" },
        summary: "Smoke reviewer approved the validated durable delta.",
        data: {
          reviewerId: "smoke-independent-reviewer",
          verdict: "approved",
          findings: [],
          frontierRevision: input.frontierRevision,
          stateDigest: input.stateDigest,
          validationEvidenceIds: input.validations.map((item) => item.evidenceId)
        }
      };
    }
  };
}

export function fakeFinalTurn(content = "done") {
  return () => ({
    message: {
      role: "assistant",
      content
    },
    finishReason: "stop",
    inputTokens: 1,
    outputTokens: 1
    });
}

export class SmokeFakeGateway {
  provider = "fake";
  model = "smoke-fake-model";
  capabilities = {
    contextWindowTokens: 16_000,
    maxOutputTokens: 2_000,
    tools: true,
    parallelTools: true,
    reasoning: false,
    structuredOutput: false,
    promptCache: false,
    tokenizer: "approximate"
  };

  constructor(responses = [fakeFinalTurn()]) {
    this.responses = [...responses];
    this.requests = [];
  }

  async complete(request) {
    this.requests.push(request);
    const scripted = this.responses.shift();
    if (!scripted) throw new Error("The generic fake gateway has no scripted response remaining.");
    return typeof scripted === "function" ? scripted(request) : scripted;
  }

  async *stream(request) {
    const response = await this.complete(request);
    if (response.message.content) yield { type: "content", delta: response.message.content };
    yield { type: "done", response };
  }

  async countTokens(messages, tools = []) {
    return Math.ceil(JSON.stringify({ messages, tools }).length / 4);
  }
}

export const SmokeFakeModel = SmokeFakeGateway;
