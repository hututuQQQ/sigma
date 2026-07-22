import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrokerDoctorReport, ExecutionBroker } from "../packages/agent-execution/src/index.js";

const api = vi.hoisted(() => ({ mode: "success" as "success" | "empty" | "error" | "raw_error" }));

vi.mock("../packages/agent-model/dist/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("agent-model")>();
  return {
    ...actual,
    checkProviderHealth: async (input: { provider: "deepseek" | "glm"; model: string }) => {
      if (api.mode === "error") throw new Error("mock API failure");
      if (api.mode === "raw_error") throw "raw API failure";
      if (api.mode === "empty") {
        return {
          ok: false,
          provider: input.provider,
          model: input.model,
          endpointHost: "api.example.test",
          latencyMs: 12,
          message: "Provider returned no textual output.",
          failureKind: "api_error" as const,
          errorCategory: "protocol"
        };
      }
      return {
        ok: true,
        provider: input.provider,
        model: input.model,
        endpointHost: "api.example.test",
        latencyMs: 12,
        message: "ok"
      };
    }
  };
});

import { runDoctorCommand } from "../packages/agent-cli/src/commands/doctor.js";

class Capture extends Writable {
  readonly chunks: Buffer[] = [];

  _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    callback();
  }

  text(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

async function workspace(): Promise<string> {
  return await mkdtemp(path.join(os.tmpdir(), "sigma-doctor-coverage-"));
}

function healthyBroker(close: () => Promise<void> = async () => undefined): ExecutionBroker {
  const report: BrokerDoctorReport = {
    protocolVersion: 1,
    brokerVersion: "fixture",
    platform: process.platform,
    architecture: process.arch,
    sandbox: {
      available: true,
      backend: "fixture",
      selfTestPassed: true,
      setupRequired: false
    },
    capabilities: {
      foreground: true,
      background: true,
      stdin: true,
      pty: false,
      processHandoff: false,
      networkModes: ["none"]
    }
  };
  return {
    lostProcessHandles: [],
    connect: async () => report,
    doctor: async () => report,
    sandboxLeaseStatus: async (workspacePath) => ({
      leaseId: "lease", workspaceIdentity: "workspace", generation: 7,
      principalId: "principal", access: "read", roots: [workspacePath], state: "active"
    }),
    execute: async () => { throw new Error("not implemented"); },
    spawn: async () => { throw new Error("not implemented"); },
    poll: async () => { throw new Error("not implemented"); },
    write: async () => { throw new Error("not implemented"); },
    terminate: async () => { throw new Error("not implemented"); },
    close
  };
}

afterEach(() => {
  api.mode = "success";
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("doctor command branch coverage", () => {
  it.each([true, false])("preflights required managed execution (available=%s)", async (available) => {
    const root = await workspace();
    const broker = healthyBroker();
    const base = await broker.doctor();
    const report: BrokerDoctorReport = {
      ...base,
      capabilities: {
        ...base.capabilities,
        networkModes: ["none", "full"],
        runtimeClosure: {
          protocolVersion: 1,
          digest: `sha256:${"1".repeat(64)}`,
          complete: available,
          platform: process.platform,
          architecture: process.arch,
          executableSearchPathsDigest: `sha256:${"2".repeat(64)}`,
          runtimeCommandsDigest: `sha256:${"3".repeat(64)}`,
          targetAttestationDigest: `sha256:${"4".repeat(64)}`
        },
        managedEnvironment: { available, prepare: available }
      },
      container: {
        available,
        backend: "oci",
        engine: "docker",
        target: "managed",
        targetId: "managed-target"
      }
    };
    broker.doctor = async () => report;
    const stdout = new Capture();
    await expect(runDoctorCommand([
      "--workspace", root,
      "--execution-mode", "container",
      "--network", "full",
      "--managed-environment-mode", "required",
      "--json"
    ], { stdout, executionBroker: broker, languageServers: [] })).resolves.toBe(available ? 0 : 1);
    const result = JSON.parse(stdout.text()) as {
      container: { target?: string };
      checks: Array<{ name: string; status: string }>;
    };
    expect(result.container.target).toBe("managed");
    expect(result.checks.find((check) => check.name === "managed_environment")?.status)
      .toBe(available ? "ok" : "error");
  });

  it("prints help", async () => {
    const stdout = new Capture();
    await expect(runDoctorCommand(["-h"], { stdout })).resolves.toBe(0);
    expect(stdout.text()).toContain("agent doctor");
  });

  it("reports a healthy Node/provider/API path as JSON", async () => {
    const root = await workspace();
    const originalNode = Object.getOwnPropertyDescriptor(process.versions, "node");
    Object.defineProperty(process.versions, "node", { value: "26.4.0", configurable: true, enumerable: true });
    vi.stubEnv("DEEPSEEK_API_KEY", "configured-for-test");
    try {
      const stdout = new Capture();
      await expect(runDoctorCommand([
        "--workspace", root,
        "--provider", "deepseek",
        "--model", "doctor-model",
        "--check-api",
        "--json"
      ], { stdout, executionBroker: healthyBroker() })).resolves.toBe(0);
      const report = JSON.parse(stdout.text()) as {
        doctorSchemaVersion: number;
        protocolVersion: number;
        capabilities: { networkModes: string[]; processHandoff: boolean };
        status: string;
        checks: Array<{ name: string; status: string; message: string }>;
      };
      expect(report.doctorSchemaVersion).toBe(1);
      expect(report.protocolVersion).toBe(1);
      expect(report.capabilities.networkModes).toEqual(["none"]);
      expect(report.capabilities.processHandoff).toBe(false);
      expect(report).toMatchObject({
        workspaceLease: { state: "active", generation: 7 },
        container: { available: false, backend: "oci" }
      });
      expect(report.status).toBe("ok");
      expect(report.checks).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "node", status: "ok" }),
        expect.objectContaining({ name: "provider_key", status: "ok" }),
        expect.objectContaining({ name: "lsp_rust" }),
        expect.objectContaining({ name: "lsp_go" }),
        expect.objectContaining({
          name: "api",
          status: "ok",
          message: expect.stringContaining("provider=deepseek model=doctor-model endpoint=api.example.test elapsed_ms=12")
        })
      ]));
      expect(report.checks
        .filter((check) => ["lsp_rust", "lsp_go"].includes(check.name))
        .every((check) => ["ok", "skipped"].includes(check.status)))
        .toBe(true);
    } finally {
      if (originalNode) Object.defineProperty(process.versions, "node", originalNode);
    }
  });

  it("prints skipped and empty API results as text and enforces strict warnings", async () => {
    const root = await workspace();
    vi.stubEnv("GLM_API_KEY", "");
    vi.stubEnv("ZAI_API_KEY", "");
    vi.stubEnv("BIGMODEL_API_KEY", "");
    const skipped = new Capture();
    await expect(runDoctorCommand(["--workspace", root, "--provider", "glm"], {
      stdout: skipped,
      executionBroker: healthyBroker()
    })).resolves.toBe(0);
    expect(skipped.text()).toContain("api=skipped");
    expect(skipped.text()).toContain("provider_key=warning");

    api.mode = "empty";
    const strict = new Capture();
    await expect(runDoctorCommand([
      "--workspace", root, "--provider", "glm", "--check-api", "--strict", "--json"
    ], { stdout: strict, executionBroker: healthyBroker() })).resolves.toBe(1);
    const report = JSON.parse(strict.text()) as { status: string; checks: Array<{ name: string; message: string }> };
    expect(report.status).toBe("error");
    expect(report.checks.find((check) => check.name === "api")).toMatchObject({
      status: "error",
      failure_kind: "api_error",
      error_category: "protocol",
      endpoint_host: "api.example.test",
      elapsed_ms: 12
    });
  });

  it.each(["GLM_API_KEY", "ZAI_API_KEY", "BIGMODEL_API_KEY"])("recognizes %s", async (key) => {
    const root = await workspace();
    vi.stubEnv("GLM_API_KEY", "");
    vi.stubEnv("ZAI_API_KEY", "");
    vi.stubEnv("BIGMODEL_API_KEY", "");
    vi.stubEnv(key, "configured-for-test");
    const stdout = new Capture();
    await expect(runDoctorCommand(["--workspace", root, "--provider", "glm", "--json"], {
      stdout,
      executionBroker: healthyBroker()
    })).resolves.toBe(0);
    const report = JSON.parse(stdout.text()) as { checks: Array<{ name: string; status: string }> };
    expect(report.checks.find((check) => check.name === "provider_key")?.status).toBe("ok");
  });

  it.each([
    ["error", "mock API failure"],
    ["raw_error", "raw API failure"]
  ] as const)("reports %s API failures", async (mode, expected) => {
    const root = await workspace();
    api.mode = mode;
    const stdout = new Capture();
    await expect(runDoctorCommand(["--workspace", root, "--check-api", "--json"], {
      stdout,
      executionBroker: healthyBroker()
    })).resolves.toBe(1);
    const report = JSON.parse(stdout.text()) as { checks: Array<{ name: string; message: string }> };
    expect(report.checks.find((check) => check.name === "api")?.message).toContain(expected);
  });

  it("reports inaccessible workspaces and invalid command arguments", async () => {
    const missing = path.join(os.tmpdir(), `sigma-doctor-missing-${Date.now()}`);
    const stdout = new Capture();
    await expect(runDoctorCommand(["--workspace", missing, "--json"], {
      stdout,
      executionBroker: healthyBroker()
    })).resolves.toBe(1);
    const report = JSON.parse(stdout.text()) as { checks: Array<{ name: string; status: string }> };
    expect(report.checks.find((check) => check.name === "workspace")?.status).toBe("error");

    const stderr = new Capture();
    await expect(runDoctorCommand(["--not-a-doctor-option"], { stderr })).resolves.toBe(1);
    expect(stderr.text()).toContain("Unknown option");
  });

  it("always closes an owned broker, including when report output fails", async () => {
    const root = await workspace();
    const successfulClose = vi.fn(async () => undefined);
    await expect(runDoctorCommand(["--workspace", root, "--json"], {
      stdout: new Capture(),
      languageServers: [],
      createExecutionBroker: () => healthyBroker(successfulClose)
    })).resolves.toBe(0);
    expect(successfulClose).toHaveBeenCalledOnce();

    const failedClose = vi.fn(async () => undefined);
    const stderr = new Capture();
    const stdout = {
      write: () => { throw new Error("fixture output failure"); }
    } as unknown as NodeJS.WritableStream;
    await expect(runDoctorCommand(["--workspace", root, "--json"], {
      stdout,
      stderr,
      languageServers: [],
      createExecutionBroker: () => healthyBroker(failedClose)
    })).resolves.toBe(1);
    expect(stderr.text()).toContain("fixture output failure");
    expect(failedClose).toHaveBeenCalledOnce();
  });
});
