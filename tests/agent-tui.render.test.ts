import { afterEach, describe, expect, it } from "vitest";
import type { AgentEvent, AgentRunResult, PermissionRequest } from "../packages/agent-core/src/index.js";
import { approvalPromptLines } from "../packages/agent-tui/src/components/approval-prompt.js";
import { renderDiffLines } from "../packages/agent-tui/src/components/diff-panel.js";
import { createComposerState } from "../packages/agent-tui/src/composer-state.js";
import { mergeDisabledToolsForMode, PLAN_DISABLED_TOOLS } from "../packages/agent-tui/src/mode.js";
import { renderScreen } from "../packages/agent-tui/src/render/screen.js";
import { buildTranscript } from "../packages/agent-tui/src/view-model.js";
import { assertWithinWidth, splitLines } from "../packages/agent-tui/src/ui/layout.js";

const savedEnv = {
  FORCE_COLOR: process.env.FORCE_COLOR,
  NO_COLOR: process.env.NO_COLOR,
  SIGMA_ASCII: process.env.SIGMA_ASCII,
  SIGMA_FORCE_COLOR: process.env.SIGMA_FORCE_COLOR,
  SIGMA_FORCE_UNICODE: process.env.SIGMA_FORCE_UNICODE,
  SIGMA_NO_COLOR: process.env.SIGMA_NO_COLOR,
  TERM: process.env.TERM,
  WT_SESSION: process.env.WT_SESSION
};
const savedPlatform = Object.getOwnPropertyDescriptor(process, "platform");

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (savedPlatform) Object.defineProperty(process, "platform", savedPlatform);
});

function event(type: AgentEvent["type"], metadata: Record<string, unknown>, parentId?: string): AgentEvent {
  return {
    id: `${type}-${Math.random()}`,
    timestamp: "2026-07-07T12:34:56.000Z",
    type,
    runId: "run-1",
    parentId,
    metadata
  };
}

describe("agent-tui stream rendering", () => {
  it("renders an idle transcript-first screen without a box farm", () => {
    process.env.TERM = "xterm-256color";
    delete process.env.SIGMA_ASCII;
    const composer = createComposerState("fix tests");
    composer.cursor = 2;
    const entries = buildTranscript({
      workspacePath: "D:\\software\\sigma\\packages\\agent-tui",
      events: [],
      result: null
    });

    const rendered = renderScreen({
      workspacePath: "D:\\software\\sigma\\packages\\agent-tui",
      provider: "deepseek",
      permissionMode: "ask",
      mode: "build",
      running: false,
      result: null,
      events: [],
      message: null,
      composer,
      entries,
      width: 96,
      height: 24,
      color: false
    });

    expect(rendered).toContain("Sigma Code v0.1.0");
    expect(rendered).toContain("\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588");
    expect(rendered).toContain("\u2588\u2588              \u2211 Sigma Code v0.1.0");
    expect(rendered).toContain("\u2588\u2588            DeepSeek \u00b7 default");
    expect(rendered).not.toContain("\u203a_");
    expect(rendered).toContain("DeepSeek \u00b7 default");
    expect(rendered).toContain("D:\\software\\sigma\\packages\\agent-tui");
    expect(rendered).toContain("Ready in agent-tui");
    expect(rendered).not.toContain("/files open workbench");
    expect(rendered).not.toContain("@src/app.tsx explain rendering");
    expect(rendered).not.toContain("!pnpm test");
    expect(rendered).toContain("> fi\u258cx tests");
    expect(rendered).not.toContain("\u256d");
    expect(rendered).not.toContain("\u2502fi\u258cx tests");
    expect(rendered).toContain("? for shortcuts");
    expect(rendered).toContain("build \u00b7 deepseek/default \u00b7 ask \u00b7 idle");
    expect(rendered).not.toContain("auto-approve:off");
    expect(rendered).not.toContain("+--");
    expect(rendered).not.toContain("Workbench");
    expect(rendered).not.toContain("Status");
    expect(rendered).not.toContain("Timeline");
    expect(rendered).not.toContain("system    ");
    expect(rendered).not.toContain("input=0 output=0 total=0");
    expect(rendered).not.toContain("\u001b[");
    expect(assertWithinWidth(rendered, 96)).toBe(true);

    const fullWidthRules = splitLines(rendered).filter((line) => /^\u2500{80,}$/.test(line));
    expect(fullWidthRules.length).toBeLessThanOrEqual(2);
  });

  it("renders a wide workbench panel with files, changes, tools, and checks", () => {
    process.env.TERM = "xterm-256color";
    process.env.SIGMA_FORCE_UNICODE = "1";
    const start = event("tool_start", {
      toolCall: { id: "call-1", function: { name: "read", arguments: { path: "package.json" } } }
    });
    const end = event("tool_end", {
      toolName: "read",
      result: { ok: true, content: "{}", metadata: { durationMs: 18 } }
    }, start.id);
    const result: AgentRunResult = {
      status: "completed",
      finishReason: "assistant_stop",
      turns: 2,
      toolCalls: 1,
      commandsExecuted: 0,
      usage: { inputTokens: 10, outputTokens: 5, cacheTokens: 0, totalTokens: 15 },
      provider: "deepseek",
      model: "fake-model",
      durationMs: 1200,
      lastError: null
    };
    const entries = buildTranscript({
      workspacePath: "/tmp/sigma",
      events: [start, end],
      result
    });

    const rendered = renderScreen({
      workspacePath: "/tmp/sigma",
      provider: "deepseek",
      model: "fake-model",
      permissionMode: "ask",
      validationMode: "auto",
      finalEvidenceMode: "auto",
      maxTurns: 4,
      mode: "build",
      running: false,
      result,
      events: [start, end],
      message: null,
      composer: createComposerState(),
      entries,
      workbenchOpen: true,
      filePaths: ["package.json", "packages/agent-tui/src/app.tsx"],
      diffText: " packages/agent-tui/src/app.tsx | 24 ++++++++++----",
      width: 124,
      height: 28,
      color: false
    });

    expect(rendered).toContain("\u2211 Workbench");
    expect(rendered).toContain("Files");
    expect(rendered).toContain("package.json");
    expect(rendered).toContain("Changes");
    expect(rendered).toContain("packages/agent-tui/src/app.tsx");
    expect(rendered).toContain("Tool calls");
    expect(rendered).toContain("Benchmark");
    expect(rendered).toContain("tokens      input=10 output=5 total=15");
    expect(rendered).toContain("read path=package.json");
    expect(rendered).toContain("ctx input=10/output=5/total=15");
    expect(assertWithinWidth(rendered, 124)).toBe(true);
  });

  it("renders a diff-first changed files card after edits", () => {
    process.env.TERM = "xterm-256color";
    process.env.SIGMA_FORCE_UNICODE = "1";
    const result: AgentRunResult = {
      status: "completed",
      finishReason: "assistant_stop",
      turns: 2,
      toolCalls: 1,
      commandsExecuted: 0,
      usage: { inputTokens: 10, outputTokens: 5, cacheTokens: 0, totalTokens: 15 },
      provider: "deepseek",
      model: "fake-model",
      durationMs: 1200,
      lastError: null,
      changedFiles: [
        "packages/agent-tui/src/app.tsx",
        "packages/agent-tui/src/render/screen.ts"
      ]
    };
    const entries = buildTranscript({
      workspacePath: "/tmp/sigma",
      events: [],
      result
    });

    const rendered = renderScreen({
      workspacePath: "/tmp/sigma",
      provider: "deepseek",
      model: "fake-model",
      permissionMode: "ask",
      mode: "build",
      running: false,
      result,
      events: [],
      message: null,
      composer: createComposerState(),
      entries,
      width: 96,
      height: 24,
      color: false
    });

    expect(rendered).toContain("Changed 2 files");
    expect(rendered).toContain("packages/agent-tui/src/app.tsx");
    expect(rendered).toContain("Next: run tests?  [enter] yes  [esc] no  [d] diff");
    expect(assertWithinWidth(rendered, 96)).toBe(true);
  });

  it("defaults to Unicode on Windows-like terminals without WT_SESSION", () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    process.env.TERM = "xterm-256color";
    delete process.env.WT_SESSION;
    delete process.env.SIGMA_ASCII;

    const rendered = renderScreen({
      workspacePath: "D:\\software\\sigma\\packages\\agent-tui",
      provider: "deepseek",
      permissionMode: "ask",
      mode: "build",
      running: false,
      result: null,
      events: [],
      message: null,
      composer: createComposerState(),
      entries: buildTranscript({ workspacePath: "D:\\software\\sigma\\packages\\agent-tui", events: [], result: null }),
      width: 88,
      height: 18,
      color: false
    });

    expect(rendered).toContain("\u2588\u2588              \u2211 Sigma Code v0.1.0");
    expect(rendered).not.toContain("S sigma");
  });

  it("renders missing API key errors as a single actionable card", () => {
    process.env.TERM = "xterm-256color";
    const errorResult = {
      status: "error",
      finishReason: "model_error",
      lastError: "deepseek API key is missing. Set DEEPSEEK_API_KEY or pass an apiKey explicitly.",
      toolCalls: 0,
      turns: 1,
      usage: { inputTokens: 0, outputTokens: 0, cacheTokens: 0, totalTokens: 0 }
    } as AgentRunResult;
    const entries = buildTranscript({
      workspacePath: "/tmp/sigma",
      events: [
        event("error", {
          message: "deepseek API key is missing. Set DEEPSEEK_API_KEY or pass an apiKey explicitly."
        })
      ],
      result: errorResult
    });
    const rendered = renderScreen({
      workspacePath: "/tmp/sigma",
      provider: "deepseek",
      permissionMode: "ask",
      mode: "build",
      running: false,
      result: errorResult,
      events: [],
      message: null,
      composer: createComposerState(),
      entries,
      width: 92,
      height: 16,
      color: false
    });

    expect(rendered).toContain("Missing DEEPSEEK_API_KEY");
    expect(rendered).toContain("Set it with: $env:DEEPSEEK_API_KEY='...' on PowerShell");
    expect(rendered).toContain("Or switch provider: /provider glm");
    expect(rendered).toContain("Run /status or agent doctor --check-api");
    expect(rendered).not.toContain("summary   error | error");
    expect(rendered).not.toContain("system    ");
    expect(rendered).not.toContain("input=0 output=0 total=0");
  });

  it("keeps narrow screens within width and falls back plainly for dumb terminals", () => {
    process.env.TERM = "dumb";
    process.env.SIGMA_ASCII = "1";
    const rendered = renderScreen({
      workspacePath: "/tmp/sigma",
      provider: "glm",
      permissionMode: "ask",
      mode: "plan",
      running: false,
      result: null,
      events: [],
      message: "ready",
      composer: createComposerState(),
      entries: buildTranscript({ workspacePath: "/tmp/sigma", events: [], result: null }),
      width: 54,
      height: 18,
      color: false
    });

    expect(rendered).toContain("SSSSSSSSSSS");
    expect(rendered).toContain("SS              S Sigma Code v0.1.0");
    expect(rendered).toContain("SS            DeepSeek | default");
    expect(rendered).not.toContain(">_");
    expect(rendered).toContain("DeepSeek | default");
    expect(rendered).toContain("/tmp/sigma");
    expect(rendered).not.toContain("\u2211 sigma");
    expect(assertWithinWidth(rendered, 54)).toBe(true);
  });

  it("respects SIGMA_ASCII while SIGMA_FORCE_UNICODE overrides dumb terminals", () => {
    process.env.TERM = "xterm-256color";
    process.env.SIGMA_ASCII = "1";
    delete process.env.SIGMA_FORCE_UNICODE;
    const ascii = renderScreen({
      workspacePath: "/tmp/sigma",
      provider: "glm",
      permissionMode: "ask",
      mode: "build",
      running: false,
      result: null,
      events: [],
      message: null,
      composer: createComposerState(),
      entries: buildTranscript({ workspacePath: "/tmp/sigma", events: [], result: null }),
      width: 80,
      height: 16,
      color: false
    });

    expect(ascii).toContain("SS              S Sigma Code v0.1.0");
    expect(ascii).toContain("SS            DeepSeek | default");
    expect(ascii).not.toContain(">_");
    expect(ascii).not.toContain("\u2211 Sigma Code");

    process.env.TERM = "dumb";
    delete process.env.SIGMA_ASCII;
    process.env.SIGMA_FORCE_UNICODE = "1";
    const forced = renderScreen({
      workspacePath: "/tmp/sigma",
      provider: "glm",
      permissionMode: "ask",
      mode: "build",
      running: false,
      result: null,
      events: [],
      message: null,
      composer: createComposerState(),
      entries: buildTranscript({ workspacePath: "/tmp/sigma", events: [], result: null }),
      width: 80,
      height: 16,
      color: false
    });

    expect(forced).toContain("\u2588\u2588              \u2211 Sigma Code v0.1.0");
    expect(forced).not.toContain("S Sigma Code");
  });

  it("turns raw events into product-level transcript entries", () => {
    const start = event("tool_start", {
      toolCall: { id: "call-1", function: { name: "read", arguments: { path: "package.json" } } }
    });
    const end = event("tool_end", {
      toolName: "read",
      result: { ok: true, content: "{}", metadata: { durationMs: 18 } }
    }, start.id);
    const entries = buildTranscript({
      workspacePath: "/tmp/sigma",
      events: [
        event("assistant_message", { content: "I'll inspect the package.", toolCalls: [] }),
        start,
        end
      ],
      result: null
    });

    expect(entries.some((entry) => entry.kind === "assistant" && entry.text.includes("inspect"))).toBe(true);
    expect(entries).toContainEqual(expect.objectContaining({
      kind: "tool",
      name: "read",
      status: "ok",
      durationMs: 18
    }));
  });

  it("redacts approval details and truncates diff output with color disabled", () => {
    const request: PermissionRequest = {
      toolName: "bash",
      arguments: { command: "pnpm test --token=sk-testSecret123456" },
      risk: "execute",
      reason: "Run tests",
      workspacePath: "D:\\software\\sigma"
    };
    const approval = approvalPromptLines(request, 80).join("\n");
    expect(approval).toContain("[REDACTED]");
    expect(approval).not.toContain("sk-testSecret123456");

    const diff = renderDiffLines(
      null,
      ["diff --git a/a.ts b/a.ts", "@@ -1 +1 @@", "-old", "+new", ...Array.from({ length: 30 }, (_, index) => ` context ${index}`)].join("\n"),
      "patch",
      70,
      8,
      false
    ).join("\n");
    expect(diff).toContain("diff lines truncated");
    expect(diff).not.toContain("\u001b[");
  });

  it("merges plan-mode disabled tools and restores build mode filters", () => {
    expect(mergeDisabledToolsForMode("plan", ["todo"])).toEqual(expect.arrayContaining([
      "todo",
      ...PLAN_DISABLED_TOOLS
    ]));
    expect(mergeDisabledToolsForMode("build", ["todo"])).toEqual(["todo"]);
    expect(mergeDisabledToolsForMode("build", undefined)).toBeUndefined();
  });
});
