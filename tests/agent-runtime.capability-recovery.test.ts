import { describe, expect, it, vi } from "vitest";
import {
  advanceCapabilityRecovery,
  capabilityRecoveryObligation
} from "../packages/agent-kernel/src/index.js";
import type { ToolDescriptor } from "../packages/agent-protocol/src/index.js";
import {
  assertTaskControlCallAllowed
} from "../packages/agent-runtime/src/tool-plan-enforcement.js";
import {
  descriptorAllowedForRepair
} from "../packages/agent-runtime/src/tool-turn-policy.js";
import { recordRuntimeDependencyFailure } from "../packages/agent-runtime/src/runtime-dependency-observation.js";
import { runtimeSessionFixture } from "./testkit/runtime-session-fixture.js";

function descriptor(name: string, effects: ToolDescriptor["possibleEffects"]): ToolDescriptor {
  return {
    name,
    description: name,
    inputSchema: { type: "object" },
    possibleEffects: effects,
    maximumEffects: effects,
    executionMode: "exclusive",
    resourceKeys: [],
    approval: "auto",
    idempotent: false,
    timeoutMs: 1_000
  };
}

describe("runtime capability recovery projection", () => {
  const prepare = descriptor("environment_prepare", ["process.spawn", "network", "open_world"]);
  const exec = descriptor("exec", ["process.spawn", "filesystem.read"]);
  const read = descriptor("read", ["filesystem.read"]);

  it("does not expose managed preparation without a runtime opportunity", () => {
    const session = runtimeSessionFixture();
    expect(descriptorAllowedForRepair(session, prepare)).toBe(false);
    expect(descriptorAllowedForRepair(session, exec)).toBe(true);
  });

  it("binds prepare and re-probe to the observed executable and operation", () => {
    const session = runtimeSessionFixture();
    session.durable.state.taskControl = capabilityRecoveryObligation(
      session.durable.state.taskControl,
      session.durable.state.revision,
      {
        opportunityId: "opportunity",
        requestedExecutable: "new-tool",
        probeToolName: "exec",
        runtimeClosureDigest: "sha256:before"
      }
    );
    expect(descriptorAllowedForRepair(session, prepare)).toBe(true);
    expect(descriptorAllowedForRepair(session, exec)).toBe(false);
    expect(descriptorAllowedForRepair(session, read)).toBe(false);
    expect(() => assertTaskControlCallAllowed(session, {
      id: "wrong",
      name: "environment_prepare",
      arguments: { requestedExecutable: "other-tool", packages: ["fixture"] }
    })).toThrowError(expect.objectContaining({ code: "tool_unavailable_for_repair" }));
    expect(() => assertTaskControlCallAllowed(session, {
      id: "prepare",
      name: "environment_prepare",
      arguments: { requestedExecutable: "new-tool", packages: ["fixture"] }
    })).not.toThrow();

    session.durable.state.taskControl = advanceCapabilityRecovery(
      session.durable.state.taskControl,
      session.durable.state.revision + 1,
      "sha256:after"
    );
    expect(descriptorAllowedForRepair(session, prepare)).toBe(false);
    expect(descriptorAllowedForRepair(session, exec)).toBe(true);
    expect(() => assertTaskControlCallAllowed(session, {
      id: "wrong-probe",
      name: "exec",
      arguments: { executable: "other-tool", args: [] }
    })).toThrowError(expect.objectContaining({ code: "tool_unavailable_for_repair" }));
    expect(() => assertTaskControlCallAllowed(session, {
      id: "probe",
      name: "exec",
      arguments: { executable: "new-tool", args: ["--version"] }
    })).not.toThrow();
  });

  it("does not infer a recovery opportunity from a lookalike error or stderr", async () => {
    const session = runtimeSessionFixture({
      execution: {
        managedSessionBinding: {
          protocolVersion: 1,
          sessionId: "session",
          workspace: process.cwd(),
          network: "full",
          protectedPaths: [],
          bindingId: "binding",
          lifetime: "runtime_session",
          targetId: "target",
          targetStartedAt: "start",
          targetAttestationDigest: "sha256:target",
          protectedPathsDigest: "sha256:paths",
          runtimeClosure: {
            protocolVersion: 1,
            digest: "sha256:closure",
            complete: true,
            platform: "linux",
            architecture: "x64",
            executableSearchPathsDigest: "sha256:paths",
            runtimeCommandsDigest: "sha256:commands",
            targetAttestationDigest: "sha256:target"
          },
          scratchLease: {
            protocolVersion: 1,
            sessionId: "session",
            leaseId: "scratch",
            lifetime: "runtime_session",
            isolation: "private",
            persistentAcrossCalls: true,
            home: "/root",
            temp: "/tmp"
          }
        }
      }
    });
    const emit = vi.fn(async () => undefined);
    const options = {
      runtime: { execution: { prepareManagedEnvironment: async () => { throw new Error("unused"); } } },
      emit
    } as unknown as Parameters<typeof recordRuntimeDependencyFailure>[0];
    const call = { id: "probe", name: "exec", arguments: { executable: "new-tool", args: [] } };
    await recordRuntimeDependencyFailure(
      options,
      session,
      call,
      Object.assign(new Error("stderr guessed missing"), { code: "executable_not_found" })
    );
    expect(emit).not.toHaveBeenCalled();
  });
});
