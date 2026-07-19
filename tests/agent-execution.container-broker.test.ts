import { describe, expect, it, vi } from "vitest";
import {
  AttestedContainerExecutionBroker,
  ContainerAttestationInvalidError,
  ContainerUnavailableError,
  managedContainerAttestationDigest,
  type BrokerDoctorReport,
  type ExecutionBroker,
  type ExecutionRequest,
  type ExecutionResult,
  type TrustedManagedContainerAttestationV1
} from "../packages/agent-execution/src/index.js";

const digest = `sha256:${"1".repeat(64)}`;
const attestationPayload = {
  protocolVersion: 1 as const,
  engine: "docker" as const,
  selector: "compose-project/main",
  targetId: "target-1",
  targetStartedAt: "2026-07-19T00:00:00Z",
  imageId: "image-1",
  imageDigest: digest,
  labelsDigest: `sha256:${"3".repeat(64)}`,
  helperDigest: `sha256:${"4".repeat(64)}`
};
const attestationDigest = managedContainerAttestationDigest(attestationPayload);

function report(overrides: Partial<NonNullable<BrokerDoctorReport["container"]>> = {}): BrokerDoctorReport {
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
      processHandoff: false,
      networkModes: ["full"]
    },
    container: {
      available: true,
      backend: "oci",
      engine: "docker",
      target: "managed",
      targetId: "target-1",
      targetStartedAt: "2026-07-19T00:00:00Z",
      imageId: "image-1",
      imageDigest: digest,
      helperDigest: attestationPayload.helperDigest,
      attestationDigest,
      ...overrides
    }
  };
}

function terminal(): ExecutionResult {
  return {
    state: "exited",
    exitCode: 0,
    signal: null,
    durationMs: 1,
    timedOut: false,
    idleTimedOut: false,
    cancelled: false,
    stdout: "ok",
    stderr: "",
    stdoutDroppedBytes: 0,
    stderrDroppedBytes: 0,
    outputTruncated: false
  };
}

function broker(reports: BrokerDoctorReport[]): ExecutionBroker & { execute: ReturnType<typeof vi.fn> } {
  let index = 0;
  const next = vi.fn(async () => reports[Math.min(index++, reports.length - 1)]!);
  const execute = vi.fn(async () => terminal());
  const unused = vi.fn(async (): Promise<never> => { throw new Error("unused"); });
  return {
    lostProcessHandles: [],
    connect: next,
    doctor: next,
    execute,
    spawn: unused,
    poll: unused,
    write: unused,
    terminate: unused,
    close: vi.fn(async () => undefined)
  };
}

function attestation(): TrustedManagedContainerAttestationV1 {
  return {
    ...attestationPayload,
    attestationDigest
  };
}

const request: ExecutionRequest = {
  command: { executable: "/bin/true", cwd: "/workspace" },
  policy: {
    sandbox: "required",
    network: "full",
    networkApproved: true,
    readRoots: ["/workspace"],
    writeRoots: []
  }
};

describe("attested OCI execution broker", () => {
  it("connects and gates execution on the pinned managed target identity", async () => {
    const underlying = broker([report(), report()]);
    const guarded = new AttestedContainerExecutionBroker(underlying, {
      config: { engine: "auto", target: "managed" },
      managedAttestation: attestation()
    });

    await expect(guarded.connect()).resolves.toMatchObject({
      container: { available: true, engine: "docker", targetId: "target-1" }
    });
    await expect(guarded.execute(request)).resolves.toMatchObject({ exitCode: 0, stdout: "ok" });
    expect(underlying.doctor).toHaveBeenCalledTimes(2);
    expect(underlying.execute).toHaveBeenCalledOnce();
  });

  it("fails before dispatch when the managed target is replaced", async () => {
    const underlying = broker([report(), report({ targetId: "target-2" })]);
    const guarded = new AttestedContainerExecutionBroker(underlying, {
      config: { engine: "docker", target: "managed" },
      managedAttestation: attestation()
    });
    await guarded.connect();

    await expect(guarded.execute(request)).rejects.toMatchObject({
      code: "container_attestation_invalid"
    });
    expect(underlying.execute).not.toHaveBeenCalled();
  });

  it("requires launcher-only attestation for managed targets", () => {
    expect(() => new AttestedContainerExecutionBroker(broker([report()]), {
      config: { engine: "auto", target: "managed" }
    })).toThrow(ContainerAttestationInvalidError);
  });

  it("requires an immutable digest for owned targets", () => {
    expect(() => new AttestedContainerExecutionBroker(broker([report({ target: "owned" })]), {
      config: { engine: "docker", target: "owned", image: "example/latest" }
    })).toThrow(/immutable image reference/iu);
  });

  it("requires an image for owned targets before a launcher is contacted", () => {
    expect(() => new AttestedContainerExecutionBroker(broker([report({ target: "owned" })]), {
      config: { engine: "docker", target: "owned" }
    })).toThrow(/require containerImage/iu);
  });

  it("normalizes an uppercase owned image digest before comparing the attested identity", async () => {
    const guarded = new AttestedContainerExecutionBroker(broker([
      report({ target: "owned", imageDigest: digest })
    ]), {
      config: {
        engine: "docker",
        target: "owned",
        image: `example.invalid/sigma@${digest.toUpperCase()}`
      }
    });

    await expect(guarded.connect()).resolves.toMatchObject({
      container: { target: "owned", imageDigest: digest }
    });
  });

  it("rejects a broker that is not an available OCI boundary", async () => {
    const unavailable = report({ available: false, reason: "engine socket unavailable" });
    const guarded = new AttestedContainerExecutionBroker(broker([unavailable]), {
      config: { engine: "docker", target: "managed" },
      managedAttestation: attestation()
    });
    await expect(guarded.connect()).rejects.toBeInstanceOf(ContainerUnavailableError);
  });

  it("rejects an engine different from the explicitly selected engine", async () => {
    const podmanPayload = { ...attestationPayload, engine: "podman" as const };
    const guarded = new AttestedContainerExecutionBroker(broker([report()]), {
      config: { engine: "podman", target: "managed" },
      managedAttestation: {
        ...podmanPayload,
        attestationDigest: managedContainerAttestationDigest(podmanPayload)
      }
    });
    await expect(guarded.connect()).rejects.toMatchObject({
      code: "container_attestation_invalid",
      data: { expected: "podman", observed: "docker" }
    });
  });

  it("rejects a launcher proof whose canonical digest was tampered with", () => {
    expect(() => new AttestedContainerExecutionBroker(broker([report()]), {
      config: { engine: "docker", target: "managed" },
      managedAttestation: { ...attestation(), targetId: "substituted-target" }
    })).toThrow(/attestation digest is invalid/iu);
  });
});
