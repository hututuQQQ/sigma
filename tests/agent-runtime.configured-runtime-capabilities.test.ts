import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type {
  BrokerDoctorReport,
  BrokerVerifiedShell,
  ExecutionBroker
} from "../packages/agent-execution/src/index.js";
import type {
  ModelGateway,
  ModelRequest,
  ModelResponse,
  ModelStreamEvent
} from "../packages/agent-protocol/src/index.js";
import {
  createConfiguredRuntime,
  runtimeNodeBinding,
  runtimeTrustedToolchains,
  runtimeTrustedToolchainsForBinding,
  type RuntimeCompositionConfig
} from "../packages/agent-runtime/src/index.js";
import { afterEach, describe, expect, it, vi } from "vitest";

const fixtures: string[] = [];

it("omits an unproved automatic Windows Node capability without weakening explicit manifests", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sigma-runtime-node-proof-"));
  fixtures.push(root);
  const executable = path.join(root, "node.exe");
  await writeFile(executable, "not an approved Node runtime", "utf8");
  expect(runtimeTrustedToolchains(executable, "win32", "required")).toEqual([]);
  const unsafe = runtimeTrustedToolchains(executable, "win32", "unsafe");
  expect(unsafe).toMatchObject([{
    id: "runtime-node",
    executable: path.resolve(executable)
  }]);
  expect(unsafe[0]).not.toHaveProperty("compatibility");
});

it("binds a host-loaded portable runtime to its canonical bundled Node file", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sigma-portable-runtime-node-"));
  fixtures.push(root);
  const modulePath = path.join(root, "packages", "agent-runtime", "dist", "execution-composition.js");
  const executable = path.join(root, "bin", "node");
  await mkdir(path.dirname(modulePath), { recursive: true });
  await mkdir(path.dirname(executable), { recursive: true });
  await writeFile(modulePath, "export {};\n", "utf8");
  await writeFile(executable, "portable node", "utf8");

  const binding = runtimeNodeBinding(pathToFileURL(modulePath), "linux", process.execPath);
  expect(binding).toEqual({ executable: path.resolve(executable), source: "portable" });
  expect(runtimeTrustedToolchainsForBinding(binding, "linux", "required")).toEqual([{
    id: "runtime-node",
    runtime: "node",
    executable: path.resolve(executable),
    aliases: ["node"],
    executionRoots: [path.resolve(executable)],
    pathEntries: []
  }]);
});

it("fails closed when a present portable Windows Node cannot prove LPAC compatibility", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sigma-portable-windows-node-"));
  fixtures.push(root);
  const executable = path.join(root, "node.exe");
  await writeFile(executable, "not an approved Windows Node runtime", "utf8");
  expect(() => runtimeTrustedToolchainsForBinding(
    { executable, source: "portable" },
    "win32",
    "required"
  )).toThrow(/toolchain.*unavailable|could not be inspected|PE/iu);
});

function doctorReport(shells: BrokerVerifiedShell[]): BrokerDoctorReport {
  return {
    protocolVersion: 1,
    brokerVersion: "fixture",
    platform: "linux",
    architecture: "fixture-arch",
    sandbox: {
      available: true,
      backend: "fixture",
      selfTestPassed: true,
      setupRequired: false
    },
    capabilities: {
      foreground: true,
      background: false,
      stdin: true,
      pty: false,
      networkModes: ["none"],
      shells
    }
  };
}

function fixtureBroker(
  report: BrokerDoctorReport,
  close = vi.fn(async () => undefined)
): ExecutionBroker {
  const unavailable = async (): Promise<never> => {
    throw new Error("Fixture broker process methods must not run.");
  };
  return {
    lostProcessHandles: [],
    connect: vi.fn(async () => report),
    doctor: vi.fn(async () => report),
    execute: unavailable,
    spawn: unavailable,
    poll: unavailable,
    write: unavailable,
    terminate: unavailable,
    close
  };
}

class CapturingGateway implements ModelGateway {
  readonly provider = "fixture";
  readonly model = "fixture";
  readonly capabilities = {
    contextWindowTokens: 32_000,
    maxOutputTokens: 2_048,
    tools: true,
    parallelTools: true,
    reasoning: false,
    structuredOutput: true,
    promptCache: false,
    tokenizer: "approximate" as const
  };
  readonly requests: ModelRequest[] = [];

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    return {
      message: {
        role: "assistant",
        content: "",
        toolCalls: [{
          id: "request-capability-input",
          name: "request_user_input",
          arguments: { message: "Capability request captured." }
        }]
      },
      finishReason: "tool_calls",
      usage: {
        inputTokens: 10,
        outputTokens: 2,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        providerReported: true,
        costMicroUsd: 0,
        latencyMs: 1,
        retryAttempt: 0
      }
    };
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    yield { type: "done", response: await this.complete(request) };
  }

  async countTokens(): Promise<number> {
    return 100;
  }
}

function configured(workspace: string): RuntimeCompositionConfig {
  return {
    workspace,
    provider: "deepseek",
    model: "deepseek-v4-pro",
    permissionMode: "deny",
    runDeadlineSec: 30,
    modelDeadlineSec: 10,
    streamIdleSec: 5,
    maxParallelTools: 1,
    maxParallelAgents: 1,
    mcpServers: [],
    mcpSource: "none"
  };
}

async function workspace(): Promise<string> {
  const value = await mkdtemp(path.join(os.tmpdir(), "sigma-runtime-capabilities-"));
  fixtures.push(value);
  return value;
}

afterEach(async () => {
  for (const root of fixtures.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("configured runtime execution capabilities", () => {
  it("closes an eagerly connected broker when later runtime composition fails", async () => {
    const root = await workspace();
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), "sigma-runtime-capabilities-state-"));
    fixtures.push(stateRoot);
    const close = vi.fn(async () => undefined);
    const broker = fixtureBroker(doctorReport([]), close);

    await expect(createConfiguredRuntime(configured(root), {
      stateRootDir: stateRoot,
      executionBroker: broker,
      gatewayFactory: () => {
        throw new Error("gateway construction failed");
      }
    }, { connectMcp: false })).rejects.toThrow("gateway construction failed");

    expect(broker.connect).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it.each([
    {
      name: "one verified shell",
      shells: [{
        kind: "bash", executable: "/bin/bash", verified: true, supportsChildProcesses: true
      }] as BrokerVerifiedShell[],
      expectedShells: ["bash"],
      expectedDefault: "bash"
    },
    {
      name: "shell without child process capability",
      shells: [{
        kind: "cmd", executable: "C:\\Windows\\System32\\cmd.exe", verified: true,
        supportsChildProcesses: false
      }] as BrokerVerifiedShell[],
      expectedShells: [],
      expectedDefault: "none"
    },
    {
      name: "no verified shells",
      shells: [{ kind: "cmd", executable: "cmd.exe", verified: false }] as BrokerVerifiedShell[],
      expectedShells: [],
      expectedDefault: "none"
    }
  ])("uses doctor capabilities for tools and runtime context with $name", async ({
    shells,
    expectedShells,
    expectedDefault
  }) => {
    const root = await workspace();
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), "sigma-runtime-capabilities-state-"));
    fixtures.push(stateRoot);
    const gateway = new CapturingGateway();
    const configuredRuntime = await createConfiguredRuntime(configured(root), {
      stateRootDir: stateRoot,
      executionBroker: fixtureBroker(doctorReport(shells)),
      gatewayFactory: () => gateway
    }, { connectMcp: false });
    try {
      const session = await configuredRuntime.runtime.createSession({
        workspacePath: root,
        mode: "analyze"
      });
      await configuredRuntime.runtime.command({
        type: "submit",
        sessionId: session.sessionId,
        text: "Report the verified process capabilities."
      });
      await configuredRuntime.runtime.waitForOutcome(session.sessionId);

      expect(gateway.requests.length).toBeGreaterThan(0);
      const request = gateway.requests[0] as ModelRequest;
      const shell = request.tools?.find((tool) => tool.name === "shell");
      if (expectedShells.length === 0) {
        expect(shell).toBeUndefined();
      } else {
        expect(shell?.inputSchema).toMatchObject({
          properties: { shell: { enum: expectedShells } }
        });
      }
      const runtimePrompt = request.messages
        .filter((message) => message.role === "system" || message.role === "developer")
        .map((message) => message.content)
        .join("\n");
      expect(runtimePrompt).toContain(
        `platform=linux; arch=fixture-arch; defaultShell=${expectedDefault}; verifiedShells=${expectedShells.join(",") || "none"}; pathSeparator=/`
      );
    } finally {
      await configuredRuntime.close();
    }
  });
});
