import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runHarnessCommand } from "../packages/agent-cli/src/commands/harness.js";
import { compileHarnessBuild } from "../packages/agent-runtime/src/harness-compiler.js";

describe("sigma harness inspect", () => {
  it("prints the frozen compiler, tool, context, and constraint projection", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-harness-inspect-"));
    const build = compileHarnessBuild({
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      reasoningEffort: "max",
      modelRole: "orchestrator",
      runMode: "change",
      modelCapabilities: {
        contextWindowTokens: 200_000,
        maxOutputTokens: 32_000,
        tools: true,
        parallelTools: true,
        reasoning: true,
        structuredOutput: false,
        promptCache: true,
        tokenizer: "exact"
      },
      runtimeCapabilities: {
        tools: ["read", "list", "grep", "shell", "apply_patch", "write"]
          .map((name) => ({ name, source: "builtin" as const })),
        executionMode: "sandboxed",
        writeScope: "workspace",
        managedEnvironment: false,
        network: "full",
        interactiveApprovals: false
      }
    });
    let output = "";
    let closed = false;
    const code = await runHarnessCommand([
      "inspect", "--json", "--workspace", workspace,
      "--provider", "openai-codex", "--model", "gpt-5.6-sol",
      "--reasoning-effort", "max"
    ], {
      stdout: ({
        write(value: string | Uint8Array) { output += String(value); return true; }
      }) as NodeJS.WritableStream,
      createConfiguredRuntime: async () => ({
        runtime: {} as never,
        workspace,
        storeRootDir: path.join(workspace, ".state"),
        execution: {} as never,
        inspectHarness: () => build,
        inspectHarnessTokens: async () => ({
          tokenizer: "exact",
          countMethod: "gateway.countTokens",
          mandatoryPromptTokens: 120,
          initialToolSchemaTokens: 180,
          combinedTokens: 300,
          mandatoryPromptBytes: 480,
          initialToolSchemaBytes: 720
        }),
        close: async () => { closed = true; }
      })
    });
    expect(code).toBe(0);
    expect(closed).toBe(true);
    expect(JSON.parse(output)).toMatchObject({
      compilerVersion: "1.0.0",
      digest: build.digest,
      subject: { model: "gpt-5.6-sol", reasoningEffort: "max" },
      tools: { initial: expect.arrayContaining(["read", "load_tool_bundle"]) },
      context: { historyTokenLimit: 70_000 },
      tokens: { tokenizer: "exact", combinedTokens: 300 },
      constraintSources: expect.arrayContaining([
        expect.objectContaining({ source: "flagship_policy" })
      ])
    });
  });
});
