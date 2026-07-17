import { describe, expect, it } from "vitest";
import { CommandRegistry, SIGMA_COMMANDS } from "../packages/agent-config/src/commands.js";
import {
  configHelp,
  parseFlags,
  resolveConfig,
  SIGMA_CONFIG_SCHEMA,
  type McpServerConfigValue
} from "../packages/agent-config/src/schema.js";
import { renderConfigToml } from "../packages/agent-config/src/toml.js";

describe("agent-config single-source schema", () => {
  it("parses long, short, inline, repeated, and positional arguments strictly", () => {
    const parsed = parseFlags([
      "--provider=glm", "--workspace", ".", "-h", "--mcp-server", "{\"name\":\"one\",\"command\":\"node\"}",
      "--mcp-server={\"name\":\"two\",\"command\":\"python\"}", "--", "--literal", "request"
    ]);
    expect(parsed.flags).toMatchObject({ provider: "glm", workspace: ".", help: true });
    expect(parsed.flags["mcp-server"]).toHaveLength(2);
    expect(parsed.positionals).toEqual(["--literal", "request"]);
    expect(parseFlags(["--stdin=false"]).flags.stdin).toBe(false);
    expect(() => parseFlags(["--unknown"])).toThrow("Unknown option");
    expect(() => parseFlags(["--provider"])).toThrow("requires a value");
    expect(() => parseFlags(["--provider", "--stdin"])).toThrow("requires a value");
  });

  it("applies source precedence and rejects unknown TOML keys", () => {
    const values = resolveConfig({
      flags: { provider: "glm" },
      env: { SIGMA_MODEL: "env-model", SIGMA_RUN_DEADLINE_SEC: "42" },
      workspace: { model: { provider: "deepseek", name: "workspace-model" }, tools: { max_parallel: 7 } },
      home: { model: { provider: "deepseek", name: "home-model" }, permissions: { mode: "deny" } }
    });
    expect(values).toMatchObject({ provider: "glm", model: "env-model", runDeadlineSec: 42, maxParallelTools: 4, permissionMode: "deny" });
    expect(() => resolveConfig({ workspace: { model: { unknown: true } } })).toThrow("Unknown workspace configuration key");
    expect(() => resolveConfig({ home: { surprise: {} } })).toThrow("Unknown home configuration key");
    expect(() => resolveConfig({ flags: { surprise: true } })).toThrow("Unknown option");
  });

  it("only lets workspace configuration narrow authority and resource caps", () => {
    const values = resolveConfig({
      home: {
        permissions: { mode: "deny" },
        security: { read_scope: "workspace", network: "none", process_handoff: "deny", allow_unsafe_host_exec: true },
        budget: { max_input_tokens: 1_000, max_tool_calls: 20 }, checkpoint: { max_files: 100 }
      },
      workspace: {
        permissions: { mode: "auto" },
        security: { read_scope: "host", network: "full", process_handoff: "allow", allow_unsafe_host_exec: false },
        budget: { max_input_tokens: 2_000, max_tool_calls: 10 }, checkpoint: { max_files: 200 },
        agents: { max_parallel: 2 }
      }
    });
    expect(values).toMatchObject({
      permissionMode: "deny", readScope: "workspace", networkMode: "none", processHandoff: "deny",
      allowUnsafeHostExec: false,
      maxInputTokens: 1_000, maxToolCalls: 10, checkpointMaxFiles: 100, maxParallelAgents: 2
    });

    const narrowed = resolveConfig({
      home: {
        permissions: { mode: "auto" },
        security: { read_scope: "host", network: "full", process_handoff: "allow" },
        budget: { max_input_tokens: 2_000 }
      },
      workspace: {
        permissions: { mode: "ask" },
        security: { read_scope: "workspace", network: "none", process_handoff: "deny" },
        budget: { max_input_tokens: 1_000 }
      }
    });
    expect(narrowed).toMatchObject({
      permissionMode: "ask", readScope: "workspace", networkMode: "none", processHandoff: "deny",
      maxInputTokens: 1_000
    });

    const explicit = resolveConfig({
      flags: { "permission-mode": "auto", "max-input-tokens": 3_000 },
      env: { SIGMA_NETWORK: "full" },
      workspace: { permissions: { mode: "deny" }, security: { network: "none" }, budget: { max_input_tokens: 1_000 } }
    });
    expect(explicit).toMatchObject({ permissionMode: "auto", networkMode: "full", maxInputTokens: 3_000 });

    expect(resolveConfig({ workspace: { runtime: { stream_active_sec: 60 } } }).streamActiveSec).toBe(60);
    expect(resolveConfig({
      home: { runtime: { stream_active_sec: 30 } },
      workspace: { runtime: { stream_active_sec: 0 } }
    }).streamActiveSec).toBe(30);
  });

  it("validates every scalar boundary", () => {
    const field = (key: string) => SIGMA_CONFIG_SCHEMA.find((item) => item.key === key)!;
    expect(() => field("permissionMode").parse("yolo")).toThrow("must be one of");
    expect(() => field("provider").parse("other")).toThrow("must be one of");
    expect(() => field("workspace").parse(1)).toThrow("string");
    expect(() => field("workspace").parse(" ")).toThrow("non-empty");
    expect(() => field("runDeadlineSec").parse("nan")).toThrow("number");
    expect(field("streamActiveSec").parse(0)).toBe(0);
    expect(() => field("streamActiveSec").parse(-1)).toThrow("number");
    expect(field("streamJsonMaxLineBytes").parse(49_152)).toBe(49_152);
    expect(() => field("streamJsonMaxLineBytes").parse(4_095)).toThrow("integer");
    expect(() => field("streamJsonMaxLineBytes").parse(4_096.5)).toThrow("integer");
    expect(() => field("maxParallelTools").parse(0)).toThrow("number");
    expect(() => field("maxParallelTools").parse(33)).toThrow("number");
    expect(() => field("stdin").parse("maybe")).toThrow("true or false");
    expect(field("stdin").parse("1")).toBe(true);
    expect(field("stdin").parse("0")).toBe(false);
    expect(field("prompt").parse("")).toBe("");
  });

  it("normalizes MCP servers from TOML, env JSON, and repeatable flags", () => {
    const raw = {
      name: "workspace",
      command: "node",
      args: ["server.mjs"],
      cwd: "tools",
      env: { TOKEN: "value" },
      possible_effects: ["filesystem.read", "network"],
      approval: "auto",
      execution_mode: "parallel",
      idempotent: true,
      timeout_ms: 100,
      idle_timeout_ms: 20,
      hard_deadline_ms: 80,
      shutdown_grace_ms: 10
    };
    const fromToml = resolveConfig({ workspace: { mcp: { servers: [raw] } } }).mcpServers as McpServerConfigValue[];
    expect(fromToml[0]).toMatchObject({ name: "workspace", args: ["server.mjs"], approval: "auto", timeoutMs: 100 });
    const fromEnv = resolveConfig({ env: { SIGMA_MCP_SERVERS: JSON.stringify([raw]) } }).mcpServers as McpServerConfigValue[];
    expect(fromEnv[0].env).toEqual({ TOKEN: "value" });
    const repeated = resolveConfig({ flags: { "mcp-server": [JSON.stringify(raw)] } }).mcpServers as McpServerConfigValue[];
    expect(repeated[0].possibleEffects).toEqual(["filesystem.read", "network"]);

    const parseMcp = SIGMA_CONFIG_SCHEMA.find((item) => item.key === "mcpServers")!.parse;
    expect(() => parseMcp({})).toThrow("array");
    expect(() => parseMcp([raw, raw])).toThrow("Duplicate MCP server");
    expect(() => parseMcp([{ ...raw, name: "" }])).toThrow("non-empty");
    expect(() => parseMcp([{ ...raw, args: [1] }])).toThrow("string array");
    expect(() => parseMcp([{ ...raw, mystery: true }])).toThrow("Unknown MCP server configuration key");
    expect(() => resolveConfig({ flags: { "tui-fps": "31" } })).toThrow("1 to 30");
    expect(() => parseMcp([{ ...raw, env: "bad" }])).toThrow("object");
    expect(() => parseMcp([{ ...raw, possible_effects: ["unknown"] }])).toThrow("must be one of");
    expect(() => parseMcp([{ name: "implicit", command: "node" }])).toThrowError(expect.objectContaining({
      code: "mcp_effects_required"
    }));
    for (const effect of ["filesystem.write", "destructive", "open_world"]) {
      expect(() => parseMcp([{ ...raw, possible_effects: [effect] }])).toThrowError(expect.objectContaining({
        code: "mcp_persistent_effect_forbidden",
        forbiddenEffects: [effect]
      }));
    }
    expect(() => parseMcp([{ ...raw, timeout_ms: 0 }])).toThrow("number");
  });

  it("parses strict model specs and route catalogs from configuration", () => {
    const rawSpec = {
      id: "deepseek/custom",
      provider: "deepseek",
      upstream_model: "custom",
      capabilities: {
        context_window_tokens: 100_000, max_output_tokens: 10_000, tools: true,
        parallel_tools: false, reasoning: true, structured_output: true,
        prompt_cache: false, tokenizer: "approximate"
      },
      tokenizer: { id: "custom-tokenizer", accuracy: "exact", asset_digest: "a".repeat(64) },
      pricing: {
        input_micro_usd_per_million: 10, output_micro_usd_per_million: 20,
        cache_read_micro_usd_per_million: 1, effective_at: "2026-01-01"
      }
    };
    const rawRoute = {
      id: "analysis", candidates: ["deepseek/custom"],
      required_capabilities: { tools: true, context_window_tokens: 50_000 },
      require_exact_tokenizer: true, fallback_on: ["timeout"], max_attempts: 1
    };
    const values = resolveConfig({ workspace: { model: { specs: [rawSpec], routes: [rawRoute] } } });
    expect(values.modelSpecs).toEqual([expect.objectContaining({
      id: "deepseek/custom", providerId: "deepseek",
      tokenizer: expect.objectContaining({ accuracy: "exact" })
    })]);
    expect(values.modelRoutes).toEqual([expect.objectContaining({
      id: "analysis", requireExactTokenizer: true,
      requiredCapabilities: expect.objectContaining({ tools: true, contextWindowTokens: 50_000 })
    })]);
    const specParser = SIGMA_CONFIG_SCHEMA.find((item) => item.key === "modelSpecs")!.parse;
    const routeParser = SIGMA_CONFIG_SCHEMA.find((item) => item.key === "modelRoutes")!.parse;
    expect(() => specParser([{ ...rawSpec, surprise: true }])).toThrow("Unknown configuration key");
    expect(() => routeParser([{ ...rawRoute, fallback_on: ["auth"] }])).toThrow("must be one of");
    expect(() => routeParser([{ ...rawRoute, candidates: ["same", "same"] }])).toThrow("duplicates");
  });

  it("renders help, commands, and TOML from the same declarations", () => {
    const help = configHelp();
    expect(help.some((line) => line.includes("--provider"))).toBe(true);
    expect(help.some((line) => line.includes("--trust-workspace-mcp"))).toBe(true);
    expect(help.some((line) => line.includes("--prompt"))).toBe(false);
    const registry = new CommandRegistry();
    expect(registry.resolve("inspect")).toMatchObject({ handler: "run", mode: "analyze" });
    expect(registry.definitions()).toHaveLength(SIGMA_COMMANDS.length);
    expect(() => new CommandRegistry([
      { name: "one", aliases: ["same"], summary: "one", handler: "doctor" },
      { name: "same", summary: "two", handler: "doctor" }
    ])).toThrow("Duplicate command");

    const server = resolveConfig({ flags: { "mcp-server": [
      "{\"name\":\"tooling\",\"command\":\"node\",\"possible_effects\":[\"filesystem.read\"]}"
    ] } }).mcpServers as McpServerConfigValue[];
    const toml = renderConfigToml({ provider: "glm", workspace: ".", mcpServers: server }, "generated");
    expect(toml).toContain("# generated");
    expect(toml).toContain("[model]\nprovider = \"glm\"");
    expect(toml).toContain("[[mcp.servers]]");
    expect(toml).toContain("possible_effects = [\"filesystem.read\"]");
  });
});
