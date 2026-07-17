import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  BrokerDoctorReport,
  ExecutionBroker
} from "../packages/agent-execution/src/index.js";
import { withTrustedRuntimeCapabilities } from "../packages/agent-execution/src/lazy-execution-broker-runtime.js";
import {
  assertTrustedToolchainsAvailable,
  normalizeTrustedToolchains
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

  it("describes disposable-container execution as open-world without promising external rollback", () => {
    const environment = { ...runtimeEnvironment("linux"), executionMode: "disposable-container" as const };
    const prompt = runtimePrompt(environment);

    expect(prompt).toContain("executionMode=disposable-container");
    expect(prompt).toContain("open-world inside this user-declared disposable container");
    expect(prompt).toContain("package managers may be used");
    expect(prompt).toContain("outside the workspace are not covered by workspace checkpoint rollback");
    expect(prompt).not.toContain("Do not probe or retry unlisted host commands");
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
    expect(JSON.stringify(connected)).not.toContain(process.execPath);
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
