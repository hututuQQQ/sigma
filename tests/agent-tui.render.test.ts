import { afterEach, describe, expect, it } from "vitest";
import type { AgentEvent, PermissionRequest } from "../packages/agent-core/src/index.js";
import { approvalPromptLines } from "../packages/agent-tui/src/components/approval-prompt.js";
import { renderDiffLines } from "../packages/agent-tui/src/components/diff-panel.js";
import { createComposerState } from "../packages/agent-tui/src/composer-state.js";
import { mergeDisabledToolsForMode, PLAN_DISABLED_TOOLS } from "../packages/agent-tui/src/mode.js";
import { renderScreen } from "../packages/agent-tui/src/render/screen.js";
import { buildTranscript } from "../packages/agent-tui/src/view-model.js";
import { assertWithinWidth, splitLines } from "../packages/agent-tui/src/ui/layout.js";

const savedEnv = { TERM: process.env.TERM, WT_SESSION: process.env.WT_SESSION, SIGMA_ASCII: process.env.SIGMA_ASCII };

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
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
    process.env.WT_SESSION = "1";
    delete process.env.TERM;
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

    expect(rendered).toContain("∑ sigma");
    expect(rendered).toContain("ready in D:\\software\\sigma\\packages\\agent-tui");
    expect(rendered).toContain("fi▌x tests");
    expect(rendered).not.toContain("+--");
    expect(rendered).not.toContain("Status");
    expect(rendered).not.toContain("Timeline");
    expect(assertWithinWidth(rendered, 96)).toBe(true);

    const fullWidthRules = splitLines(rendered).filter((line) => /^─{80,}$/.test(line));
    expect(fullWidthRules.length).toBeLessThanOrEqual(2);
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

    expect(rendered).toContain("S sigma");
    expect(rendered).not.toContain("+---");
    expect(assertWithinWidth(rendered, 54)).toBe(true);
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
