import { Writable } from "node:stream";
import type { BrokerDoctorReport, ExecutionBroker } from "../packages/agent-execution/src/index.js";
import { runSandboxCommand } from "../packages/agent-cli/src/commands/sandbox.js";
import { describe, expect, it } from "vitest";

class Capture extends Writable {
  private readonly chunks: Buffer[] = [];
  _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    callback();
  }
  text(): string { return Buffer.concat(this.chunks).toString("utf8"); }
}

function broker(ready: boolean): ExecutionBroker {
  const report: BrokerDoctorReport = {
    protocolVersion: 1,
    brokerVersion: "fixture",
    platform: "linux",
    architecture: "x64",
    sandbox: {
      available: ready,
      backend: "fixture",
      selfTestPassed: ready,
      setupRequired: !ready,
      ...(ready ? {} : { reason: "fixture unavailable" })
    },
    capabilities: {
      foreground: true, background: true, stdin: true, pty: false,
      networkModes: ready ? ["none", "full"] : []
    }
  };
  const unused = async (): Promise<never> => { throw new Error("unused"); };
  return {
    lostProcessHandles: [], connect: async () => report, doctor: async () => report,
    execute: unused, spawn: unused, poll: unused, write: unused, terminate: unused,
    close: async () => undefined
  };
}

describe("sandbox CLI", () => {
  it("reports a ready native sandbox", async () => {
    const stdout = new Capture();
    await expect(runSandboxCommand(["setup", "--json"], { stdout, executionBroker: broker(true) })).resolves.toBe(0);
    expect(JSON.parse(stdout.text())).toMatchObject({ ready: true, backend: "fixture" });
  });

  it("fails closed when setup is unavailable", async () => {
    const stderr = new Capture();
    await expect(runSandboxCommand(["setup"], { stderr, executionBroker: broker(false) })).resolves.toBe(1);
    expect(stderr.text()).toContain("no safe automatic setup");
  });

  it("prints help and rejects unknown subcommands", async () => {
    const stdout = new Capture();
    await expect(runSandboxCommand(["--help"], { stdout })).resolves.toBe(0);
    expect(stdout.text()).toContain("agent sandbox setup");
    const stderr = new Capture();
    await expect(runSandboxCommand(["break"], { stderr })).resolves.toBe(1);
    expect(stderr.text()).toContain("Unknown sandbox command");
  });
});
