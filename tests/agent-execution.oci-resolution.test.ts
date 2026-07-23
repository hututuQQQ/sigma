import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  requestParams,
  type VerifiedTargetExecutableEnvironment
} from "../packages/agent-execution/src/broker-request-policy.js";
import {
  normalizeTrustedToolchains,
  pathWithin
} from "../packages/agent-execution/src/trusted-toolchains.js";
import type {
  ExecutionRequest,
  SigmaExecBrokerClientOptions
} from "../packages/agent-execution/src/types.js";

function request(executable: string): ExecutionRequest {
  return {
    command: {
      executable,
      cwd: path.resolve("fixture-workspace"),
      environment: { overrides: { PATH: "control-only-path" } }
    },
    policy: {
      sandbox: "required",
      network: "none",
      readRoots: [path.resolve("fixture-workspace")],
      writeRoots: []
    }
  };
}

function options(backend: "native" | "oci"): SigmaExecBrokerClientOptions {
  return {
    trustedStream: {} as SigmaExecBrokerClientOptions["trustedStream"],
    executionBackend: backend,
    sandboxMode: "required"
  };
}

const target: VerifiedTargetExecutableEnvironment = {
  platform: "linux",
  searchPaths: ["/target/bin", "/target/usr/bin"]
};

describe("OCI executable request resolution", () => {
  it("binds bare command lookup to the attested target PATH", () => {
    const params = requestParams(
      request("target-command"),
      options("oci"),
      normalizeTrustedToolchains([]),
      [],
      target
    ) as { command: { executable: string; env: Record<string, string> } };

    expect(params.command.executable).toBe("target-command");
    expect(params.command.env.PATH).toBe("/target/bin:/target/usr/bin");
    expect(JSON.stringify(params)).not.toContain("control-only-path");
  });

  it("fails closed for a bare command when the target did not report PATH", () => {
    expect(() => requestParams(
      request("target-command"),
      options("oci"),
      normalizeTrustedToolchains([]),
      [],
      { platform: "linux", searchPaths: [] }
    )).toThrow(expect.objectContaining({ code: "executable_unavailable" }));
  });

  it("forwards a target absolute path without consulting the control filesystem", () => {
    const params = requestParams(
      request("/target/usr/bin/target-command"),
      options("oci"),
      normalizeTrustedToolchains([]),
      [],
      target
    ) as { command: { executable: string; env: Record<string, string> } };

    expect(params.command.executable).toBe("/target/usr/bin/target-command");
    expect(params.command.env.PATH).toBe("/target/bin:/target/usr/bin");
    expect((params as { policy: { protectedPaths: string[] } }).policy.protectedPaths).toEqual(
      expect.arrayContaining([
        path.join(path.resolve("fixture-workspace"), ".git"),
        path.join(path.resolve("fixture-workspace"), ".agent")
      ])
    );
  });

  it("does not protect repository sentinels inside broker-issued ephemeral scratch", () => {
    const scratchHome = path.resolve("scratch", "home");
    const scratchTemp = path.resolve("scratch", "temp");
    const workspace = path.join(scratchHome, "workspace");
    const value = request("/target/usr/bin/target-command");
    value.command.cwd = workspace;
    value.policy.readRoots = [workspace, scratchHome];
    value.policy.writeRoots = [workspace, scratchHome];
    value.policy.scratchLease = {
      protocolVersion: 1,
      sessionId: "verifier-session",
      leaseId: "broker-issued-lease",
      lifetime: "runtime_session",
      isolation: "private",
      persistentAcrossCalls: true,
      home: scratchHome,
      temp: scratchTemp
    };

    const params = requestParams(
      value,
      options("oci"),
      normalizeTrustedToolchains([]),
      [],
      target
    ) as { policy: { protectedPaths: string[]; scratchLeaseId: string } };

    expect(params.policy.scratchLeaseId).toBe("broker-issued-lease");
    expect(params.policy.protectedPaths.some((item) => pathWithin(item, scratchHome))).toBe(false);
  });
});
