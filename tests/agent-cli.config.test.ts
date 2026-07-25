import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadCliConfig } from "../packages/agent-cli/src/config.js";

async function fileDigest(filePath: string): Promise<string> {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

describe("Sigma config", () => {
  it("defaults to workspace-auto, required sandbox, workspace reads, full network, and hard shared budgets", () => {
    const config = loadCliConfig({}, { env: {}, cwd: process.cwd(), homeDir: path.join(process.cwd(), ".missing-home") });
    expect(config).toMatchObject({
      sandboxMode: "required",
      executionMode: "sandboxed",
      managedEnvironmentMode: "disabled",
      permissionMode: "workspace-auto",
      readScope: "workspace",
      networkMode: "full",
      processHandoff: "allow",
      explicitSingleModelRoute: false,
      budget: { maxInputTokens: 8_000_000, maxOutputTokens: 1_000_000, maxCostMicroUsd: 50_000_000 }
    });
  });

  it("maps explicit provider/model flags to a single-candidate route", () => {
    const options = { env: {}, cwd: process.cwd(), homeDir: path.join(process.cwd(), ".missing-home") };
    expect(loadCliConfig({ provider: "glm" }, options).explicitSingleModelRoute).toBe(true);
    expect(loadCliConfig({ model: "glm-5.2" }, options).explicitSingleModelRoute).toBe(true);
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

  it("rejects the removed unsafe host execution setting", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-config-unsafe-"));
    await mkdir(path.join(root, ".agent"));
    await writeFile(path.join(root, ".agent", "config.toml"), [
      "schema_version = 1", "[workspace]", "path = \".\"", "[security]", "sandbox = \"required\"",
      "network = \"none\"", "allow_unsafe_host_exec = true"
    ].join("\n"), "utf8");
    expect(() => loadCliConfig({ workspace: root }, { env: {}, homeDir: path.join(root, "home") }))
      .toThrow(/Unknown workspace configuration key/u);
  });

  it("rejects an unknown config schema without rewriting the file", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-config-schema-"));
    const configPath = path.join(root, ".agent", "config.toml");
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, [
      "schema_version = 999",
      "[workspace]",
      "path = \".\""
    ].join("\n"), "utf8");
    const before = await fileDigest(configPath);
    expect(() => loadCliConfig({ workspace: root }, { env: {}, homeDir: path.join(root, "home") }))
      .toThrow(/unsupported_schema_version.*expected 1.*received 999/u);
    expect(await fileDigest(configPath)).toBe(before);
  });

  it("accepts only real container mode and rejects removed host aliases", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-config-container-"));
    expect(loadCliConfig({ "execution-mode": "container" }, {
      env: {}, cwd: root, homeDir: path.join(root, "missing-home")
    }).executionMode).toBe("container");
    expect(() => loadCliConfig({ "execution-mode": "disposable-container" }, {
      env: {}, cwd: root, homeDir: path.join(root, "missing-home")
    })).toThrow(/sandboxed, container/u);
    expect(() => loadCliConfig({ "unsafe-host-exec": true }, {
      env: {}, cwd: root, homeDir: path.join(root, "missing-home")
    })).toThrow(/Unknown option/u);
  });

  it("can require but cannot synthesize a managed environment capability", () => {
    const root = path.join(process.cwd(), ".managed-environment-fixture");
    const config = loadCliConfig({
      "execution-mode": "container",
      "managed-environment-mode": "required"
    }, { env: {}, cwd: root, homeDir: path.join(root, "missing-home") });
    expect(config).toMatchObject({
      executionMode: "container",
      managedEnvironmentMode: "required"
    });
    expect(() => loadCliConfig({ "managed-environment-mode": "opportunistic" }, {
      env: {}, cwd: root, homeDir: path.join(root, "missing-home")
    })).toThrow(/disabled, required/u);
  });

});
