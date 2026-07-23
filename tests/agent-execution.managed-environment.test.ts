import { describe, expect, it, vi } from "vitest";
import {
  AttestedContainerExecutionBroker,
  MANAGED_ENVIRONMENT_PROTECTED_PATHS_V1,
  managedContainerAttestationDigest,
  managedEnvironmentProofDigest,
  type BrokerDoctorReport,
  type ExecutionBroker,
  type ExecutionRequest,
  type ExecutionResult,
  type ManagedEnvironmentPrepareRequestV1,
  type TrustedManagedContainerAttestationV1
} from "../packages/agent-execution/src/index.js";
import {
  containerIdentity,
  containerRuntimeClosure,
  stableSha256
} from "../packages/agent-execution/src/container-attestation.js";

const digest = (value: string): string => `sha256:${value.repeat(64)}`;
const baseAttestation = {
  protocolVersion: 1 as const,
  engine: "docker" as const,
  selector: "managed/main",
  targetId: "target-1",
  targetStartedAt: "2026-07-22T00:00:00Z",
  imageId: "image-1",
  imageDigest: digest("1"),
  labelsDigest: digest("2"),
  helperDigest: digest("3")
};
const attestationDigest = managedContainerAttestationDigest(baseAttestation);

function attestation(withEnvironment: boolean): TrustedManagedContainerAttestationV1 {
  if (!withEnvironment) return { ...baseAttestation, attestationDigest };
  const proof = {
    protocolVersion: 1 as const,
    targetAttestationDigest: attestationDigest,
    targetId: baseAttestation.targetId,
    targetStartedAt: baseAttestation.targetStartedAt,
    rootKind: "container_cow" as const,
    effectiveNetwork: "full" as const,
    disposable: true as const,
    protectedPaths: [...MANAGED_ENVIRONMENT_PROTECTED_PATHS_V1]
  };
  return {
    ...baseAttestation,
    attestationDigest,
    managedEnvironment: {
      ...proof,
      proofDigest: managedEnvironmentProofDigest(proof)
    }
  };
}

function report(runtimeCommands = ["apt-get"], managedEnvironment = true): BrokerDoctorReport {
  return {
    protocolVersion: 1,
    brokerVersion: "fixture",
    platform: "linux",
    architecture: "x64",
    sandbox: {
      available: true,
      backend: "oci",
      selfTestPassed: true,
      setupRequired: false
    },
    capabilities: {
      foreground: true,
      background: true,
      stdin: true,
      pty: false,
      networkModes: ["none", "full"],
      runtimeCommands,
      runtimeCommandSnapshotComplete: true,
      executableSearchPaths: ["/usr/bin", "/bin"],
      managedEnvironment: { available: managedEnvironment, prepare: managedEnvironment }
    },
    container: {
      available: true,
      backend: "oci",
      engine: "docker",
      target: "managed",
      targetId: baseAttestation.targetId,
      targetStartedAt: baseAttestation.targetStartedAt,
      imageId: baseAttestation.imageId,
      imageDigest: baseAttestation.imageDigest,
      helperDigest: baseAttestation.helperDigest,
      attestationDigest
    }
  };
}

function terminal(stdout = "ok"): ExecutionResult {
  return {
    state: "exited",
    exitCode: 0,
    signal: null,
    durationMs: 1,
    timedOut: false,
    idleTimedOut: false,
    cancelled: false,
    stdout,
    stderr: "",
    stdoutDroppedBytes: 0,
    stderrDroppedBytes: 0,
    outputTruncated: false
  };
}

function fixtureBroker(managedEnvironment = true): ExecutionBroker & {
  execute: ReturnType<typeof vi.fn>;
  releaseScratchLease: ReturnType<typeof vi.fn>;
  prepareManagedEnvironment: ReturnType<typeof vi.fn>;
} {
  let installed = false;
  const execute = vi.fn(async (request: ExecutionRequest): Promise<ExecutionResult> => {
    return terminal(request.command.executable === "new-tool" ? "new-tool 1.0" : "ok");
  });
  const prepareManagedEnvironment = vi.fn(async (request: ManagedEnvironmentPrepareRequestV1) => {
    installed = true;
    const installedPackages = request.packages.map((name: string) => ({
      name,
      version: "1.0",
      source: "fixture-signed-repository",
      digest: stableSha256({ name, version: "1.0" })
    }));
    const opportunity = stableSha256({
      sessionId: request.sessionId,
      requestedExecutable: request.requestedExecutable
    });
    const runtimeClosure = containerRuntimeClosure(
      report(["apt-get", "new-tool"]),
      containerIdentity(report(["apt-get", "new-tool"]))
    );
    const payload = {
      protocolVersion: 1 as const,
      status: "prepared" as const,
      sessionId: request.sessionId,
      requestedExecutable: request.requestedExecutable,
      packages: request.packages,
      installedPackages,
      packageManager: "apt-get" as const,
      signaturePolicy: "trusted-system-package-manager-defaults" as const,
      attemptDigest: stableSha256({ opportunity, packages: request.packages }),
      installedEvidenceDigest: stableSha256(installedPackages),
      previousRuntimeClosureDigest: containerRuntimeClosure(
        report(), containerIdentity(report())
      ).digest,
      runtimeClosure
    };
    return { ...payload, receiptDigest: stableSha256(payload) };
  });
  const releaseScratchLease = vi.fn(async () => undefined);
  const unused = vi.fn(async (): Promise<never> => { throw new Error("unused"); });
  return {
    lostProcessHandles: [],
    connect: vi.fn(async () => report(["apt-get"], managedEnvironment)),
    doctor: vi.fn(async () => report(
      installed ? ["apt-get", "new-tool"] : ["apt-get"], managedEnvironment
    )),
    acquireScratchLease: vi.fn(async (request) => ({
      ...request,
      leaseId: "scratch-1",
      lifetime: "runtime_session",
      isolation: "private",
      persistentAcrossCalls: true,
      home: "/root",
      temp: "/tmp"
    })),
    releaseScratchLease,
    prepareManagedEnvironment,
    execute,
    spawn: unused,
    poll: unused,
    write: unused,
    terminate: unused,
    close: vi.fn(async () => undefined)
  };
}

describe("managed session binding and environment preparation", () => {
  it("binds runtime-data changes even when the executable set is unchanged", () => {
    const before = report(["apt-get"]);
    const after = report(["apt-get"]);
    before.capabilities.runtimeDataDigest = digest("a");
    after.capabilities.runtimeDataDigest = digest("b");
    const beforeClosure = containerRuntimeClosure(before, containerIdentity(before));
    const afterClosure = containerRuntimeClosure(after, containerIdentity(after));
    expect(beforeClosure.runtimeCommandsDigest).toBe(afterClosure.runtimeCommandsDigest);
    expect(beforeClosure.runtimeDataDigest).toBe(digest("a"));
    expect(afterClosure.runtimeDataDigest).toBe(digest("b"));
    expect(beforeClosure.digest).not.toBe(afterClosure.digest);
  });

  it("requires a launcher-authenticated disposable COW proof in required mode", async () => {
    const guarded = new AttestedContainerExecutionBroker(fixtureBroker(), {
      config: { engine: "docker", target: "managed", network: "full" },
      managedAttestation: attestation(false),
      workspace: "/workspace",
      managedEnvironmentMode: "required"
    });
    await guarded.connect();
    await expect(guarded.bindManagedSession({
      protocolVersion: 1,
      sessionId: "session-1",
      workspace: "/workspace",
      network: "full",
      protectedPaths: ["/workspace/.git", "/workspace/.agent"]
    })).rejects.toMatchObject({ code: "managed_environment_required_unavailable" });
  });

  it("rejects a launcher proof when the target lacks the structured preparation port", async () => {
    const guarded = new AttestedContainerExecutionBroker(fixtureBroker(false), {
      config: { engine: "docker", target: "managed", network: "full" },
      managedAttestation: attestation(true),
      workspace: "/workspace",
      managedEnvironmentMode: "required"
    });
    const connected = await guarded.connect();
    expect(connected.capabilities.managedEnvironment).toEqual({ available: false, prepare: false });
    await expect(guarded.bindManagedSession({
      protocolVersion: 1,
      sessionId: "session-1",
      workspace: "/workspace",
      network: "full",
      protectedPaths: ["/workspace/.git", "/workspace/.agent"]
    })).rejects.toMatchObject({ code: "managed_environment_required_unavailable" });
  });

  it("binds one session before preparation and cannot be widened", async () => {
    const underlying = fixtureBroker();
    const guarded = new AttestedContainerExecutionBroker(underlying, {
      config: { engine: "docker", target: "managed", network: "full" },
      managedAttestation: attestation(true),
      workspace: "/workspace",
      managedEnvironmentMode: "required"
    });
    const connected = await guarded.connect();
    expect(connected.capabilities).toMatchObject({
      runtimeClosure: { complete: true },
      managedEnvironment: { available: true, prepare: true }
    });
    const binding = await guarded.bindManagedSession({
      protocolVersion: 1,
      sessionId: "session-1",
      workspace: "/workspace",
      network: "full",
      protectedPaths: ["/workspace/.git", "/workspace/.agent"]
    });
    expect(binding).toMatchObject({
      lifetime: "runtime_session",
      targetId: "target-1",
      scratchLease: { leaseId: "scratch-1" }
    });
    await expect(guarded.bindManagedSession({
      protocolVersion: 1,
      sessionId: "session-1",
      workspace: "/workspace",
      network: "full",
      protectedPaths: ["/workspace/.git", "/workspace/.agent", "/outside"]
    })).rejects.toThrow(/cannot be widened/iu);
    await guarded.releaseScratchLease("session-1");
    expect(underlying.releaseScratchLease).toHaveBeenCalledWith("session-1", undefined);
  });

  it("uses one canonical package set, protects product paths, and refreshes closure", async () => {
    const underlying = fixtureBroker();
    const guarded = new AttestedContainerExecutionBroker(underlying, {
      config: { engine: "docker", target: "managed", network: "full" },
      managedAttestation: attestation(true),
      workspace: "/workspace",
      managedEnvironmentMode: "required"
    });
    await guarded.connect();
    const binding = await guarded.bindManagedSession({
      protocolVersion: 1,
      sessionId: "session-1",
      workspace: "/workspace",
      network: "full",
      protectedPaths: ["/workspace/.git", "/workspace/.agent"]
    });
    const originalBindingId = binding.bindingId;
    const originalClosureDigest = binding.runtimeClosure.digest;
    const result = await guarded.prepareManagedEnvironment({
      protocolVersion: 1,
      sessionId: "session-1",
      requestedExecutable: "new-tool",
      packages: ["fixture-package", "fixture-package"]
    });
    expect(result).toMatchObject({
      status: "prepared",
      packages: ["fixture-package"],
      packageManager: "apt-get",
      signaturePolicy: "trusted-system-package-manager-defaults"
    });
    expect(result.runtimeClosure.digest).not.toBe(originalClosureDigest);
    expect(binding.runtimeClosure.digest).toBe(result.runtimeClosure.digest);
    expect(binding.bindingId).not.toBe(originalBindingId);
    expect(underlying.prepareManagedEnvironment).toHaveBeenCalledWith({
      protocolVersion: 1,
      sessionId: "session-1",
      requestedExecutable: "new-tool",
      packages: ["fixture-package"]
    }, undefined);
    expect(underlying.execute).not.toHaveBeenCalled();
    await expect(guarded.prepareManagedEnvironment({
      protocolVersion: 1,
      sessionId: "session-1",
      requestedExecutable: "new-tool",
      packages: ["different-package"]
    })).rejects.toMatchObject({ code: "managed_environment_prepare_repeated" });
  });
});
