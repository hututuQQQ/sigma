import { access } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  BrokerCancelledError,
  BrokerConnectionError,
  BrokerTimeoutError,
  ContainerAttestationInvalidError,
  ContainerCapabilityUnavailableError,
  ContainerUnavailableError,
  OciEngineApiError,
  OciEngineCapabilityError,
  OwnedContainerExecutionBroker,
  type BrokerDoctorReport,
  type ExecutionBroker,
  type ExecutionRequest,
  type ExecutionResult,
  type NetworkPolicy,
  type OwnedOciContainerInspection,
  type OwnedOciCreateSpec,
  type OwnedOciEngineCapabilities,
  type OwnedOciEnginePort,
  type ProcessHandle,
  type ProcessPollResult,
  type ProcessSpawnRequest
} from "../packages/agent-execution/src/index.js";

const DIGEST = `sha256:${"d".repeat(64)}`;
const IMAGE_ID = `sha256:${"a".repeat(64)}`;
const TARGET_ID = "b".repeat(64);

function report(): BrokerDoctorReport {
  return {
    protocolVersion: 1,
    brokerVersion: "owned-fixture",
    platform: "linux",
    architecture: "x64",
    sandbox: { available: true, backend: "native", selfTestPassed: true, setupRequired: false },
    capabilities: {
      foreground: true,
      background: true,
      stdin: true,
      pty: true,
      processHandoff: false,
      networkModes: ["none", "loopback", "full"]
    }
  };
}

function executionResult(): ExecutionResult {
  return {
    state: "exited",
    exitCode: 0,
    signal: null,
    durationMs: 1,
    stdout: "ok",
    stderr: "",
    stdoutDroppedBytes: 0,
    stderrDroppedBytes: 0,
    outputTruncated: false,
    outputArtifacts: [],
    timedOut: false,
    idleTimedOut: false,
    cancelled: false
  };
}

class FakeClient implements ExecutionBroker {
  readonly lostProcessHandles: readonly ProcessHandle[] = [];
  readonly connectSpy = vi.fn(async () => report());
  readonly doctorSpy = vi.fn(async () => report());
  readonly executeSpy = vi.fn(async (_request: ExecutionRequest) => executionResult());
  readonly closeSpy = vi.fn(async () => undefined);
  operationFailure?: Error;

  async connect(): Promise<BrokerDoctorReport> { return await this.connectSpy(); }
  async doctor(): Promise<BrokerDoctorReport> { return await this.doctorSpy(); }
  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    if (this.operationFailure) throw this.operationFailure;
    return await this.executeSpy(request);
  }
  async spawn(_request: ProcessSpawnRequest): Promise<ProcessHandle> {
    return { id: "handle", brokerInstanceId: "fixture" };
  }
  async poll(handle: ProcessHandle): Promise<ProcessPollResult> {
    return { ...executionResult(), handle };
  }
  async write(): Promise<void> { /* fixture */ }
  async terminate(handle: ProcessHandle): Promise<ProcessPollResult> {
    return { ...executionResult(), handle };
  }
  async close(): Promise<void> { await this.closeSpy(); }
}

class FakeEngine implements OwnedOciEnginePort {
  readonly engine = "docker" as const;
  capabilities: OwnedOciEngineCapabilities = {
    apiVersion: "1.52",
    networkModes: ["none", "loopback", "full"]
  };
  spec?: OwnedOciCreateSpec;
  removed: string[] = [];
  createFailure?: Error;
  startFailure?: Error;
  imageId = IMAGE_ID;
  startedAt = "2026-07-19T08:00:00.000000000Z";
  stream = new PassThrough();

  async probe(): Promise<OwnedOciEngineCapabilities> { return this.capabilities; }
  async inspectImage(_image: string, expectedDigest: string): Promise<{ imageId: string; imageDigest: string }> {
    return { imageId: IMAGE_ID, imageDigest: expectedDigest };
  }
  async createContainer(spec: OwnedOciCreateSpec): Promise<string> {
    this.spec = spec;
    if (this.createFailure) throw this.createFailure;
    return TARGET_ID;
  }
  async startContainer(): Promise<void> {
    if (this.startFailure) throw this.startFailure;
  }
  async attachContainer(): Promise<PassThrough> { return this.stream; }
  async inspectContainer(): Promise<OwnedOciContainerInspection> {
    if (!this.spec) throw new Error("container was not created");
    const full = this.spec.network === "full";
    return {
      targetId: TARGET_ID,
      targetStartedAt: this.startedAt,
      imageId: this.imageId,
      running: true,
      labels: { ...this.spec.labels },
      mounts: [
        { source: this.spec.workspace, target: this.spec.workspace, readOnly: false },
        { source: this.spec.helperPath, target: this.spec.helperTarget, readOnly: true },
        { source: this.spec.sandboxHelperPath, target: this.spec.sandboxHelperTarget, readOnly: true },
        { source: this.spec.artifactParent, target: this.spec.artifactParent, readOnly: false }
      ],
      networkMode: full ? "bridge" : "none",
      networkNames: full ? ["bridge"] : ["none"],
      capAdd: ["CAP_SYS_ADMIN"],
      securityOpt: ["seccomp=unconfined"]
    };
  }
  async removeContainer(target: string): Promise<void> { this.removed.push(target); }
}

function request(network: NetworkPolicy = "none"): ExecutionRequest {
  return {
    command: { executable: "/bin/sh", args: ["-c", "true"], cwd: path.resolve("owned-workspace") },
    policy: {
      sandbox: "required",
      network,
      readRoots: [path.resolve("owned-workspace")],
      writeRoots: [path.resolve("owned-workspace")],
      executionRoots: ["/bin/sh"]
    }
  };
}

function fixture(network: NetworkPolicy = "none"): {
  broker: OwnedContainerExecutionBroker;
  engine: FakeEngine;
  client: FakeClient;
} {
  const engine = new FakeEngine();
  const client = new FakeClient();
  const broker = new OwnedContainerExecutionBroker({
    config: { engine: "docker", target: "owned", image: `registry.example/image@${DIGEST}`, network },
    workspace: path.resolve("owned-workspace"),
    helperPath: path.resolve("sigma-exec"),
    sandboxHelperPath: path.resolve("bwrap"),
    engine,
    clientFactory: () => client,
    nameFactory: () => "sigma-owned-fixture"
  });
  return { broker, engine, client };
}

describe("OwnedContainerExecutionBroker", () => {
  it("creates one digest-pinned target with same-path mounts and destroys it on close", async () => {
    const { broker, engine, client } = fixture("loopback");
    const connected = await broker.connect();

    expect(connected).toMatchObject({
      sandbox: { backend: "oci" },
      capabilities: { networkModes: ["none", "loopback"] },
      container: {
        available: true,
        engine: "docker",
        target: "owned",
        targetId: TARGET_ID,
        imageId: IMAGE_ID,
        imageDigest: DIGEST
      }
    });
    expect(engine.spec).toMatchObject({
      name: "sigma-owned-fixture",
      image: `registry.example/image@${DIGEST}`,
      workspace: path.resolve("owned-workspace"),
      helperPath: path.resolve("sigma-exec"),
      helperTarget: "/opt/sigma-helper/sigma-exec",
      sandboxHelperPath: path.resolve("bwrap"),
      sandboxHelperTarget: "/usr/local/bin/bwrap",
      network: "loopback"
    });
    expect(engine.spec?.labels).toMatchObject({ "com.sigma.oci-owned": "v1" });
    const artifactParent = engine.spec!.artifactParent;
    await expect(access(artifactParent)).resolves.toBeUndefined();

    await Promise.all([broker.close(), broker.close()]);
    expect(client.closeSpy).toHaveBeenCalledOnce();
    expect(engine.removed).toEqual([TARGET_ID]);
    await expect(access(artifactParent)).rejects.toThrow();
  });

  it("re-attests before execution and removes the target when its pinned image identity changes", async () => {
    const { broker, engine } = fixture();
    await broker.connect();
    engine.imageId = `sha256:${"c".repeat(64)}`;

    await expect(broker.execute(request())).rejects.toBeInstanceOf(ContainerAttestationInvalidError);
    expect(engine.removed).toEqual([TARGET_ID]);
    await expect(broker.execute(request())).rejects.toBeInstanceOf(ContainerUnavailableError);
  });

  it("cleans up by unique name when create has an unknown result", async () => {
    const { broker, engine } = fixture();
    engine.createFailure = new Error("connection lost after create dispatch");

    await expect(broker.connect()).rejects.toBeInstanceOf(ContainerUnavailableError);
    expect(engine.removed).toEqual(["sigma-owned-fixture"]);
  });

  it("does not misreport a generic engine create failure as a network capability failure", async () => {
    const { broker, engine } = fixture();
    engine.createFailure = new OciEngineApiError("bind mount denied", "container create", 400);

    await expect(broker.connect()).rejects.toMatchObject({
      name: "ContainerUnavailableError",
      data: { engineError: { operation: "container create", statusCode: 400 } }
    });
    expect(engine.removed).toEqual(["sigma-owned-fixture"]);
  });

  it("returns a typed failure when the engine rejects nested sandbox capabilities", async () => {
    const { broker, engine } = fixture();
    engine.createFailure = new OciEngineCapabilityError(
      "sandbox.nested_isolation", "SYS_ADMIN is unavailable", "container create", 400
    );

    await expect(broker.connect()).rejects.toMatchObject({
      name: "ContainerCapabilityUnavailableError",
      code: "container_unavailable",
      data: { capability: "sandbox.nested_isolation" }
    });
    expect(engine.removed).toEqual(["sigma-owned-fixture"]);
  });

  it.each([
    new BrokerCancelledError("cancelled"),
    new BrokerTimeoutError("timed out")
  ])("removes a partially-created target after provisioning failure %#", async (failure) => {
    const { broker, engine } = fixture();
    engine.startFailure = failure;

    await expect(broker.connect()).rejects.toBe(failure);
    expect(engine.removed).toEqual([TARGET_ID]);
  });

  it("retires and removes the target after an execution transport disconnect", async () => {
    const { broker, engine, client } = fixture();
    await broker.connect();
    client.operationFailure = new BrokerConnectionError("target stream disconnected");

    await expect(broker.execute(request())).rejects.toBe(client.operationFailure);
    expect(engine.removed).toEqual([TARGET_ID]);
  });

  it.each([
    new BrokerCancelledError("operation cancelled"),
    new BrokerTimeoutError("operation timed out")
  ])("preserves a healthy target after sigma-exec contains an operation failure %#", async (failure) => {
    const { broker, engine, client } = fixture();
    await broker.connect();
    client.operationFailure = failure;

    await expect(broker.execute(request())).rejects.toBe(failure);
    expect(engine.removed).toEqual([]);
    await broker.close();
    expect(engine.removed).toEqual([TARGET_ID]);
  });

  it("returns a typed capability failure when the engine cannot provide full networking", async () => {
    const { broker, engine } = fixture("full");
    engine.capabilities = { apiVersion: "1.52", networkModes: ["none", "loopback"] };

    await expect(broker.connect()).rejects.toMatchObject({
      code: "container_unavailable",
      name: "ContainerCapabilityUnavailableError",
      data: { capability: "network.full" }
    });
    expect(engine.spec).toBeUndefined();
    expect(engine.removed).toEqual([]);
  });

  it("refuses a request above the target network envelope without invoking it", async () => {
    const { broker, client } = fixture("none");
    await broker.connect();

    await expect(broker.execute(request("full"))).rejects.toBeInstanceOf(ContainerCapabilityUnavailableError);
    expect(client.executeSpy).not.toHaveBeenCalled();
    await broker.close();
  });
});
