import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { renderConfigToml, resolveConfig, type McpServerConfigValue } from "../packages/agent-config/src/index.js";
import { loadCliConfig, workspaceMcpTrustMessage } from "../packages/agent-cli/src/config.js";
import { runCommand } from "../packages/agent-cli/src/commands/run.js";
import { runAgentCommand } from "../packages/agent-cli/src/index.js";
import { createConfiguredRuntime } from "../packages/agent-runtime/src/configured-runtime.js";
import { connectMcpServers } from "../packages/agent-runtime/src/composition-mcp.js";
import { verifyWorkspaceMcpTrust } from "../packages/agent-runtime/src/workspace-mcp-trust.js";
import { EffectToolRegistry } from "../packages/agent-tools/src/index.js";
import { createHostExecutionBroker } from "./helpers/host-execution-broker.js";

class Capture extends Writable {
  readonly chunks: Buffer[] = [];
  isTTY = false;

  _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    callback();
  }

  text(): string { return Buffer.concat(this.chunks).toString("utf8"); }
}

function mcpServer(overrides: Record<string, unknown> = {}): McpServerConfigValue {
  const raw = {
    name: "workspace", command: process.execPath, args: [], cwd: ".",
    possible_effects: ["filesystem.read"], ...overrides
  };
  return (resolveConfig({ flags: { "mcp-server": [JSON.stringify(raw)] } }).mcpServers as McpServerConfigValue[])[0];
}

async function writeWorkspaceConfig(workspace: string, server: McpServerConfigValue): Promise<string> {
  const configPath = path.join(workspace, ".agent", "config.toml");
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, renderConfigToml({ workspace, mcpServers: [server] }), "utf8");
  return configPath;
}

describe("workspace MCP trust boundary", () => {
  it("persists explicit trust for only the canonical path and exact config digest", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-mcp-trust-"));
    const home = await mkdtemp(path.join(os.tmpdir(), "sigma-mcp-home-"));
    const trustStorePath = path.join(home, ".sigma", "trust.json");
    const configPath = await writeWorkspaceConfig(workspace, mcpServer());
    const options = { env: {}, homeDir: home, trustStorePath };

    const untrusted = loadCliConfig({ workspace }, options);
    expect(untrusted.mcpSource).toBe("workspace");
    expect(untrusted.workspaceMcpTrust).toMatchObject({ required: true, trusted: false });
    expect(workspaceMcpTrustMessage(untrusted)).toContain("--trust-workspace-mcp");
    expect(workspaceMcpTrustMessage({ ...untrusted, workspaceMcpTrust: undefined })).toContain("--trust-workspace-mcp");

    const granted = loadCliConfig({ workspace, "trust-workspace-mcp": true }, options);
    expect(granted.workspaceMcpTrust).toMatchObject({
      trusted: true,
      canonicalWorkspacePath: await realpath(workspace)
    });
    const durable = await readFile(trustStorePath, "utf8");
    expect(durable).toContain(granted.workspaceMcpTrust!.configDigest);
    expect(durable).not.toContain(process.execPath);
    expect(loadCliConfig({ workspace }, options).workspaceMcpTrust?.trusted).toBe(true);
    await expect(verifyWorkspaceMcpTrust(workspace, "workspace", granted.workspaceMcpTrust)).resolves.toBeUndefined();

    await writeFile(configPath, `${await readFile(configPath, "utf8")}\n# changed\n`, "utf8");
    expect(loadCliConfig({ workspace }, options).workspaceMcpTrust?.trusted).toBe(false);
    await expect(verifyWorkspaceMcpTrust(workspace, "workspace", granted.workspaceMcpTrust))
      .rejects.toThrow("changed after trust");
    await expect(verifyWorkspaceMcpTrust(workspace, "workspace", undefined))
      .rejects.toThrow("requires an explicit trust");
    expect(loadCliConfig({ workspace, "trust-workspace-mcp": true }, options).workspaceMcpTrust?.trusted).toBe(true);
    expect(loadCliConfig({ workspace }, options).workspaceMcpTrust?.trusted).toBe(true);
  });

  it("does not execute malicious repository MCP config from inspect or TUI before trust", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-mcp-malicious-"));
    const home = await mkdtemp(path.join(os.tmpdir(), "sigma-mcp-malicious-home-"));
    const marker = path.join(workspace, "executed.txt");
    const script = `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "owned")`;
    await writeWorkspaceConfig(workspace, mcpServer({ args: ["-e", script] }));
    const stdin = Object.assign(new PassThrough(), { isTTY: false });
    const stdout = new Capture();
    const stderr = new Capture();

    const inspectCode = await runCommand([
      "inspect safely", "--workspace", workspace, "--permission-mode", "deny", "--output-format", "json"
    ], { mode: "analyze", stdin, stdout, stderr });
    expect(inspectCode).toBe(2);
    expect(JSON.parse(stdout.text())).toMatchObject({ finishReason: "workspace_mcp_trust_required" });
    expect(existsSync(marker)).toBe(false);

    let tuiStarted = false;
    const tuiCode = await runAgentCommand(["tui", "--workspace", workspace, "--permission-mode", "deny"], {
      stderr,
      tuiRunner: async () => { tuiStarted = true; }
    });
    expect(tuiCode).toBe(2);
    expect(tuiStarted).toBe(false);
    expect(existsSync(marker)).toBe(false);

    let gatewayCreated = false;
    const untrusted = loadCliConfig({ workspace }, { env: {}, homeDir: home });
    await expect(createConfiguredRuntime(untrusted, {
      gatewayFactory: () => {
        gatewayCreated = true;
        throw new Error("gateway must not be created");
      }
    })).rejects.toThrow("not trusted");
    expect(gatewayCreated).toBe(false);
    expect(existsSync(marker)).toBe(false);
  });

  it("validates every configured cwd before starting any MCP process", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-mcp-cwd-"));
    const workspace = path.join(root, "workspace");
    const outside = path.join(root, "outside");
    await Promise.all([mkdir(workspace), mkdir(outside)]);
    const marker = path.join(workspace, "started.txt");
    const script = `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "started")`;
    const first = mcpServer({ name: "first", args: ["-e", script] });
    const escaped = mcpServer({ name: "escaped", cwd: outside });

    await expect(connectMcpServers(
      [first, escaped], workspace, new EffectToolRegistry(), createHostExecutionBroker()
    ))
      .rejects.toThrow("must stay inside the workspace");
    expect(existsSync(marker)).toBe(false);
  });

  it("rejects every unsafe server before connecting an earlier valid server", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-mcp-effects-"));
    const broker = createHostExecutionBroker();
    const spawn = vi.spyOn(broker, "spawn");
    const safe = mcpServer({ name: "safe" });
    for (const effect of ["filesystem.write", "destructive", "open_world"] as const) {
      const forbidden: McpServerConfigValue = {
        ...mcpServer({ name: `forbidden-${effect}` }),
        possibleEffects: [effect]
      };
      await expect(connectMcpServers(
        [safe, forbidden], workspace, new EffectToolRegistry(), broker
      )).rejects.toMatchObject({
        code: "mcp_persistent_effect_forbidden",
        serverName: `forbidden-${effect}`,
        forbiddenEffects: [effect]
      });
    }
    expect(spawn).not.toHaveBeenCalled();
    await broker.close();
  });
});
