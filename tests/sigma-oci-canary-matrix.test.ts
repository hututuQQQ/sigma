import { describe, expect, it } from "vitest";
import {
  CANARY_LABEL,
  assertSafeRunId,
  buildResourcePlan,
  createRunId,
  engineCandidates,
  executeMatrix,
  parseArguments,
  selectExactCleanupTargets,
  verifyRoleIsolation
} from "../scripts/ci/sigma-oci-canary-matrix.mjs";

const runId = "sigma-oci-canary-unit-1234";

function plan() {
  return buildResourcePlan({
    runId,
    agentCliTarball: "/fixture/agent-cli.tgz",
    image: "example.invalid/control@sha256:deadbeef",
    targetImage: "example.invalid/target@sha256:cafebabe",
    brokerSource: "/fixture/sigma-oci-broker.mjs",
    clientSource: "/fixture/sigma-oci-canary-client.mjs",
    socket: "/fixture/docker.sock",
    secret: "control-only-secret",
    harborBindRoot: "/fixture/harbor-trial"
  });
}

describe("OCI canary matrix planning", () => {
  it("accepts only narrow run identities and deterministic engine choices", () => {
    expect(assertSafeRunId(runId)).toBe(runId);
    expect(createRunId(0, "0123456789")).toBe("sigma-oci-canary-0-0123456789");
    expect(engineCandidates("auto")).toEqual(["docker", "podman"]);
    expect(engineCandidates("docker")).toEqual(["docker"]);
    expect(() => assertSafeRunId("sigma-oci-canary-*" )).toThrow(/narrow/u);
    expect(() => assertSafeRunId("other-project")).toThrow(/narrow/u);
    expect(() => engineCandidates("host")).toThrow(/auto, docker, or podman/u);
  });

  it("parses explicit inputs without accepting unknown flags", () => {
    const value = parseArguments([
      "--engine", "podman", "--run-id", runId, "--agent-cli-tarball", "fixture/agent-cli.tgz",
      "--image", "fixture/runtime@sha256:1", "--target-image", "fixture/target@sha256:2",
      "--output", "fixture/report.json"
    ]);
    expect(value).toMatchObject({
      engine: "podman",
      runId,
      image: "fixture/runtime@sha256:1",
      targetImage: "fixture/target@sha256:2"
    });
    expect(value.agentCliTarball).toMatch(/fixture[\\/]agent-cli\.tgz$/u);
    expect(value.output).toMatch(/fixture[\\/]report\.json$/u);
    const compatible = parseArguments(["--image", "fixture/shared@sha256:3"]);
    expect(compatible.targetImage).toBe("fixture/shared@sha256:3");
    expect(() => parseArguments(["--cleanup-all", "yes"])).toThrow(/Unknown/u);
    expect(() => parseArguments(["--engine", "host"])).toThrow(/auto, docker, or podman/u);
  });

  it("keeps the target image separate from the control and broker runtime", () => {
    const value = plan();
    expect(value.target).toContain("example.invalid/target@sha256:cafebabe");
    expect(value.target).not.toContain("example.invalid/control@sha256:deadbeef");
    for (const command of [value.broker, value.controlContainer, value.controlSeed]) {
      expect(command).toContain("example.invalid/control@sha256:deadbeef");
      expect(command).not.toContain("example.invalid/target@sha256:cafebabe");
    }
  });

  it("gives only the broker the engine socket and only control the secret", () => {
    const value = plan();
    expect(value.volumes).toHaveLength(6);
    expect(JSON.stringify(value.target)).not.toContain("control-only-secret");
    expect(JSON.stringify(value.broker)).not.toContain("control-only-secret");
    expect(JSON.stringify(value.controlContainer)).toContain("control-only-secret");
    expect(value.broker[0]).toBe("create");
    expect(value.controlContainer[0]).toBe("create");
    expect(JSON.stringify(value.control(false))).not.toContain("control-only-secret");
    expect(JSON.stringify(value.controlSeed)).not.toContain("control-only-secret");
    expect(JSON.stringify(value.controlSeed)).not.toContain("/var/run/docker.sock");
    expect(JSON.stringify(value.controlSeed)).toContain("target=/opt/sigma-control");
    expect(JSON.stringify(value.target)).not.toContain("/var/run/docker.sock");
    expect(JSON.stringify(value.broker)).toContain("/var/run/docker.sock");
    expect(JSON.stringify(value.control(false))).not.toContain("/var/run/docker.sock");
    expect(JSON.stringify(value.target)).toContain("target=/app");
    expect(JSON.stringify(value.target)).toContain("target=/logs/verifier");
    expect(JSON.stringify(value.target)).toContain("target=/logs/agent");
    expect(JSON.stringify(value.target)).toContain("target=/logs/artifacts");
    expect(JSON.stringify(value.controlContainer)).toContain("target=/app");
    expect(value.target.some((argument) => /target=\/run\/sigma-oci(?:,|$)/u.test(argument))).toBe(false);
    expect(value.expected.target.labels).toMatchObject({
      [CANARY_LABEL]: runId,
      "com.docker.compose.service": "main",
      "com.sigma.oci-target": "managed-main-v1"
    });
  });

  it("verifies role isolation from engine inspection rather than names", () => {
    const value = plan();
    const inspection = (role: "target" | "broker" | "control") => {
      const expected = value.expected[role];
      return {
        Config: {
          Labels: expected.labels,
          Env: expected.secret ? ["SIGMA_OCI_CANARY_SECRET=control-only-secret"] : []
        },
        Mounts: [
          ...(expected.engineSocket ? [{ Destination: "/var/run/docker.sock" }] : []),
          ...(expected.ipc ? [{ Destination: "/run/sigma-oci" }] : []),
          ...(expected.workspace ? [{ Destination: "/app" }] : []),
          { Destination: "/opt/sigma-helper", RW: expected.helper === "read_write" }
        ]
      };
    };
    for (const role of ["target", "broker", "control"] as const) {
      expect(verifyRoleIsolation(role, inspection(role), value.expected[role], "control-only-secret")).toBe(true);
    }
    const compromised = inspection("target");
    compromised.Mounts.push({ Destination: "/var/run/docker.sock" });
    expect(() => verifyRoleIsolation("target", compromised, value.expected.target, "control-only-secret"))
      .toThrow(/engine socket isolation/u);
  });

  it("selects cleanup targets only after exact label attestation", () => {
    expect(selectExactCleanupTargets("container", [{
      Id: "container-1", Config: { Labels: { [CANARY_LABEL]: runId } }
    }], runId)).toEqual(["container-1"]);
    expect(selectExactCleanupTargets("volume", [{
      Name: "volume-1", Labels: { [CANARY_LABEL]: runId }
    }], runId)).toEqual(["volume-1"]);
    expect(selectExactCleanupTargets("image", [{
      Id: "image-1", Config: { Labels: { [CANARY_LABEL]: runId } }
    }], runId)).toEqual(["image-1"]);
    expect(() => selectExactCleanupTargets("container", [{
      Id: "container-2", Config: { Labels: { [CANARY_LABEL]: `${runId}-other` } }
    }], runId)).toThrow(/Refusing to clean/u);
  });

  it("keeps unavailable engines typed while passing when another engine completes", async () => {
    const options = parseArguments(["--engine", "auto", "--run-id", runId]);
    const report = await executeMatrix(options, {
      probe: async (engine: string) => engine === "docker"
        ? { engine, status: "available", socket: "/docker.sock", version: "fixture" }
        : {
            engine,
            status: "capability_unavailable",
            failure: { code: "container_engine_unavailable", reason: "not installed" }
          },
      runMatrix: async (engine: string) => ({ engine, status: "passed", cases: [] })
    });
    expect(report.status).toBe("passed");
    expect(report.results).toEqual([
      { engine: "docker", status: "passed", cases: [] },
      {
        engine: "podman",
        status: "capability_unavailable",
        failure: { code: "container_engine_unavailable", reason: "not installed" }
      }
    ]);
  });
});
