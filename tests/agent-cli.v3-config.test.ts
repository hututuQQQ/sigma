import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runConfigCommand } from "../packages/agent-cli/src/commands/config.js";
import { loadCliConfig } from "../packages/agent-cli/src/config.js";

class Capture {
  value = "";
  write(chunk: string | Uint8Array): boolean { this.value += chunk.toString(); return true; }
}

describe("Sigma config", () => {
  it("defaults to required sandbox, host reads, full network, handoff, and hard shared budgets", () => {
    const config = loadCliConfig({}, { env: {}, cwd: process.cwd(), homeDir: path.join(process.cwd(), ".missing-home") });
    expect(config).toMatchObject({
      sandboxMode: "required",
      executionMode: "sandboxed",
      readScope: "host",
      networkMode: "full",
      processHandoff: "allow",
      outputSchema: 3,
      legacySingleModelRoute: false,
      budget: { maxInputTokens: 8_000_000, maxOutputTokens: 1_000_000, maxCostMicroUsd: 50_000_000 }
    });
  });

  it("maps explicit legacy provider/model flags to a single-candidate route", () => {
    const options = { env: {}, cwd: process.cwd(), homeDir: path.join(process.cwd(), ".missing-home") };
    expect(loadCliConfig({ provider: "glm" }, options).legacySingleModelRoute).toBe(true);
    expect(loadCliConfig({ model: "glm-5.2" }, options).legacySingleModelRoute).toBe(true);
  });

  it("passes an explicit model catalog into production composition config", () => {
    const options = { env: {}, cwd: process.cwd(), homeDir: path.join(process.cwd(), ".missing-home") };
    const rawSpec = {
      id: "deepseek/custom", provider: "deepseek", upstream_model: "custom",
      capabilities: {
        context_window_tokens: 10_000, max_output_tokens: 1_000, tools: true,
        parallel_tools: false, reasoning: true, structured_output: false,
        prompt_cache: false, tokenizer: "approximate"
      },
      tokenizer: { id: "custom", accuracy: "approximate" },
      pricing: {
        input_micro_usd_per_million: 1, output_micro_usd_per_million: 2,
        cache_read_micro_usd_per_million: 0, effective_at: "2026-01-01"
      }
    };
    const rawRoute = {
      id: "custom", candidates: ["deepseek/custom"], fallback_on: ["timeout"], max_attempts: 1
    };
    const config = loadCliConfig({
      "model-spec": [JSON.stringify(rawSpec)],
      "model-route": [JSON.stringify(rawRoute)]
    }, options);
    expect(config.modelSpecs).toEqual([expect.objectContaining({ id: "deepseek/custom" })]);
    expect(config.modelRoutes).toEqual([expect.objectContaining({ id: "custom" })]);
  });

  it("rejects workspace attempts to enable unsafe host execution", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-config-unsafe-"));
    await mkdir(path.join(root, ".agent"));
    await writeFile(path.join(root, ".agent", "config.toml"), [
      "schema_version = 3", "[workspace]", "path = \".\"", "[security]", "sandbox = \"required\"",
      "network = \"none\"", "allow_unsafe_host_exec = true"
    ].join("\n"), "utf8");
    expect(() => loadCliConfig({ workspace: root }, { env: {}, homeDir: path.join(root, "home") }))
      .toThrow(/home-only/u);
  });

  it("requires both a home opt-in and an explicit disposable-container run selection", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-config-disposable-"));
    const home = path.join(root, "home");
    await mkdir(path.join(home, ".sigma"), { recursive: true });
    await writeFile(path.join(home, ".sigma", "config.toml"), [
      "[security]", "allow_unsafe_host_exec = true"
    ].join("\n"), "utf8");

    expect(loadCliConfig({ "execution-mode": "disposable-container" }, {
      env: {}, cwd: root, homeDir: home
    })).toMatchObject({
      executionMode: "disposable-container",
      unsafeHostExecRequested: true,
      allowUnsafeHostExec: true
    });
    expect(loadCliConfig({ "unsafe-host-exec": true }, {
      env: {}, cwd: root, homeDir: home
    }).executionMode).toBe("disposable-container");
    expect(() => loadCliConfig({ "execution-mode": "disposable-container" }, {
      env: {}, cwd: root, homeDir: path.join(root, "missing-home")
    })).toThrow(/home.*opt-in|allow_unsafe_host_exec/u);
  });

  it("checks and atomically writes a V2 migration with a backup", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-config-migrate-"));
    await mkdir(path.join(root, ".agent"));
    const configPath = path.join(root, ".agent", "config.toml");
    const original = "[model]\nprovider = \"glm\"\nname = \"auto\"\n\n[workspace]\npath = \".\"\n";
    await writeFile(configPath, original, "utf8");
    const checkOut = new Capture();
    expect(await runConfigCommand(["migrate", "--workspace", root, "--check"], {
      stdout: checkOut as unknown as NodeJS.WritableStream,
      env: {}, homeDir: path.join(root, "home")
    })).toBe(2);
    expect(checkOut.value).toContain("requires migration");

    expect(await runConfigCommand(["migrate", "--workspace", root, "--write"], {
      stdout: new Capture() as unknown as NodeJS.WritableStream,
      env: {}, homeDir: path.join(root, "home")
    })).toBe(0);
    await expect(readFile(`${configPath}.v2.bak`, "utf8")).resolves.toBe(original);
    expect(await readFile(configPath, "utf8")).toContain("schema_version = 4");
    expect(loadCliConfig({ workspace: root }, { env: {}, homeDir: path.join(root, "home") }).provider).toBe("glm");
  });

  it("migrates schema v3 to v4 and labels the backup with its source version", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-config-v3-migrate-"));
    await mkdir(path.join(root, ".agent"));
    const configPath = path.join(root, ".agent", "config.toml");
    const original = [
      "schema_version = 3", "[workspace]", "path = \".\"", "[security]",
      "sandbox = \"required\"", "network = \"none\""
    ].join("\n");
    await writeFile(configPath, original, "utf8");

    expect(await runConfigCommand(["migrate", "--workspace", root, "--write"], {
      stdout: new Capture() as unknown as NodeJS.WritableStream,
      env: {}, homeDir: path.join(root, "home")
    })).toBe(0);
    await expect(readFile(`${configPath}.v3.bak`, "utf8")).resolves.toBe(original);
    const migrated = await readFile(configPath, "utf8");
    expect(migrated).toContain("schema_version = 4");
    expect(migrated).toContain('read_scope = "host"');
    expect(migrated).toContain('network = "none"');
    expect(migrated).toContain('process_handoff = "allow"');
  });
});
