import { describe, expect, it, vi } from "vitest";
import { recordRuntimeDependencyFailure } from "../packages/agent-runtime/src/runtime-dependency-observation.js";
import { runtimeSessionFixture } from "./testkit/runtime-session-fixture.js";

describe("runtime capability recovery projection", () => {
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
