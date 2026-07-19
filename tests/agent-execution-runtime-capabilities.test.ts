import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  BrokerDoctorReport,
  ExecutionBroker
} from "../packages/agent-execution/src/index.js";
import {
  nodeRuntimeReadRoots,
  withTrustedRuntimeCapabilities
} from "../packages/agent-execution/src/lazy-execution-broker-runtime.js";
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
