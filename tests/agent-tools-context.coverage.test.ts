import { mkdtemp, writeFile, mkdir, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { JsonValue, SupervisorPort, ToolExecutionContext, ToolRequest } from "../packages/agent-protocol/src/index.js";
import {
  approximateTokens,
  lexicalScore,
  lexicalTokens,
  loadNestedInstructions,
  planContext,
  RepositoryContextProvider,
  VersionedContextCache
} from "../packages/agent-context/src/index.js";
import { runProcess, runtimeEnvironment, shellInvocation } from "../packages/agent-platform/src/index.js";
import {
  completionEvidenceError,
  EffectToolRegistry,
  isToolAllowed,
  parseCompletionProposal,
  registerBuiltinTools,
  registerSupervisorTools,
  ResourceLockManager
} from "../packages/agent-tools/src/index.js";

function context(workspacePath: string, signal = new AbortController().signal): ToolExecutionContext {
  return {
    sessionId: "session",
    runId: "run",
    workspacePath,
    runMode: "change",
    signal,
    progress: async () => undefined,
    createArtifact: async ({ name }) => name
  };
}

function request(callId: string, name: string, args: JsonValue): ToolRequest {
  return { callId, name, arguments: args };
}

describe("context, platform, and repository tool capabilities", () => {
  it("requires every completion criterion to have current successful evidence", () => {
    expect(parseCompletionProposal({
      summary: "bypass",
      criteria: [{
        criterion: "The requested change is complete.",
        status: "not_applicable",
        evidenceCallIds: [],
        rationale: "claimed unnecessary"
      }]
    })).toBeNull();
    const proposal = parseCompletionProposal({
      summary: "verified",
      criteria: [{
        criterion: "The requested change is complete.",
        status: "met",
        evidenceCallIds: ["current-receipt"]
      }]
    });
    expect(proposal).toMatchObject({ criteria: [{ rationale: "" }] });
    expect(completionEvidenceError(proposal!, new Set(["current-receipt"]))).toBeNull();
    expect(completionEvidenceError(proposal!, new Set(["older-run-receipt"])))
      .toContain("current-receipt");
  });

  it("loads nested instructions and retrieves Unicode repository context incrementally", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-context-"));
    await mkdir(path.join(workspace, "src", "nested"), { recursive: true });
    await writeFile(path.join(workspace, "AGENTS.md"), "root rule", "utf8");
    await writeFile(path.join(workspace, "src", "AGENTS.md"), "source rule", "utf8");
    await writeFile(path.join(workspace, "src", "nested", "agent.ts"), "// 修复核心代理阻塞\nexport const agent = true;\n", "utf8");
    const instructions = await loadNestedInstructions({ workspacePath: workspace, targetPath: "src/nested/agent.ts" });
    expect(instructions.map((item) => item.content)).toEqual(["root rule", "source rule"]);

    const signal = new AbortController().signal;
    const git = async (args: string[]) => await runProcess({ executable: "git", args, cwd: workspace, timeoutMs: 10_000, signal });
    await git(["init", "-q"]);
    await git(["config", "user.email", "sigma@example.invalid"]);
    await git(["config", "user.name", "Sigma"]);
    await git(["add", "."]);
    await git(["commit", "-qm", "initial"]);
    await writeFile(path.join(workspace, "src", "nested", "agent.ts"), "// 修复核心代理阻塞\nexport const agent = false;\n", "utf8");

    const provider = new RepositoryContextProvider();
    const first = await provider.collect(workspace, "核心代理阻塞", signal);
    const second = await provider.collect(workspace, "核心代理阻塞", signal);
    expect(first.find((item) => item.provenance === "incremental repository index")?.content).toContain("src/nested/agent.ts");
    expect(first.find((item) => item.provenance === "current Git diff")?.content).toContain("agent = false");
    expect(second.map((item) => item.id)).toEqual(first.map((item) => item.id));

    const nongit = await mkdtemp(path.join(os.tmpdir(), "sigma-context-nongit-"));
    await writeFile(path.join(nongit, "说明.txt"), "中文检索", "utf8");
    expect((await provider.collect(nongit, "中文", signal))[0].content).toContain("说明.txt");
  });

  it("budgets atomic turns, tool arguments, and explicit overflow", () => {
    expect(lexicalTokens("核心 agent")).toContain("核心");
    expect(lexicalScore("核心", "核心代理")).toBeGreaterThan(0);
    expect(approximateTokens("你好 hello")).toBeGreaterThan(1);
    const planned = planContext({
      system: [{ id: "system", authority: "system", provenance: "test", content: "system", tokenCount: 2, priority: 10 }],
      dynamic: [{ id: "dynamic", authority: "tool", provenance: "repo", content: "context", tokenCount: 2, priority: 1 }],
      history: [
        { role: "user", content: "old" }, { role: "assistant", content: "answer" },
        { role: "user", content: "new", toolCalls: [{ id: "x", name: "read", arguments: { path: "large" } }] }
      ],
      tools: [{ name: "read", description: "read", inputSchema: { type: "object" } }],
      contextWindowTokens: 200,
      outputReserveTokens: 20
    });
    expect(planned.messages.at(-1)?.content).toBe("new");
    expect(planned.budget.toolTokens).toBeGreaterThan(0);
    const withoutReasoning = planContext({
      system: [], dynamic: [],
      history: [{ role: "user", content: "question" }, { role: "assistant", content: "answer" }],
      tools: [], contextWindowTokens: 1_000, outputReserveTokens: 0
    });
    const withReasoning = planContext({
      system: [], dynamic: [],
      history: [
        { role: "user", content: "question" },
        { role: "assistant", content: "answer", reasoningContent: "reasoning ".repeat(20) }
      ],
      tools: [], contextWindowTokens: 1_000, outputReserveTokens: 0
    });
    expect(withReasoning.budget.historyTokens).toBeGreaterThan(withoutReasoning.budget.historyTokens);
    expect(() => planContext({
      system: [], dynamic: [], history: [{ role: "user", content: "x".repeat(1_000) }], tools: [],
      contextWindowTokens: 10, outputReserveTokens: 0
    })).toThrow("newest user turn");

    const authorities = planContext({
      system: [
        { id: "system", authority: "system", provenance: "contract", content: "contract", tokenCount: 2, priority: 10 },
        { id: "project", authority: "project", provenance: "AGENTS.md", content: "instructions", tokenCount: 2, priority: 9 }
      ],
      dynamic: [{ id: "diff", authority: "tool", provenance: "repository diff", content: "untrusted", tokenCount: 2, priority: 8 }],
      history: [{ role: "user", content: "request" }], tools: [], contextWindowTokens: 100, outputReserveTokens: 0
    });
    expect(authorities.messages.map((message) => message.role)).toEqual(["system", "developer", "user", "user"]);
    const compacted = planContext({
      system: [], dynamic: [],
      history: Array.from({ length: 12 }, (_, index) => ({
        role: index % 2 === 0 ? "user" as const : "assistant" as const,
        content: `${index}: ${"history ".repeat(20)}`
      })),
      tools: [], contextWindowTokens: 160, outputReserveTokens: 20
    });
    expect(compacted.omittedHistoryTurns).toBeGreaterThan(0);
    expect(compacted.summary).toMatchObject({ authority: "tool", provenance: "lossy conversation compaction" });
    expect(() => planContext({
      system: [{ id: "required", authority: "system", provenance: "required", content: "required", tokenCount: 90, priority: 1 }],
      dynamic: [], history: [{ role: "user", content: "request" }], tools: [], contextWindowTokens: 95, outputReserveTokens: 0
    })).toThrow("Mandatory context and the newest user turn");

    const cache = new VersionedContextCache<number>();
    cache.set("repo", "one", 1);
    expect(cache.get("repo", "one")).toBe(1);
    expect(cache.get("repo", "two")).toBeUndefined();
    cache.invalidate("repo");
    expect(cache.get("repo", "one")).toBeUndefined();
    cache.set("a", "v", 1); cache.set("b", "v", 2); cache.invalidate();
    expect(cache.get("b", "v")).toBeUndefined();
  });

  it("executes repository discovery, validation, and Git evidence tools", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-tools-"));
    await mkdir(path.join(workspace, "src"), { recursive: true });
    await writeFile(path.join(workspace, "src", "one.txt"), "alpha\nbeta\n", "utf8");
    await writeFile(path.join(workspace, "src", "two.md"), "alpha\n", "utf8");
    await writeFile(path.join(workspace, "src", "options.txt"), "--pre=do-not-execute\n", "utf8");
    const signal = new AbortController().signal;
    await runProcess({ executable: "git", args: ["init", "-q"], cwd: workspace, timeoutMs: 10_000, signal });
    const tools = registerBuiltinTools(new EffectToolRegistry());
    expect(tools.descriptors().map((item) => item.name)).toEqual(expect.arrayContaining(["complete_task", "request_user_input"]));
    const supervisor: SupervisorPort = {
      spawnDurable: async () => ({ id: "child" }), followUp: () => undefined,
      join: async () => null, list: () => [], integrate: async () => null
    };
    const supervisorTools = registerSupervisorTools(new EffectToolRegistry(), supervisor);
    expect(supervisorTools.descriptor("integrate_agent")).toMatchObject({
      executionMode: "exclusive",
      resourceKeys: ["workspace:write"],
      possibleEffects: expect.arrayContaining(["filesystem.write"])
    });
    const listed = await tools.execute(request("list", "list", { path: "src", glob: "**/*.txt" }), context(workspace));
    expect(listed.output).toContain("src/one.txt");
    const found = await tools.execute(request("grep", "grep", { query: "alpha", path: "src", limit: 20 }), context(workspace));
    expect(found.output).toContain("one.txt");
    await writeFile(path.join(workspace, "src", "dense-a.txt"), "alpha\n".repeat(10), "utf8");
    await writeFile(path.join(workspace, "src", "dense-b.txt"), "alpha\n".repeat(10), "utf8");
    const limited = await tools.execute(request("grep-limited", "grep", {
      query: "alpha", path: "src", limit: 7
    }), context(workspace));
    expect(limited.output.split(/\r?\n/u)).toHaveLength(7);
    expect(limited.diagnostics).toContain("result_limit=7");
    const optionText = await tools.execute(request("grep-option", "grep", { query: "--pre=do-not-execute", path: "src" }), context(workspace));
    expect(optionText.output).toContain("options.txt");
    await expect(tools.execute(request("grep-escape", "grep", { query: "secret", path: ".." }), context(workspace))).rejects.toThrow(/escapes workspace/);
    const status = await tools.execute(request("status", "git_status", {}), context(workspace));
    expect(status.ok).toBe(true);
    const diff = await tools.execute(request("diff", "git_diff", {}), context(workspace));
    expect(diff.ok).toBe(true);
    const validation = await tools.execute(request("validate", "validate", {
      executable: process.execPath, args: ["-e", "process.stdout.write('validated')"], timeoutMs: 5_000
    }), context(workspace));
    expect(validation).toMatchObject({ ok: true, observedEffects: ["process.spawn", "validation"] });
    expect(validation.output).toBe("validated");
    await expect(tools.execute(request("missing", "missing", {}), context(workspace))).rejects.toThrow("Unknown tool");
    expect(isToolAllowed(tools.descriptor("write")!, "analyze")).toBe(false);
    expect(isToolAllowed(tools.descriptor("validate")!, "analyze")).toBe(false);
    expect(isToolAllowed(tools.descriptor("read")!, "analyze")).toBe(true);
    expect(isToolAllowed({ ...tools.descriptor("read")!, approval: "deny" }, "change")).toBe(false);
  });

  it("rejects nested instruction links that escape the workspace", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-instructions-"));
    const external = await mkdtemp(path.join(os.tmpdir(), "sigma-instructions-external-"));
    await writeFile(path.join(external, "AGENTS.md"), "outside instructions", "utf8");
    await writeFile(path.join(external, "file.ts"), "export {};", "utf8");
    try {
      await symlink(external, path.join(workspace, "linked"), process.platform === "win32" ? "junction" : "dir");
    } catch {
      return;
    }
    await expect(loadNestedInstructions({ workspacePath: workspace, targetPath: "linked/file.ts" })).rejects.toThrow(/outside workspace through a link/);
  });

  it("cancels process trees, reports timeouts, shells, and resource lock ordering", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-process-"));
    const controller = new AbortController();
    const cancelled = runProcess({
      executable: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"], cwd: workspace,
      timeoutMs: 5_000, signal: controller.signal
    });
    setTimeout(() => controller.abort(new Error("stop")), 20);
    await expect(cancelled).resolves.toMatchObject({ cancelled: true });
    await expect(runProcess({
      executable: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"], cwd: workspace,
      timeoutMs: 20, signal: new AbortController().signal
    })).resolves.toMatchObject({ timedOut: true });
    await expect(runProcess({
      executable: "definitely-missing-sigma-command", args: [], cwd: workspace, timeoutMs: 100,
      signal: new AbortController().signal
    })).rejects.toThrow();
    expect(shellInvocation("powershell", "Get-Date").executable).toContain("powershell");
    expect(shellInvocation("cmd", "echo ok").args).toContain("/c");
    expect(shellInvocation("bash", "true")).toEqual({ executable: "bash", args: ["-lc", "true"] });
    expect(runtimeEnvironment().defaultShell).toBe(process.platform === "win32" ? "powershell" : "bash");

    const locks = new ResourceLockManager();
    const order: string[] = [];
    await Promise.all([
      locks.withLocks(["b", "a"], async () => { order.push("first"); await new Promise((resolve) => setTimeout(resolve, 20)); }),
      locks.withLocks(["a"], async () => { order.push("second"); })
    ]);
    expect(order).toEqual(["first", "second"]);
  });
});
