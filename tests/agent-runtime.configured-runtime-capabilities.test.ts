import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  defaultSigmaExecPath,
  LazyExecutionBroker,
  resolveSigmaExecBinary,
  runtimeNodeBinding,
  runtimeTrustedToolchains,
  runtimeTrustedToolchainsForBinding,
  type BrokerDoctorReport,
  type BrokerVerifiedShell,
  type ExecutionBroker
} from "../packages/agent-execution/src/index.js";
import type {
  ModelGateway,
  ModelRequest,
  ModelResponse,
  ModelStreamEvent
} from "../packages/agent-protocol/src/index.js";
import { SUBJECT_ATTESTATION_EVIDENCE_SOURCE_V1 } from "../packages/agent-protocol/src/index.js";
import {
  createConfiguredRuntime,
  type RuntimeCompositionConfig
} from "../packages/agent-runtime/src/testing.js";
import { verifiedNetworkPolicy } from "../packages/agent-runtime/src/execution-capabilities.js";
import { afterEach, describe, expect, it, vi } from "vitest";

const fixtures: string[] = [];

it("finds the debug broker produced by a development build", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sigma-debug-broker-path-"));
  fixtures.push(root);
  const modulePath = path.join(root, "packages", "agent-runtime", "dist", "execution-composition.js");
  const debugDirectory = path.join(root, "native", "sigma-exec", "target", "debug");
  const debugBroker = resolveSigmaExecBinary(debugDirectory);
  await mkdir(path.dirname(modulePath), { recursive: true });
  await mkdir(debugDirectory, { recursive: true });
  await writeFile(modulePath, "export {};\n", "utf8");
  await writeFile(debugBroker, "debug broker", "utf8");

  expect(defaultSigmaExecPath({}, pathToFileURL(modulePath))).toBe(debugBroker);
});

it("omits an unproved automatic Windows Node capability", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sigma-runtime-node-proof-"));
  fixtures.push(root);
  const executable = path.join(root, "node.exe");
  await writeFile(executable, "not an approved Node runtime", "utf8");
  expect(runtimeTrustedToolchains(executable, "win32", "required")).toEqual([]);
});

it("binds a host-loaded portable runtime to its canonical bundled Node file", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sigma-portable-runtime-node-"));
  fixtures.push(root);
  const modulePath = path.join(root, "packages", "agent-runtime", "dist", "execution-composition.js");
  const executable = path.join(root, "bin", "node");
  const runtimeRoot = path.join(root, "lib");
  await mkdir(path.dirname(modulePath), { recursive: true });
  await mkdir(path.dirname(executable), { recursive: true });
  await mkdir(runtimeRoot, { recursive: true });
  await writeFile(modulePath, "export {};\n", "utf8");
  await writeFile(executable, "portable node", "utf8");
  const configured = path.join(root, "configured", "node");

  const binding = runtimeNodeBinding(pathToFileURL(modulePath), "linux", process.execPath, {
    SIGMA_RUNTIME_NODE_PATH: configured
  });
  expect(binding).toEqual({ executable: path.resolve(executable), source: "portable" });
  expect(runtimeTrustedToolchainsForBinding(binding, "linux", "required")).toEqual([{
    id: "runtime-node",
    runtime: "node",
    executable: path.resolve(executable),
    aliases: ["node"],
    executionRoots: [path.resolve(executable)],
    runtimeRoots: [path.resolve(runtimeRoot)],
    pathEntries: []
  }]);
});

it("uses an explicitly configured absolute Node after the portable location", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sigma-configured-runtime-node-"));
  fixtures.push(root);
  const modulePath = path.join(root, "packages", "agent-runtime", "dist", "execution-composition.js");
  const executable = path.join(root, "configured", process.platform === "win32" ? "node.exe" : "node");
  await mkdir(path.dirname(modulePath), { recursive: true });
  await mkdir(path.dirname(executable), { recursive: true });
  await writeFile(modulePath, "export {};\n", "utf8");
  await writeFile(executable, "configured node", "utf8");

  expect(runtimeNodeBinding(pathToFileURL(modulePath), process.platform, process.execPath, {
    SIGMA_RUNTIME_NODE_PATH: executable
  })).toEqual({ executable: path.resolve(executable), source: "configured" });
  expect(runtimeNodeBinding(
    pathToFileURL(modulePath), process.platform, process.execPath, {}
  )).toEqual({ executable: path.resolve(process.execPath), source: "current-runtime" });
});

it.each(["", "relative/node"])(
  "rejects an explicit non-absolute runtime Node path %j without host fallback",
  async (configuredPath) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-invalid-runtime-node-"));
    fixtures.push(root);
    const modulePath = path.join(root, "packages", "agent-runtime", "dist", "execution-composition.js");
    await mkdir(path.dirname(modulePath), { recursive: true });
    await writeFile(modulePath, "export {};\n", "utf8");

    expect(() => runtimeNodeBinding(pathToFileURL(modulePath), process.platform, process.execPath, {
      SIGMA_RUNTIME_NODE_PATH: configuredPath
    })).toThrow(expect.objectContaining({ code: "toolchain_unavailable" }));
  }
);

it("uses the environment passed to the default broker factory", async () => {
  expect(() => new LazyExecutionBroker({
    sandboxMode: "required",
    helperPath: process.execPath,
    env: { SIGMA_RUNTIME_NODE_PATH: "relative/node" }
  })).toThrow(expect.objectContaining({ code: "toolchain_unavailable" }));
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

it("requires the same Windows LPAC proof for an explicitly configured Node", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sigma-configured-windows-node-"));
  fixtures.push(root);
  const executable = path.join(root, "node.exe");
  await writeFile(executable, "not an approved Windows Node runtime", "utf8");
  const binding = { executable, source: "configured" as const };

  expect(() => runtimeTrustedToolchainsForBinding(binding, "win32", "required"))
    .toThrow(/toolchain.*unavailable|could not be inspected|PE/iu);
});

function doctorReport(
  shells: BrokerVerifiedShell[],
  runtimeCommands: string[] = [],
  processCapabilities: {
    foreground: boolean;
    background: boolean;
    stdin: boolean;
    pty: boolean;
    networkModes: Array<"none" | "full">;
  } = {
    foreground: true,
    background: false,
    stdin: true,
    pty: false,
    networkModes: ["none"]
  }
): BrokerDoctorReport {
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
      foreground: processCapabilities.foreground,
      background: processCapabilities.background,
      stdin: processCapabilities.stdin,
      pty: processCapabilities.pty,
      networkModes: processCapabilities.networkModes,
      shells,
      runtimeCommands
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

  constructor(private readonly scripted: ModelResponse[] = []) {}

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    const response = this.scripted.shift();
    if (response) return response;
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
  it("rejects a configured network mode the broker did not advertise", () => {
    expect(() => verifiedNetworkPolicy(doctorReport([], [], {
      foreground: true, background: true, stdin: true, pty: true,
      networkModes: ["none", "full"]
    }), "loopback")).toThrow(expect.objectContaining({
      code: "network_capability_unavailable",
      requestedMode: "loopback",
      availableModes: ["none", "full"]
    }));
  });

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

  it("keeps subject attestation out of task evidence while ordinary text completes", async () => {
    const root = await workspace();
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), "sigma-runtime-attestation-state-"));
    fixtures.push(stateRoot);
    const runtimeConfig = configured(root);
    runtimeConfig.permissionMode = "auto";
    const gateway = new CapturingGateway([
      { message: { role: "assistant", content: "Hello. What should I inspect?" }, finishReason: "stop" },
      {
        message: {
          role: "assistant",
          content: "",
          toolCalls: [{
            id: "need-task-after-attestation",
            name: "request_user_input",
            arguments: { message: "What should I inspect?" }
          }]
        },
        finishReason: "tool_calls"
      }
    ]);
    const configuredRuntime = await createConfiguredRuntime(runtimeConfig, {
      stateRootDir: stateRoot,
      executionBroker: fixtureBroker(doctorReport([])),
      gatewayFactory: () => gateway,
      subjectProductAttestation: {
        schemaVersion: 1,
        productDigest: "a".repeat(64),
        buildArtifactDigest: "b".repeat(64),
        environmentDigest: "c".repeat(64),
        platform: "linux"
      }
    }, { connectMcp: false, surface: "cli" });
    try {
      const session = await configuredRuntime.runtime.createSession({ workspacePath: root, mode: "analyze" });
      await configuredRuntime.runtime.command({
        type: "submit", sessionId: session.sessionId, text: "hello", mode: "analyze"
      });
      const outcome = await configuredRuntime.runtime.waitForOutcome(session.sessionId);
      const events = [];
      for await (const event of configuredRuntime.runtime.sessionEvents(session.sessionId)) events.push(event);
      const toolResults = events.filter((event) => event.type === "tool.completed" || event.type === "tool.failed");
      expect(outcome, JSON.stringify(toolResults.map((event) => event.payload))).toMatchObject({
        kind: "completed", message: "Hello. What should I inspect?"
      });

      expect(gateway.requests).toHaveLength(1);
      const initialContext = gateway.requests[0]!.messages.map((message) => message.content).join("\n");
      expect(initialContext).not.toContain("Current-run typed durable evidence ledger");
      expect(initialContext).not.toContain("subject-attestation:");

      expect(events.filter((event) => event.type === "evidence.recorded"
        && (event.payload as { data?: { source?: string } }).data?.source
          === SUBJECT_ATTESTATION_EVIDENCE_SOURCE_V1)).toHaveLength(1);
    } finally {
      await configuredRuntime.close();
    }
  });

  it.each([
    {
      name: "one verified shell",
      shells: [{
        kind: "bash", executable: "/bin/bash", verified: true, supportsChildProcesses: true
      }] as BrokerVerifiedShell[],
      expectedShells: ["bash"],
      expectedDefault: "bash",
      runtimeCommands: ["node", "node-runtime"],
      expectedRuntimeCommands: ["node", "node-runtime"],
      processCapabilities: {
        foreground: true, background: false, stdin: true, pty: false, networkModes: ["none"]
      },
      configuredNetworkMode: "none" as const,
      expectedNetworkModes: ["none"] as Array<"none" | "full">
    },
    {
      name: "shell without child process capability",
      shells: [{
        kind: "cmd", executable: "C:\\Windows\\System32\\cmd.exe", verified: true,
        supportsChildProcesses: false
      }] as BrokerVerifiedShell[],
      expectedShells: [],
      expectedDefault: "none",
      runtimeCommands: ["node"],
      expectedRuntimeCommands: ["node"],
      processCapabilities: {
        foreground: true, background: false, stdin: true, pty: false, networkModes: ["none"]
      },
      configuredNetworkMode: "none" as const,
      expectedNetworkModes: ["none"] as Array<"none" | "full">
    },
    {
      name: "no verified shells",
      shells: [{ kind: "cmd", executable: "cmd.exe", verified: false }] as BrokerVerifiedShell[],
      expectedShells: [],
      expectedDefault: "none",
      runtimeCommands: ["not a command", "line\nbreak"],
      expectedRuntimeCommands: [],
      processCapabilities: {
        foreground: true, background: false, stdin: true, pty: false, networkModes: ["none"]
      },
      configuredNetworkMode: "none" as const,
      expectedNetworkModes: ["none"] as Array<"none" | "full">
    },
    {
      name: "no process execution capability",
      shells: [{
        kind: "bash", executable: "/bin/bash", verified: true, supportsChildProcesses: true
      }] as BrokerVerifiedShell[],
      expectedShells: [],
      expectedDefault: "none",
      runtimeCommands: ["node"],
      expectedRuntimeCommands: [],
      processCapabilities: {
        foreground: false, background: false, stdin: false, pty: false, networkModes: ["none"]
      },
      configuredNetworkMode: "none" as const,
      expectedNetworkModes: ["none"] as Array<"none" | "full">
    },
    {
      name: "configuration selects a default without hiding broker network support",
      shells: [] as BrokerVerifiedShell[],
      expectedShells: [],
      expectedDefault: "none",
      runtimeCommands: ["node"],
      expectedRuntimeCommands: ["node"],
      processCapabilities: {
        foreground: true, background: true, stdin: false, pty: false,
        networkModes: ["none", "full"] as Array<"none" | "full">
      },
      configuredNetworkMode: "none" as const,
      expectedNetworkModes: ["none", "full"] as Array<"none" | "full">
    },
    {
      name: "background execution without the network mode required by code intelligence",
      shells: [] as BrokerVerifiedShell[],
      expectedShells: [],
      expectedDefault: "none",
      runtimeCommands: ["node"],
      expectedRuntimeCommands: ["node"],
      processCapabilities: {
        foreground: true, background: true, stdin: true, pty: true, networkModes: ["full"]
      },
      configuredNetworkMode: "full" as const,
      expectedNetworkModes: ["full"] as Array<"none" | "full">
    }
  ])("uses doctor capabilities for tools and runtime context with $name", async ({
    shells,
    expectedShells,
    expectedDefault,
    runtimeCommands,
    expectedRuntimeCommands,
    processCapabilities,
    configuredNetworkMode,
    expectedNetworkModes
  }) => {
    const root = await workspace();
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), "sigma-runtime-capabilities-state-"));
    fixtures.push(stateRoot);
    const gateway = new CapturingGateway();
    const runtimeConfig = configured(root);
    runtimeConfig.networkMode = configuredNetworkMode;
    const configuredRuntime = await createConfiguredRuntime(runtimeConfig, {
      stateRootDir: stateRoot,
      executionBroker: fixtureBroker(doctorReport(shells, runtimeCommands, processCapabilities)),
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
      expect(request.tools?.find((tool) => tool.name === "list")).toBeDefined();
      expect(request.tools?.find((tool) => tool.name === "grep")).toBeDefined();
      expect(request.tools?.find((tool) => tool.name === "repository_stats")).toBeDefined();
      expect(request.tools?.find((tool) => tool.name === "load_skill")).toBeUndefined();
      const exec = request.tools?.find((tool) => tool.name === "exec");
      const foregroundAvailable = processCapabilities.foreground && expectedNetworkModes.length > 0;
      const backgroundAvailable = processCapabilities.background && expectedNetworkModes.length > 0;
      if (foregroundAvailable) {
        expect(exec?.inputSchema).not.toMatchObject({
          properties: { skill: expect.anything() }
        });
        expect(exec?.inputSchema).toMatchObject({
          properties: { network: { enum: expectedNetworkModes } }
        });
      } else {
        expect(exec).toBeUndefined();
        expect(request.tools?.find((tool) => tool.name === "validate")).toBeUndefined();
      }
      const spawn = request.tools?.find((tool) => tool.name === "process_spawn");
      if (!backgroundAvailable) {
        expect(request.tools?.find((tool) => tool.name === "process_spawn")).toBeUndefined();
        expect(request.tools?.find((tool) => tool.name === "process_poll")).toBeUndefined();
        expect(request.tools?.find((tool) => tool.name === "process_write")).toBeUndefined();
        expect(request.tools?.find((tool) => tool.name === "process_terminate")).toBeUndefined();
      } else {
        expect(spawn?.inputSchema).toMatchObject({
          properties: { network: { enum: expectedNetworkModes } }
        });
        if (processCapabilities.pty) {
          expect(spawn?.inputSchema).toMatchObject({ properties: { pty: { type: "boolean" } } });
        } else {
          expect(spawn?.inputSchema).not.toMatchObject({ properties: { pty: expect.anything() } });
        }
        if (processCapabilities.stdin) {
          expect(request.tools?.find((tool) => tool.name === "process_write")).toBeDefined();
        } else {
          expect(request.tools?.find((tool) => tool.name === "process_write")).toBeUndefined();
        }
      }
      const codeIntelAvailable = backgroundAvailable
        && processCapabilities.stdin
        && expectedNetworkModes.includes("none");
      expect(request.tools?.find((tool) => tool.name === "lsp") !== undefined).toBe(codeIntelAvailable);
      const executionSchema = JSON.stringify(
        exec?.inputSchema
      );
      if (!foregroundAvailable) {
        expect(executionSchema).toBeUndefined();
      } else if (expectedRuntimeCommands.length > 0) {
        for (const command of expectedRuntimeCommands) expect(executionSchema).toContain(command);
        expect(executionSchema).toContain("Unlisted bare commands are unavailable");
      } else {
        expect(executionSchema).toContain("No general bare runtime command alias is verified");
      }
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
        `platform=linux; arch=fixture-arch; executionCapabilities=broker-verified; defaultShell=${expectedDefault}; verifiedShells=${expectedShells.join(",") || "none"}; verifiedRuntimeCommands=${expectedRuntimeCommands.join(",") || "none"}; pathSeparator=/`
      );
      expect(runtimePrompt).toContain("Execution capabilities are closed-world");
      expect(runtimePrompt).toContain("Do not probe or retry unlisted host commands");
      expect(runtimePrompt).not.toContain(process.execPath);
    } finally {
      await configuredRuntime.close();
    }
  });
});
