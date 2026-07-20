import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  BrokerRequestOptions,
  BrokerDoctorReport,
  ExecutionBroker,
  RepositoryMetadataLeaseRequestV1,
  RepositoryMetadataLeaseV1,
  ScratchLeaseRequestV1,
  ScratchLeaseV1
} from "../packages/agent-execution/src/index.js";
import {
  nodeRuntimeReadRoots,
  withTrustedRuntimeCapabilities
} from "../packages/agent-execution/src/lazy-execution-broker-runtime.js";
import { LazyExecutionBroker } from "../packages/agent-execution/src/lazy-execution-broker.js";
import {
  assertTrustedToolchainsAvailable,
  normalizeTrustedToolchains,
  resolveTrustedInvocation
} from "../packages/agent-execution/src/trusted-toolchains.js";
import { runtimeEnvironment, runtimePrompt } from "../packages/agent-platform/src/index.js";
import { brokerRuntimeEnvironment } from "../packages/agent-runtime/src/execution-capabilities.js";

function report(): BrokerDoctorReport {
  return {
    protocolVersion: 1,
    brokerVersion: "fixture",
    platform: process.platform === "win32" ? "windows" : "linux",
    architecture: process.arch,
    sandbox: {
      available: true,
      backend: "fixture",
      selfTestPassed: true,
      setupRequired: false
    },
    capabilities: {
      foreground: true,
      background: false,
      stdin: false,
      pty: false,
      networkModes: ["none"]
    }
  };
}

function fixtureBroker(connection: () => Promise<BrokerDoctorReport>): ExecutionBroker {
  const unavailable = async (): Promise<never> => {
    throw new Error("Process methods are not used by this capability test.");
  };
  return {
    lostProcessHandles: [],
    connect: connection,
    doctor: connection,
    execute: unavailable,
    spawn: unavailable,
    poll: unavailable,
    write: unavailable,
    terminate: unavailable,
    close: async () => undefined
  };
}

describe("connection-bound runtime capability reporting", () => {
  it("grants Windows Node adjacent runtime assets without broadening executable trust", () => {
    const executable = path.join("C:\\", "Sigma", "bin", "node.exe");
    const packageRoot = path.join("C:\\", "Sigma", "bin", "node_modules", "pnpm");

    expect(nodeRuntimeReadRoots(executable, "win32", [packageRoot])).toEqual([
      path.dirname(executable), packageRoot
    ]);
    expect(nodeRuntimeReadRoots("/opt/sigma/bin/node", "linux", ["/opt/sigma/lib/pnpm"]))
      .toEqual(["/opt/sigma/lib/pnpm"]);
  });

  it("rejects an unavailable trusted runtime during connection preflight", () => {
    const missing = path.join(os.tmpdir(), `sigma-missing-runtime-${randomUUID()}`);
    const toolchains = normalizeTrustedToolchains([{
      id: "missing-runtime",
      runtime: "generic",
      executable: missing,
      aliases: ["missing-runtime"]
    }]);

    expect(() => assertTrustedToolchainsAvailable(toolchains, "required"))
      .toThrow(/trusted toolchain.*unavailable/iu);
  });

  it.runIf(process.platform !== "win32")(
    "rejects a trusted runtime that is not executable on POSIX",
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "sigma-non-executable-runtime-"));
      try {
        const executable = path.join(root, "runtime");
        await writeFile(executable, "runtime", "utf8");
        await chmod(executable, 0o600);
        const toolchains = normalizeTrustedToolchains([{
          id: "non-executable-runtime",
          runtime: "generic",
          executable,
          aliases: ["runtime"]
        }]);

        expect(() => assertTrustedToolchainsAvailable(toolchains, "required"))
          .toThrow(/trusted toolchain.*unavailable/iu);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  it("does not present platform defaults as broker-verified execution capabilities", () => {
    const prompt = runtimePrompt(runtimeEnvironment());
    expect(prompt).toContain("executionCapabilities=unverified");
    expect(prompt).toContain("defaultShell=none");
    expect(prompt).toContain("verifiedShells=none");
    expect(prompt).toContain("verifiedRuntimeCommands=none");
  });

  it("describes container execution as an attested OCI target with a shared workspace", () => {
    const environment = { ...runtimeEnvironment("linux"), executionMode: "container" as const };
    const prompt = runtimePrompt(environment);

    expect(prompt).toContain("executionMode=container");
    expect(prompt).toContain("attested OCI target");
    expect(prompt).toContain("shared target workspace");
    expect(prompt).toContain("do not fall back to the host");
    expect(prompt).not.toContain("staged workspace merge");
    expect(prompt).not.toContain("disposable-container");
  });

  it("does not fall back or interpolate malformed broker environment fields", () => {
    expect(() => brokerRuntimeEnvironment({ ...report(), platform: "unknown" }))
      .toThrow(/unsupported platform/u);
    expect(() => brokerRuntimeEnvironment({ ...report(), architecture: "x64\nforged" }))
      .toThrow(/architecture/u);
  });

  it("adds only trusted command aliases after the underlying connection succeeds", async () => {
    const underlyingReport = report();
    underlyingReport.capabilities.runtimeCommands = ["reported-runtime", "not a command"];
    const connect = vi.fn(async () => underlyingReport);
    const broker = withTrustedRuntimeCapabilities(fixtureBroker(connect), [{
      id: "packaged-runtime",
      runtime: "node",
      executable: process.execPath,
      aliases: ["runtime-alias"],
      executionRoots: [process.execPath],
      pathEntries: []
    }]);

    const connected = await broker.connect();

    expect(connect).toHaveBeenCalledOnce();
    expect(connected.capabilities.runtimeCommands).toEqual(["runtime-alias"]);
    expect(connected.capabilities.runtimeCommandSnapshotComplete).toBe(true);
    expect(JSON.stringify(connected)).not.toContain(process.execPath);
  });

  it("distinguishes a complete target command snapshot from an unknown one", () => {
    const known = report();
    known.capabilities.runtimeCommands = ["node"];
    known.capabilities.runtimeCommandSnapshotComplete = true;
    expect(brokerRuntimeEnvironment(known)).toMatchObject({
      availableRuntimeCommands: ["node"],
      runtimeCommandSnapshotComplete: true
    });

    const unknown = report();
    unknown.capabilities.runtimeCommands = ["node"];
    expect(brokerRuntimeEnvironment(unknown)).toMatchObject({
      availableRuntimeCommands: ["node"],
      runtimeCommandSnapshotComplete: false
    });

    const ociWithoutObservedPath = report();
    ociWithoutObservedPath.container = { available: true, backend: "oci" };
    ociWithoutObservedPath.capabilities.runtimeCommands = [];
    ociWithoutObservedPath.capabilities.runtimeCommandSnapshotComplete = true;
    expect(brokerRuntimeEnvironment(ociWithoutObservedPath).runtimeCommandSnapshotComplete).toBe(false);

    const ociWithObservedEmptyPath = report();
    ociWithObservedEmptyPath.container = { available: true, backend: "oci" };
    ociWithObservedEmptyPath.capabilities.runtimeCommands = [];
    ociWithObservedEmptyPath.capabilities.runtimeCommandSnapshotComplete = true;
    ociWithObservedEmptyPath.capabilities.executableSearchPaths = [];
    expect(brokerRuntimeEnvironment(ociWithObservedEmptyPath).runtimeCommandSnapshotComplete).toBe(true);
  });

  it("resolves script-backed package-manager aliases through the trusted runtime", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-script-toolchain-"));
    try {
      const runtime = path.join(root, process.platform === "win32" ? "runtime.exe" : "runtime");
      const packageRoot = path.join(root, "package-manager");
      const entryPoint = path.join(packageRoot, "pnpm.cjs");
      await import("node:fs/promises").then(async (fs) => {
        await fs.mkdir(packageRoot, { recursive: true });
        await fs.writeFile(runtime, "runtime", "utf8");
        await fs.writeFile(entryPoint, "entry", "utf8");
      });
      const toolchains = normalizeTrustedToolchains([{
        id: "script-runtime",
        runtime: "generic",
        executable: runtime,
        aliases: ["runtime", "pnpm"],
        aliasArguments: { pnpm: [entryPoint] },
        executionRoots: [runtime],
        runtimeRoots: [packageRoot]
      }]);

      expect(resolveTrustedInvocation("pnpm", ["test"], toolchains, root)).toEqual({
        executable: path.resolve(runtime),
        args: [entryPoint, "test"]
      });
      expect(() => normalizeTrustedToolchains([{
        id: "escaped-script-runtime",
        runtime: "generic",
        executable: runtime,
        aliases: ["pnpm"],
        aliasArguments: { pnpm: [path.join(root, "outside.cjs")] },
        runtimeRoots: [packageRoot]
      }])).toThrow(/inside a declared runtime root/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("forwards workspace lease maintenance through the capability wrapper", async () => {
    const native = fixtureBroker(async () => report());
    const status = vi.fn(async () => ({
      leaseId: "lease", workspaceIdentity: "workspace", generation: 2,
      principalId: "principal", access: "read" as const, roots: ["C:/workspace"], state: "active" as const
    }));
    const revoke = vi.fn(async () => ({ revoked: true, retiredPrincipalId: "principal", generation: 3 }));
    native.sandboxLeaseStatus = status;
    native.revokeSandboxLease = revoke;
    const wrapped = withTrustedRuntimeCapabilities(native, undefined);

    await expect(wrapped.sandboxLeaseStatus?.("C:/workspace")).resolves.toMatchObject({ generation: 2 });
    await expect(wrapped.revokeSandboxLease?.("C:/workspace")).resolves.toMatchObject({ generation: 3 });
    expect(status).toHaveBeenCalledWith("C:/workspace", undefined);
    expect(revoke).toHaveBeenCalledWith("C:/workspace", undefined);
  });

  it("forwards session scratch and repository metadata leases through the capability wrapper", async () => {
    const native = fixtureBroker(async () => report());
    const scratchRequest: ScratchLeaseRequestV1 = { protocolVersion: 1, sessionId: "session-fixture" };
    const scratchLease: ScratchLeaseV1 = {
      ...scratchRequest,
      leaseId: "scratch-fixture",
      lifetime: "runtime_session",
      isolation: "private",
      persistentAcrossCalls: true,
      home: "C:/scratch/home",
      temp: "C:/scratch/temp"
    };
    const repositoryRequest: RepositoryMetadataLeaseRequestV1 = {
      protocolVersion: 1,
      repositoryRoot: "C:/workspace",
      gitDir: "C:/workspace/.git",
      commonDir: "C:/workspace/.git",
      executable: "C:/runtime/git.exe",
      network: "none"
    };
    const repositoryLease: RepositoryMetadataLeaseV1 = {
      ...repositoryRequest,
      leaseId: "repository-fixture",
      executableSha256: "a".repeat(64),
      uses: 1
    };
    const requestOptions: BrokerRequestOptions = { timeoutMs: 321 };
    const acquireScratchLease = vi.fn(async () => scratchLease);
    const releaseScratchLease = vi.fn(async () => undefined);
    const acquireRepositoryMetadataLease = vi.fn(async () => repositoryLease);
    native.acquireScratchLease = acquireScratchLease;
    native.releaseScratchLease = releaseScratchLease;
    native.acquireRepositoryMetadataLease = acquireRepositoryMetadataLease;
    const wrapped = withTrustedRuntimeCapabilities(native, undefined);

    await expect(wrapped.acquireScratchLease?.(scratchRequest, requestOptions)).resolves.toBe(scratchLease);
    await expect(wrapped.acquireRepositoryMetadataLease?.(repositoryRequest, requestOptions))
      .resolves.toBe(repositoryLease);
    await expect(wrapped.releaseScratchLease?.("session-fixture", requestOptions)).resolves.toBeUndefined();
    expect(acquireScratchLease).toHaveBeenCalledWith(scratchRequest, requestOptions);
    expect(acquireRepositoryMetadataLease).toHaveBeenCalledWith(repositoryRequest, requestOptions);
    expect(releaseScratchLease).toHaveBeenCalledWith("session-fixture", requestOptions);
  });

  it("does not manufacture lease capabilities that the wrapped broker lacks", () => {
    const native = fixtureBroker(async () => report());
    native.acquireScratchLease = vi.fn();
    const wrapped = withTrustedRuntimeCapabilities(native, undefined);

    expect(wrapped.acquireScratchLease).toBeUndefined();
    expect(wrapped.releaseScratchLease).toBeUndefined();
    expect(wrapped.acquireRepositoryMetadataLease).toBeUndefined();
  });

  it("keeps scratch cleanup callable through the lazy runtime capability stack", async () => {
    const native = fixtureBroker(async () => report());
    const releaseScratchLease = vi.fn(async () => undefined);
    native.acquireScratchLease = vi.fn(async (request: ScratchLeaseRequestV1): Promise<ScratchLeaseV1> => ({
      ...request,
      leaseId: "scratch-fixture",
      lifetime: "runtime_session",
      isolation: "private",
      persistentAcrossCalls: true,
      home: "C:/scratch/home",
      temp: "C:/scratch/temp"
    }));
    native.releaseScratchLease = releaseScratchLease;
    const broker = new LazyExecutionBroker({
      sandboxMode: "required",
      clientFactory: () => withTrustedRuntimeCapabilities(native, undefined)
    });

    try {
      await expect(broker.acquireScratchLease({ protocolVersion: 1, sessionId: "session-fixture" }))
        .resolves.toMatchObject({ leaseId: "scratch-fixture" });
      const releaseGate = Promise.withResolvers<void>();
      releaseScratchLease.mockImplementation(async () => await releaseGate.promise);
      const firstRelease = broker.releaseScratchLease("session-fixture");
      const concurrentRelease = broker.releaseScratchLease("session-fixture");
      await vi.waitFor(() => expect(releaseScratchLease).toHaveBeenCalledTimes(1));
      releaseGate.resolve();
      await expect(Promise.all([firstRelease, concurrentRelease])).resolves.toEqual([undefined, undefined]);
      await expect(broker.releaseScratchLease("session-fixture")).resolves.toBeUndefined();
      expect(releaseScratchLease).toHaveBeenCalledWith("session-fixture", undefined);
      expect(releaseScratchLease).toHaveBeenCalledTimes(1);
    } finally {
      await broker.close();
    }
  });

  it("does not require or start a scratch capability for a session that never acquired scratch", async () => {
    const connect = vi.fn(async () => report());
    const native = fixtureBroker(connect);
    const broker = new LazyExecutionBroker({
      sandboxMode: "required",
      clientFactory: () => withTrustedRuntimeCapabilities(native, undefined)
    });

    try {
      await expect(broker.releaseScratchLease("read-only-session")).resolves.toBeUndefined();
      expect(connect).not.toHaveBeenCalled();
      await broker.connect();
      await expect(broker.releaseScratchLease("read-only-session")).resolves.toBeUndefined();
      expect(connect).toHaveBeenCalledTimes(1);
    } finally {
      await broker.close();
    }
  });

  it("fails closed for a held scratch lease and retains it for a release retry", async () => {
    const native = fixtureBroker(async () => report());
    native.acquireScratchLease = vi.fn(async (request: ScratchLeaseRequestV1): Promise<ScratchLeaseV1> => ({
      ...request,
      leaseId: "scratch-held",
      lifetime: "runtime_session",
      isolation: "private",
      persistentAcrossCalls: true,
      home: "C:/scratch/home",
      temp: "C:/scratch/temp"
    }));
    const releaseScratchLease = vi.fn(async () => undefined);
    native.releaseScratchLease = releaseScratchLease;
    const broker = new LazyExecutionBroker({ sandboxMode: "required", clientFactory: () => native });

    try {
      await broker.acquireScratchLease({ protocolVersion: 1, sessionId: "held-session" });
      delete native.releaseScratchLease;
      await expect(broker.releaseScratchLease("held-session")).rejects.toMatchObject({
        code: "scratch_lease_unavailable"
      });
      native.releaseScratchLease = releaseScratchLease;
      await expect(broker.releaseScratchLease("held-session")).resolves.toBeUndefined();
      await expect(broker.releaseScratchLease("held-session")).resolves.toBeUndefined();
      expect(releaseScratchLease).toHaveBeenCalledTimes(1);
    } finally {
      await broker.close();
    }
  });

  it("reports and forwards handoff only when the wrapped broker implements it", async () => {
    const advertised = report();
    advertised.capabilities.processHandoff = true;
    const withoutHandoff = withTrustedRuntimeCapabilities(
      fixtureBroker(async () => advertised), undefined
    );
    await expect(withoutHandoff.connect()).resolves.toMatchObject({
      capabilities: { processHandoff: false }
    });

    const handoff = vi.fn(async () => ({ handoffId: "handoff-fixture" }));
    const native = { ...fixtureBroker(async () => advertised), handoff };
    const wrapped = withTrustedRuntimeCapabilities(native, undefined);
    await expect(wrapped.connect()).resolves.toMatchObject({
      capabilities: { processHandoff: true }
    });
    await expect(wrapped.handoff?.({ id: "process-fixture" })).resolves.toEqual({
      handoffId: "handoff-fixture"
    });
    expect(handoff).toHaveBeenCalledWith({ id: "process-fixture" }, undefined);
  });

  it("does not manufacture a capability report when connection validation fails", async () => {
    const failure = new Error("connection validation failed");
    const broker = withTrustedRuntimeCapabilities(
      fixtureBroker(async () => await Promise.reject(failure)),
      [{ id: "runtime", executable: process.execPath, aliases: ["runtime-alias"] }]
    );

    await expect(broker.connect()).rejects.toBe(failure);
  });
});
