import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import net, { type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ModelClient, ModelRequest, ModelResponse } from "../packages/agent-ai/src/index.js";
import {
  genericValidationCommandSpecs,
  inferTaskHints,
  runHarnessCommand,
  taskSmokeValidationCommandSpecs
} from "../packages/agent-core/src/harness/validation.js";
import { runAgentHarness } from "../packages/agent-core/src/index.js";

class SequenceModel implements ModelClient {
  readonly provider = "deepseek" as const;
  readonly model = "fake-harness-model";
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

async function tempWorkspace(): Promise<string> {
  return await mkdtemp(path.join(os.tmpdir(), "agent-harness-"));
}

describe("agent-core harness", () => {
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
      timed_out: true
    });
    expect(Date.now() - startedAt).toBeLessThan(3000);
  });

  it("runs common changed validation scripts without treating ordinary files as scripts", () => {
    const specs = genericValidationCommandSpecs([
      "check.py",
      "check-cert.py",
      "check.cert.py",
      "validate.sh",
      "test.js",
      "verify-log.py",
      "main.py",
      "parser.js"
    ]);
    const commands = specs.map((spec) => spec.command);

    expect(commands).toEqual(expect.arrayContaining([
      "python check.py",
      "python check-cert.py",
      "python check.cert.py",
      "bash validate.sh",
      "python verify-log.py"
    ]));
    expect(commands.some((command) => command.includes("node test.js"))).toBe(true);
    expect(commands).toContain("python -m py_compile main.py");
    expect(commands.some((command) => command.includes("node --check parser.js"))).toBe(true);
    expect(commands).not.toContain("python main.py");
    expect(commands.some((command) => /(?:^|[ ;])node parser\.js(?:[ ;]|$)/.test(command))).toBe(false);
  });

  it("infers task hints from Terminal-Bench task names", () => {
    expect(inferTaskHints({ taskId: "kv-store-grpc" })).toEqual(expect.arrayContaining(["server", "grpc", "server/grpc"]));
    expect(inferTaskHints({ taskId: "pypi-server" })).toEqual(expect.arrayContaining(["server", "pypi", "server/pypi"]));
    expect(inferTaskHints({ taskId: "filter-js-from-html" })).toEqual(expect.arrayContaining(["html-xss"]));
  });

  it("adds an html-xss task smoke validation that catches dangerous payloads", async () => {
    const dir = await tempWorkspace();
    await writeFile(
      path.join(dir, "filter.mjs"),
      "export default function filter(html) { return html; }\n",
      "utf8"
    );
    const [spec] = taskSmokeValidationCommandSpecs(["filter.mjs"], { taskHints: ["html-xss"] });
    expect(spec).toMatchObject({ source: "task-smoke", relatedFiles: ["filter.mjs"] });

    const result = await runHarnessCommand({
      kind: "validation",
      source: spec.source,
      command: spec.command,
      workspacePath: dir,
      attempt: 1,
      timeoutSec: 5,
      relatedFiles: spec.relatedFiles
    });

    expect(result.exit_code).not.toBe(0);
    expect(result.stderr_tail).toContain("html-xss smoke failed");
  });

  it("uses Python CLI smoke for filter-js-from-html without generating node smoke", async () => {
    const dir = await tempWorkspace();
    await writeFile(
      path.join(dir, "filter.py"),
      [
        "from pathlib import Path",
        "import sys",
        "print(Path(sys.argv[1]).read_text(encoding='utf-8'))",
        ""
      ].join("\n"),
      "utf8"
    );

    const specs = taskSmokeValidationCommandSpecs(["filter.py"], { taskId: "filter-js-from-html" });
    expect(specs).toHaveLength(1);
    expect(specs[0].command).toContain("HTML_XSS_PY_CHANGED");
    expect(specs[0].command).not.toContain("node --input-type");

    const failed = await runHarnessCommand({
      kind: "validation",
      source: specs[0].source,
      command: specs[0].command,
      workspacePath: dir,
      attempt: 1,
      timeoutSec: 10,
      relatedFiles: specs[0].relatedFiles
    });
    expect(failed.exit_code).not.toBe(0);
    expect(failed.stderr_tail).toContain("html-xss python smoke failed");

    await writeFile(
      path.join(dir, "filter.py"),
      [
        "import sys",
        "print('<p>safe</p>')",
        ""
      ].join("\n"),
      "utf8"
    );
    const passed = await runHarnessCommand({
      kind: "validation",
      source: specs[0].source,
      command: specs[0].command,
      workspacePath: dir,
      attempt: 1,
      timeoutSec: 10,
      relatedFiles: specs[0].relatedFiles
    });
    expect(passed.exit_code).toBe(0);
  });

  it("fails server smoke when registered port services are not kept for the verifier", async () => {
    const dir = await tempWorkspace();
    const registry = path.join(dir, "services.json");
    await mkdir(path.dirname(registry), { recursive: true });
    const server = net.createServer((socket) => {
      socket.on("error", () => {});
      socket.end("ok");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const previousRegistry = process.env.AGENT_SERVICE_REGISTRY;

    try {
      process.env.AGENT_SERVICE_REGISTRY = registry;
      const service = {
        name: "grpc-server",
        pid: process.pid,
        command: "test",
        cwd: dir,
        port,
        logPath: path.join(dir, "service.log"),
        keepForVerifier: false,
        startedAt: new Date().toISOString()
      };
      await writeFile(registry, `${JSON.stringify({ services: [service] })}\n`, "utf8");

      const [spec] = taskSmokeValidationCommandSpecs([], { taskId: "kv-store-grpc" });
      const failed = await runHarnessCommand({
        kind: "validation",
        source: spec.source,
        command: spec.command,
        workspacePath: dir,
        attempt: 1,
        timeoutSec: 5
      });
      expect(failed.exit_code).not.toBe(0);
      expect(failed.stderr_tail).toContain("not marked keepForVerifier");

      await writeFile(registry, `${JSON.stringify({ services: [{ ...service, keepForVerifier: true }] })}\n`, "utf8");
      const passed = await runHarnessCommand({
        kind: "validation",
        source: spec.source,
        command: spec.command,
        workspacePath: dir,
        attempt: 1,
        timeoutSec: 5
      });
      expect(passed.exit_code).toBe(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (previousRegistry === undefined) {
        delete process.env.AGENT_SERVICE_REGISTRY;
      } else {
        process.env.AGENT_SERVICE_REGISTRY = previousRegistry;
      }
    }
  });

  it("includes a fresh vectorops install in the PyPI smoke", () => {
    const specs = taskSmokeValidationCommandSpecs([], { taskId: "pypi-server" });
    expect(specs.some((spec) => spec.command.includes("vectorops==0.1.0"))).toBe(true);
    expect(specs.some((spec) => spec.command.includes("dotproduct([1, 2, 3], [4, 5, 6]) == 32"))).toBe(true);
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
    expect(summary.harness.validation_results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ command: expect.stringContaining("node --check parser.js"), exit_code: 0 })
      ])
    );
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
    const summary = JSON.parse(await readFile(summaryPath, "utf8"));
    expect(summary.harness.retry_decisions).toEqual([expect.objectContaining({ action: "started", trigger: "validation" })]);
    await expect(stat(path.join(attemptsDir, "attempt-1", "summary.json"))).resolves.toBeTruthy();
    await expect(stat(path.join(attemptsDir, "attempt-2", "summary.json"))).resolves.toBeTruthy();
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

  it("adds precheck failure details to retry feedback", async () => {
    const dir = await tempWorkspace();
    const model = new SequenceModel([finalResponse("first"), finalResponse("second")]);

    const result = await runAgentHarness({
      instruction: "finish",
      workspacePath: dir,
      modelClient: model,
      validationMode: "off",
      validationRetryLimit: 1,
      precheckCommand: "if [ -f pass ]; then exit 0; else echo missing >&2; touch pass; exit 1; fi",
      precheckTimeoutSec: 5,
      permissionMode: "yolo"
    });

    expect(result.status).toBe("completed");
    const retryRequest = model.requests.find((request) =>
      request.messages.some((message) => message.role === "user" && String(message.content).includes("Precheck failure 1"))
    );
    expect(retryRequest).toBeTruthy();
  });

  it("runs pre-verifier cleanup and records warnings separately from success", async () => {
    const dir = await tempWorkspace();
    const target = path.join(dir, "frame.bmp");
    await writeFile(target, "frame", "utf8");
    const summaryPath = path.join(dir, "summary.json");
    const model = new SequenceModel([finalResponse("done")]);

    const result = await runAgentHarness({
      instruction: "finish",
      workspacePath: dir,
      modelClient: model,
      validationMode: "off",
      preVerifierCleanupGlobs: [target],
      permissionMode: "yolo",
      summaryJsonPath: summaryPath
    });

    expect(result.status).toBe("completed");
    const summary = JSON.parse(await readFile(summaryPath, "utf8"));
    expect(summary.harness.pre_verifier_cleanup).toMatchObject({ patterns: [target], exit_code: 0 });
    await expect(stat(target)).rejects.toThrow();
  });
});
