import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { runAgentCommand } from "../packages/agent-cli/src/index.js";
import { buildVersionReport, runVersionCommand, type VersionReport } from "../packages/agent-cli/src/commands/version.js";

class MemoryWritable extends Writable {
  readonly chunks: string[] = [];

  _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk);
    callback();
  }

  text(): string {
    return this.chunks.join("");
  }
}

function versionReport(bundle: unknown): VersionReport {
  return {
    product: "Sigma Code",
    command: "agent",
    package: {
      name: "agent-cli",
      version: "2.0.0"
    },
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch
    },
    bundle
  };
}

describe("agent-cli version", () => {
  it("builds version metadata from the CLI package", async () => {
    const report = await buildVersionReport();

    expect(report).toMatchObject({
      product: "Sigma Code",
      command: "agent",
      package: {
        name: "agent-cli",
        version: "2.0.0"
      },
      runtime: {
        node: process.version,
        platform: process.platform,
        arch: process.arch
      }
    });
  });

  it("prints human and JSON version output", async () => {
    const textStdout = new MemoryWritable();
    await expect(runVersionCommand([], { stdout: textStdout })).resolves.toBe(0);
    expect(textStdout.text()).toContain("Sigma Code 2.0.0 (agent-cli)");
    expect(textStdout.text()).toContain(`node=${process.version}`);

    const jsonStdout = new MemoryWritable();
    await expect(runVersionCommand(["--json"], { stdout: jsonStdout })).resolves.toBe(0);
    expect(JSON.parse(jsonStdout.text())).toMatchObject({
      product: "Sigma Code",
      package: { name: "agent-cli", version: "2.0.0" }
    });
  });

  it("does not print a bundle label when bundle metadata is absent", async () => {
    const stdout = new MemoryWritable();

    await expect(runVersionCommand([], {
      stdout,
      buildVersionReport: async () => versionReport(null)
    })).resolves.toBe(0);

    expect(stdout.text()).not.toContain("bundle=");
  });

  it("prints the target platform and architecture from Windows bundle metadata", async () => {
    const stdout = new MemoryWritable();

    await expect(runVersionCommand([], {
      stdout,
      buildVersionReport: async () => versionReport({ targetPlatform: "win32", targetArch: "x64" })
    })).resolves.toBe(0);

    expect(stdout.text()).toContain("bundle=win32-x64");
  });

  it("keeps the legacy Linux bundle label when metadata only has targetArch", async () => {
    const stdout = new MemoryWritable();

    await expect(runVersionCommand([], {
      stdout,
      buildVersionReport: async () => versionReport({ targetArch: "x64" })
    })).resolves.toBe(0);

    expect(stdout.text()).toContain("bundle=linux-x64");
  });

  it("supports the top-level --version alias", async () => {
    const stdout = new MemoryWritable();
    const previousWrite = process.stdout.write;
    try {
      process.stdout.write = stdout.write.bind(stdout) as typeof process.stdout.write;
      await expect(runAgentCommand(["--version"])).resolves.toBe(0);
    } finally {
      process.stdout.write = previousWrite;
    }

    expect(stdout.text()).toContain("Sigma Code 2.0.0 (agent-cli)");
  });
});
