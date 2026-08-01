import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { runAgentCli } from "../packages/agent-cli/src/bin.js";
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
      version: "0.1.4"
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
        version: "0.1.4"
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
    expect(textStdout.text()).toContain("Sigma Code 0.1.4 (agent-cli)");
    expect(textStdout.text()).toContain(`node=${process.version}`);

    const jsonStdout = new MemoryWritable();
    await expect(runVersionCommand(["--json"], { stdout: jsonStdout })).resolves.toBe(0);
    expect(JSON.parse(jsonStdout.text())).toMatchObject({
      product: "Sigma Code",
      package: { name: "agent-cli", version: "0.1.4" }
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

  it("omits the bundle label when metadata has no target platform", async () => {
    const stdout = new MemoryWritable();

    await expect(runVersionCommand([], {
      stdout,
      buildVersionReport: async () => versionReport({ targetArch: "x64" })
    })).resolves.toBe(0);

    expect(stdout.text()).not.toContain("bundle=");
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

    expect(stdout.text()).toContain("Sigma Code 0.1.4 (agent-cli)");
  });

  it("loads only the lightweight version command for version probes", async () => {
    const versionArgs: string[][] = [];
    let agentLoads = 0;
    let proxyConfigurations = 0;

    await expect(
      runAgentCli(["version", "--json"], {
        configureOutboundProxy: () => {
          proxyConfigurations += 1;
        },
        loadVersionCommand: async () => ({
          runVersionCommand: async (args) => {
            versionArgs.push(args);
            return 0;
          },
        }),
        loadAgentCommand: async () => {
          agentLoads += 1;
          return { runAgentCommand };
        },
      }),
    ).resolves.toBe(0);

    expect(versionArgs).toEqual([["--json"]]);
    expect(agentLoads).toBe(0);
    expect(proxyConfigurations).toBe(0);
  });

  it("loads the full command graph for non-version commands", async () => {
    const forwardedArgs: string[][] = [];
    let versionLoads = 0;
    const lifecycle: string[] = [];

    await expect(
      runAgentCli(["doctor", "--help"], {
        configureOutboundProxy: () => {
          lifecycle.push("proxy");
        },
        loadVersionCommand: async () => {
          versionLoads += 1;
          return { runVersionCommand };
        },
        loadAgentCommand: async () => {
          lifecycle.push("load");
          return {
            runAgentCommand: async (args) => {
              lifecycle.push("command");
              forwardedArgs.push(args);
              return 0;
            },
          };
        },
      }),
    ).resolves.toBe(0);

    expect(forwardedArgs).toEqual([["doctor", "--help"]]);
    expect(versionLoads).toBe(0);
    expect(lifecycle).toEqual(["proxy", "load", "command"]);
  });
});
