import { link, mkdtemp, writeFile, mkdir, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type {
  JsonValue,
  RuntimeControlPort,
  SupervisorPort,
  ToolExecutionContext,
  ToolRequest
} from "../packages/agent-protocol/src/index.js";
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
  EffectToolRegistry,
  isToolAllowed,
  parseCompletionProposal,
  registerBuiltinTools,
  registerCompletionTool,
  registerSupervisorTools,
  ResourceLockManager,
  terminalProtocolAction
} from "../packages/agent-tools/src/index.js";
import {
  repositoryListJsonLines,
  repositoryStatisticsJson,
  repositoryTextSearchJsonLines
} from "../packages/agent-runtime/src/repository-statistics-provider.js";
import { createHostExecutionBroker } from "./helpers/host-execution-broker.js";

const execution = createHostExecutionBroker();

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
  it("accepts only the V5 runtime-owned completion shape", () => {
    expect(parseCompletionProposal({
      summary: "bypass",
      criteria: [{
        criterion: "The requested change is complete.",
        status: "not_applicable",
        evidence: [],
        rationale: "claimed unnecessary"
      }]
    })).toBeNull();
    expect(parseCompletionProposal({ summary: " verified ", warnings: ["review unavailable"] }))
      .toEqual({ summary: "verified", warnings: ["review unavailable"] });
    expect(parseCompletionProposal({ summary: "verified", unknown: true })).toBeNull();
  });

  it("exposes an ID-free internal review request without asking the user to re-authorize code", async () => {
    const tools = registerBuiltinTools(new EffectToolRegistry(), { execution });
    const review = tools.descriptor("request_review")!;
    expect(review.inputSchema).toMatchObject({
      type: "object",
      properties: {},
      required: []
    });
    expect(review.description).toContain("internal review");
    expect(review.description).toContain("Supply no evidence IDs");
    const runtimeControl = {
      requestReview: async () => ({
        status: "review_requested" as const,
        frontierRevision: 3,
        stateDigest: "a".repeat(64),
        changedPaths: ["src/index.ts"],
        missingValidationPaths: []
      })
    } as RuntimeControlPort;
    const result = await tools.execute(
      request("review", "request_review", {}),
      { ...context("."), runtimeControl }
    );
    expect(result).toMatchObject({
      ok: true,
      result: {
        status: "review_requested",
        frontierRevision: 3,
        changedPaths: ["src/index.ts"]
      },
      diagnostics: []
    });
  });

  it("keeps completion, blocked-report, and user-input terminal capabilities orthogonal", async () => {
    const tools = registerCompletionTool(new EffectToolRegistry());
    const completion = tools.descriptor("runtime_finalize")!;
    const input = tools.descriptor("request_user_input")!;
    const blocked = tools.descriptor("report_blocked")!;
    expect(completion.inputSchema).toMatchObject({
      properties: { summary: { type: "string" }, warnings: { type: "array" } },
      additionalProperties: false
    });
    expect(terminalProtocolAction(completion)).toBe("complete");
    expect(terminalProtocolAction(blocked)).toBe("report_blocked");
    expect(terminalProtocolAction(input)).toBe("request_input");
    expect(terminalProtocolAction({
      possibleEffects: ["outcome.propose", "outcome.request_input"]
    })).toBeNull();
    expect(terminalProtocolAction({
      possibleEffects: ["outcome.propose"],
      maximumEffects: ["outcome.propose", "filesystem.write"]
    })).toBeNull();

    const requested = await tools.execute(request(
      "ask",
      "request_user_input",
      { message: "Which target should I change?" }
    ), context("."));
    expect(requested).toMatchObject({
      ok: true,
      observedEffects: ["outcome.request_input"],
      diagnostics: []
    });
    const completed = await tools.execute(request(
      "complete",
      "runtime_finalize",
      { summary: "done", warnings: ["advisory review was unavailable"] }
    ), context("."));
    expect(completed).toMatchObject({
      ok: true,
      observedEffects: ["outcome.propose"],
      diagnostics: []
    });
    expect(JSON.parse(completed.output)).toEqual({
      summary: "done", warnings: ["advisory review was unavailable"]
    });
    expect(blocked.inputSchema).toMatchObject({ required: ["summary"] });
    const reported = await tools.execute(request(
      "blocked",
      "report_blocked",
      { summary: "The required executable is unavailable." }
    ), context("."));
    expect(reported).toMatchObject({
      ok: true,
      observedEffects: ["outcome.report_blocked"],
      diagnostics: []
    });
    expect(JSON.parse(reported.output)).toEqual({ summary: "The required executable is unavailable." });
  });

  it("loads instructions for an existing extensionless file from its parent directory", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "agent-instructions-extensionless-"));
    await mkdir(path.join(workspace, "src"), { recursive: true });
    await writeFile(path.join(workspace, "AGENTS.md"), "root rule", "utf8");
    await writeFile(path.join(workspace, "src", "AGENTS.md"), "source rule", "utf8");
    await writeFile(path.join(workspace, "src", "NOTICE"), "ordinary file", "utf8");

    const instructions = await loadNestedInstructions({ workspacePath: workspace, targetPath: "src/NOTICE" });

    expect(instructions.map((item) => item.provenance)).toEqual(["AGENTS.md", "src/AGENTS.md"]);
    await rm(workspace, { recursive: true, force: true });
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
    const git = async (args: string[]) => await runProcess({
      execution, executable: "git", args, cwd: workspace, timeoutMs: 10_000, signal
    });
    await git(["init", "-q"]);
    await git(["config", "user.email", "sigma@example.invalid"]);
    await git(["config", "user.name", "Sigma"]);
    await git(["add", "."]);
    await git(["commit", "-qm", "initial"]);
    await writeFile(path.join(workspace, "src", "nested", "agent.ts"), "// 修复核心代理阻塞\nexport const agent = false;\n", "utf8");

    const provider = new RepositoryContextProvider(execution);
    const first = await provider.collect(workspace, "核心代理阻塞", signal);
    const second = await provider.collect(workspace, "核心代理阻塞", signal);
    expect(first.find((item) => item.provenance === "incremental repository index")?.content).toContain("src/nested/agent.ts");
    expect(first.some((item) => item.provenance === "current Git diff")).toBe(false);
    expect(first.find((item) => item.provenance === "incremental repository index")?.content)
      .toContain("agent = false");
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
      outputReserveTokens: 20,
      promptCache: false
    });
    expect(planned.messages.at(-1)?.content).toBe("new");
    expect(planned.budget.toolTokens).toBeGreaterThan(0);
    const withoutReasoning = planContext({
      system: [], dynamic: [],
      history: [{ role: "user", content: "question" }, { role: "assistant", content: "answer" }],
      tools: [], contextWindowTokens: 1_000, outputReserveTokens: 0, promptCache: false
    });
    const withReasoning = planContext({
      system: [], dynamic: [],
      history: [
        { role: "user", content: "question" },
        { role: "assistant", content: "answer", reasoningContent: "reasoning ".repeat(20) }
      ],
      tools: [], contextWindowTokens: 1_000, outputReserveTokens: 0, promptCache: false
    });
    expect(withReasoning.budget.historyTokens).toBe(withoutReasoning.budget.historyTokens);
    expect(withReasoning.messages.at(-1)?.reasoningContent).toBeUndefined();
    const toolReasoning = planContext({
      system: [], dynamic: [],
      history: [
        { role: "user", content: "question" },
        {
          role: "assistant", content: "", reasoningContent: "required reasoning ".repeat(20),
          toolCalls: [{ id: "read-1", name: "read", arguments: { path: "file.txt" } }]
        },
        { role: "tool", content: "contents", toolCallId: "read-1" }
      ],
      tools: [], contextWindowTokens: 1_000, outputReserveTokens: 0, promptCache: true
    });
    const replayedCall = toolReasoning.messages.find((message) => message.toolCalls?.[0]?.id === "read-1");
    expect(replayedCall?.reasoningContent).toContain("required reasoning");
    expect(toolReasoning.budget.historyTokens).toBeGreaterThan(withoutReasoning.budget.historyTokens);
    expect(() => planContext({
      system: [], dynamic: [], history: [{ role: "user", content: "x".repeat(1_000) }], tools: [],
      contextWindowTokens: 10, outputReserveTokens: 0, promptCache: false
    })).toThrow("newest user turn");

    const authorities = planContext({
      system: [
        { id: "system", authority: "system", provenance: "contract", content: "contract", tokenCount: 2, priority: 10 },
        { id: "project", authority: "project", provenance: "AGENTS.md", content: "instructions", tokenCount: 2, priority: 9 }
      ],
      dynamic: [{ id: "diff", authority: "tool", provenance: "repository diff", content: "untrusted", tokenCount: 2, priority: 8 }],
      history: [{ role: "user", content: "request" }], tools: [], contextWindowTokens: 100, outputReserveTokens: 0,
      promptCache: false
    });
    expect(authorities.messages.map((message) => message.role)).toEqual(["system", "developer", "user", "user"]);
    const compacted = planContext({
      system: [], dynamic: [],
      history: Array.from({ length: 12 }, (_, index) => ({
        role: index % 2 === 0 ? "user" as const : "assistant" as const,
        content: `${index}: ${"history ".repeat(20)}`
      })),
      tools: [], contextWindowTokens: 160, outputReserveTokens: 20, promptCache: false
    });
    expect(compacted.omittedHistoryTurns).toBeGreaterThan(0);
    expect(compacted.summary).toMatchObject({ authority: "tool", provenance: "lossy conversation compaction" });
    expect(() => planContext({
      system: [{ id: "required", authority: "system", provenance: "required", content: "required", tokenCount: 90, priority: 1 }],
      dynamic: [], history: [{ role: "user", content: "request" }], tools: [],
      contextWindowTokens: 95, outputReserveTokens: 0, promptCache: false
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
    await writeFile(path.join(workspace, "src", "code.ts"), "const alpha = 1;\n\n// comment\n", "utf8");
    await writeFile(path.join(workspace, "src", "options.txt"), "--pre=do-not-execute\n", "utf8");
    await mkdir(path.join(workspace, "ignored"), { recursive: true });
    await mkdir(path.join(workspace, ".hidden"), { recursive: true });
    await writeFile(path.join(workspace, ".gitignore"), "ignored/\n", "utf8");
    await writeFile(path.join(workspace, "src", ".gitignore"), "drop.txt\n", "utf8");
    await writeFile(path.join(workspace, "root.txt"), "root\n", "utf8");
    await writeFile(path.join(workspace, "src", "drop.txt"), "drop\n", "utf8");
    await writeFile(path.join(workspace, "ignored", "ignored.txt"), "ignored\n", "utf8");
    await writeFile(path.join(workspace, ".hidden", "hidden.txt"), "hidden\n", "utf8");
    await writeFile(path.join(workspace, "credentials.json"), "secret\n", "utf8");
    const signal = new AbortController().signal;
    await runProcess({ execution, executable: "git", args: ["init", "-q"], cwd: workspace, timeoutMs: 10_000, signal });
    await mkdir(path.join(workspace, ".agent"), { recursive: true });
    const tools = registerBuiltinTools(new EffectToolRegistry(), {
      broker: execution,
      repositoryList: repositoryListJsonLines,
      repositoryStatistics: repositoryStatisticsJson,
      repositoryTextSearch: repositoryTextSearchJsonLines
    });
    expect(tools.descriptors().map((item) => item.name)).toEqual(expect.arrayContaining(["runtime_finalize", "request_user_input"]));
    expect(tools.modelDescriptors().map((item) => item.name)).not.toContain("runtime_finalize");
    expect(tools.descriptor("exec")).toMatchObject({ timeoutMs: 750_000 });
    expect(tools.descriptor("exec")?.idleTimeoutMs).toBeUndefined();
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
    expect(listed.output).not.toMatch(/drop|ignored|hidden|credentials/u);
    expect(listed.diagnostics).toContain("listing_complete=true");
    const rootListed = await tools.execute(
      request("list-root", "list", { path: ".", glob: "**/*.txt" }), context(workspace)
    );
    expect(rootListed.output).toContain("root.txt");
    const statistics = await tools.execute(
      request("repository-stats", "repository_stats", {}), context(workspace)
    );
    expect(JSON.parse(statistics.output)).toMatchObject({
      complete: true,
      totals: { files: 1, physicalLines: 3, nonBlankLines: 2 },
      languages: [{ language: "TypeScript", extensions: [".ts"], files: 1 }]
    });
    expect(tools.descriptor("repository_stats")?.possibleEffects).toEqual(["filesystem.read"]);
    expect(tools.descriptor("list")?.timeoutMs).toBe(45_000);
    expect(tools.descriptor("grep")?.timeoutMs).toBe(45_000);
    expect(tools.descriptor("git_status")?.timeoutMs).toBe(45_000);
    const linkedSource = path.join(workspace, "src", "linked-source.ts");
    await writeFile(linkedSource, "export const linked = true;\n", "utf8");
    await link(linkedSource, path.join(workspace, "src", "linked-copy.ts"));
    const partialStatistics = await tools.execute(
      request("repository-stats-partial", "repository_stats", {}), context(workspace)
    );
    expect(partialStatistics.diagnostics).toEqual(expect.arrayContaining([
      "statistics_partial=true",
      "skipped_source_files=2"
    ]));
    const found = await tools.execute(request("grep", "grep", { query: "alpha", path: "src", limit: 20 }), context(workspace));
    expect(found.output).toContain("one.txt");
    const textOnly = await tools.execute(request("grep-glob", "grep", {
      query: "alpha", path: "src", glob: "*.txt", limit: 20
    }), context(workspace));
    expect(textOnly.output).toContain("one.txt");
    expect(textOnly.output).not.toContain("two.md");
    expect(tools.descriptor("grep")?.possibleEffects).toEqual(["filesystem.read"]);
    const deadlinePartial = await repositoryTextSearchJsonLines(
      workspace,
      new AbortController().signal,
      { query: "alpha", path: "src", glob: "", regex: false, limit: 20 },
      { deadline: performance.now() - 1 }
    );
    expect(deadlinePartial.diagnostics).toEqual(expect.arrayContaining([
      "search_partial=true",
      "search_deadline_exceeded=true"
    ]));
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
    const validationPlan = await tools.prepare!(request("validate-plan", "validate", {
      executable: process.execPath, args: ["-e", "process.stdout.write('validated')"], timeoutMs: 5_000
    }), {
      sessionId: "session", runId: "run", workspacePath: workspace, runMode: "change"
    });
    expect(validation).toMatchObject({ ok: true, observedEffects: validationPlan.exactEffects });
    expect(validation.output).toBe("validated");
    expect(validationPlan).toMatchObject({
      exactEffects: ["process.spawn.readonly", "validation"],
      writePaths: [],
      checkpointScope: []
    });
    const scopedProcessPlan = await tools.prepare!(request("scoped-process", "exec", {
      executable: process.execPath, args: ["--version"], writePaths: ["src"]
    }), {
      sessionId: "session", runId: "run", workspacePath: workspace, runMode: "change"
    });
    expect(scopedProcessPlan).toMatchObject({
      exactEffects: ["process.spawn", "filesystem.write"],
      writePaths: ["src"],
      checkpointScope: ["src"],
      executionIntent: {
        access: "write",
        expectedChanges: ["src"],
        network: "none",
        purpose: "probe"
      },
      executionCapability: {
        profileId: "node-typescript",
        workspaceReadRoots: ["."],
        dependencyRoots: ["node_modules"],
        writeRoots: ["src"],
        backend: "native"
      }
    });
    const ptyPlan = await tools.prepare!(request("pty-process", "process_spawn", {
      executable: process.execPath, pty: true
    }), {
      sessionId: "session", runId: "run", workspacePath: workspace, runMode: "change"
    });
    expect(ptyPlan).toMatchObject({ processMode: "pty", writePaths: [], checkpointScope: [] });
    const pnpmExecutable = path.join(workspace, "bin", process.platform === "win32" ? "pnpm.cmd" : "pnpm");
    const packageTestPlan = await tools.prepare!(request("package-test", "validate", {
      executable: pnpmExecutable, args: ["test"]
    }), {
      sessionId: "session", runId: "run", workspacePath: workspace, runMode: "change"
    });
    expect(packageTestPlan).toMatchObject({
      network: "none",
      executionIntent: {
        invocation: { executable: pnpmExecutable, args: ["test"], cwd: "." },
        access: "readonly",
        network: "none",
        purpose: "test"
      },
      executionCapability: {
        profileId: "node-typescript",
        workspaceReadRoots: ["."],
        dependencyRoots: ["node_modules"],
        network: "none"
      }
    });
    await expect(tools.execute(request("missing", "missing", {}), context(workspace))).rejects.toThrow("Unknown tool");
    expect(isToolAllowed(tools.descriptor("write")!, "analyze")).toBe(false);
    expect(isToolAllowed(tools.descriptor("validate")!, "analyze")).toBe(true);
    const analyzeValidationPlan = await tools.prepare!(request("analyze-validation", "validate", {
      executable: process.execPath, args: ["--version"]
    }), {
      sessionId: "session", runId: "run", workspacePath: workspace, runMode: "analyze"
    });
    expect(analyzeValidationPlan.exactEffects).toEqual(["process.spawn.readonly", "validation"]);
    expect(analyzeValidationPlan.writePaths).toEqual([]);
    expect(isToolAllowed(tools.descriptor("read")!, "analyze")).toBe(true);
    expect(isToolAllowed({ ...tools.descriptor("read")!, approval: "deny" }, "change")).toBe(false);
    await expect(tools.execute(request("write-git", "write", {
      path: ".git/model-owned", content: "forbidden"
    }), context(workspace))).rejects.toMatchObject({ code: "protected_path" });
    await expect(tools.execute(request("write-agent", "write", {
      path: ".agent/config.toml", content: "forbidden"
    }), context(workspace))).rejects.toMatchObject({ code: "protected_path" });
    await expect(tools.execute(request("write-nested-git", "write", {
      path: "src/.git/model-owned", content: "forbidden"
    }), context(workspace))).rejects.toMatchObject({ code: "protected_path" });
    await expect(tools.execute(request("write-nested-agent", "write", {
      path: "src/.agent/config.toml", content: "forbidden"
    }), context(workspace))).rejects.toMatchObject({ code: "protected_path" });
  });

  it("bounds repository listings and reports their completeness", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-list-bounds-"));
    const source = path.join(workspace, "src");
    await mkdir(source, { recursive: true });
    const names = Array.from({ length: 400 }, (_, index) =>
      `file-${index.toString().padStart(4, "0")}-${"x".repeat(170)}.txt`
    );
    await Promise.all(names.map((name) => writeFile(path.join(source, name), "", "utf8")));
    const withoutProvider = registerBuiltinTools(new EffectToolRegistry(), { broker: execution });
    expect(withoutProvider.descriptor("list")).toBeUndefined();
    const tools = registerBuiltinTools(new EffectToolRegistry(), {
      broker: execution,
      repositoryList: repositoryListJsonLines
    });

    const entryLimited = await tools.execute(
      request("list-entry-limit", "list", { path: "src", limit: 1 }),
      context(workspace)
    );
    expect(entryLimited.output.split("\n")).toHaveLength(1);
    expect(entryLimited.diagnostics).toEqual(expect.arrayContaining([
      "listing_complete=false",
      "listing_truncated=true",
      "entry_limit=1",
      "listed_entries=1"
    ]));

    const characterLimited = await tools.execute(
      request("list-character-limit", "list", { path: "src", limit: 2_000 }),
      context(workspace)
    );
    expect(Buffer.byteLength(characterLimited.output, "utf8")).toBeLessThanOrEqual(64 * 1024);
    expect(characterLimited.output.split("\n").every((line) => typeof JSON.parse(line) === "string")).toBe(true);
    expect(characterLimited.diagnostics).toEqual(expect.arrayContaining([
      "listing_complete=false",
      "listing_truncated=true",
      "output_byte_limit_reached=true"
    ]));
    expect(characterLimited.diagnostics).toContain("output_byte_limit=65536");
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
      execution,
      executable: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"], cwd: workspace,
      timeoutMs: 5_000, signal: controller.signal
    });
    setTimeout(() => controller.abort(new Error("stop")), 20);
    await expect(cancelled).resolves.toMatchObject({ cancelled: true });
    await expect(runProcess({
      execution,
      executable: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"], cwd: workspace,
      timeoutMs: 20, signal: new AbortController().signal
    })).resolves.toMatchObject({ timedOut: true });
    await expect(runProcess({
      execution,
      executable: "definitely-missing-sigma-command", args: [], cwd: workspace, timeoutMs: 100,
      signal: new AbortController().signal
    })).rejects.toThrow();
    expect(shellInvocation("powershell", "Get-Date").executable).toContain("powershell");
    expect(shellInvocation("cmd", "echo ok").args).toContain("/c");
    expect(shellInvocation("bash", "true")).toEqual({ executable: "bash", args: ["-lc", "true"] });
    expect(runtimeEnvironment().defaultShell).toBe(process.platform === "win32" ? "cmd" : "bash");

    const locks = new ResourceLockManager();
    const order: string[] = [];
    await Promise.all([
      locks.withLocks(["b", "a"], async () => { order.push("first"); await new Promise((resolve) => setTimeout(resolve, 20)); }),
      locks.withLocks(["a"], async () => { order.push("second"); })
    ]);
    expect(order).toEqual(["first", "second"]);
  });

  it("decodes UTF-8 process output incrementally across byte chunks", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-process-utf8-"));
    const script = [
      "const out = Buffer.from([0xe4,0xb8,0xad,0xe6,0x96,0x87,0x20,0xf0,0x9f,0x9a,0x80]);",
      "const err = Buffer.from([0xe9,0x94,0x99,0xe8,0xaf,0xaf]);",
      "let index = 0;",
      "const timer = setInterval(() => {",
      "  if (index < out.length) process.stdout.write(out.subarray(index, index + 1));",
      "  if (index < err.length) process.stderr.write(err.subarray(index, index + 1));",
      "  index += 1;",
      "  if (index >= out.length) clearInterval(timer);",
      "}, 2);"
    ].join("\n");
    const result = await runProcess({
      execution,
      executable: process.execPath,
      args: ["-e", script],
      cwd: workspace,
      timeoutMs: 5_000,
      signal: new AbortController().signal
    });
    expect(result.stdout).toBe("中文 🚀");
    expect(result.stderr).toBe("错误");
    expect(result.stdout).not.toContain("�");
    expect(result.stderr).not.toContain("�");
  });
});
