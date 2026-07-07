import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentEvent, PermissionRequest } from "../packages/agent-core/src/index.js";
import { ApprovalPrompt } from "../packages/agent-tui/src/components/approval-prompt.js";
import { commandSuggestions } from "../packages/agent-tui/src/components/commands.js";
import { Composer } from "../packages/agent-tui/src/components/composer.js";
import { DiffPanel, parseDiffMode } from "../packages/agent-tui/src/components/diff-panel.js";
import { formatTimelineEvent } from "../packages/agent-tui/src/components/timeline.js";
import { parseTuiArgs } from "../packages/agent-tui/src/index.js";
import { box } from "../packages/agent-tui/src/ui/box.js";
import { assertWithinWidth } from "../packages/agent-tui/src/ui/layout.js";

function event(type: AgentEvent["type"], metadata: Record<string, unknown>): AgentEvent {
  return {
    id: `${type}-1`,
    timestamp: "2026-07-07T12:34:56.000Z",
    type,
    runId: "run-1",
    metadata
  };
}

describe("agent-tui formatting helpers", () => {
  it("renders boxed layout without lines wider than the requested width", () => {
    const rendered = [
      box({
        title: "∑ Layout",
        width: 42,
        height: 6,
        lines: [
          "a very long status line that should be clipped before it escapes the box",
          "short"
        ]
      }),
      Composer({
        width: 42,
        input: "first line with a long command that must fit\nsecond line",
        running: true,
        approvalPending: false,
        queuedInstruction: "queued follow up with enough words to wrap"
      }),
      DiffPanel(null, "@@ -1 +1 @@\n-old secret=sk-testSecret123456\n+new", "patch", 42, 8)
    ].join("\n");

    expect(assertWithinWidth(rendered, 42)).toBe(true);
  });

  it("filters command palette suggestions for diff commands", () => {
    expect(commandSuggestions("/di").map((command) => command.usage)).toEqual([
      "/diff",
      "/diff stat",
      "/diff patch"
    ]);
  });

  it("shows bash command, workspace, risk, and redacts secrets in approval prompts", () => {
    const request: PermissionRequest = {
      toolName: "bash",
      arguments: { command: "pnpm test --token=sk-testSecret123456" },
      risk: "execute",
      reason: "Run tests",
      workspacePath: "D:\\software\\sigma"
    };

    const rendered = ApprovalPrompt(request, { width: 90 });
    expect(rendered).toContain("tool: bash");
    expect(rendered).toContain("risk: execute");
    expect(rendered).toContain("workspace: D:\\software\\sigma");
    expect(rendered).toContain("pnpm test --token=[REDACTED]");
    expect(rendered).not.toContain("sk-testSecret123456");
    expect(rendered).toContain("keys: y allow once");
  });

  it("formats harness timeline events with command and result details", () => {
    expect(formatTimelineEvent(event("harness_check_start", {
      kind: "validation",
      attempt: 1,
      command: "pnpm test"
    }))).toContain("validation check started");

    expect(formatTimelineEvent(event("harness_check_end", {
      kind: "validation",
      attempt: 1,
      exitCode: 0,
      durationMs: 123
    }))).toContain("validation check passed");
    expect(formatTimelineEvent(event("harness_check_end", {
      kind: "validation",
      attempt: 1,
      exitCode: 0,
      durationMs: 123
    }))).toContain("123ms");
  });

  it("parses diff command modes", () => {
    expect(parseDiffMode("")).toBe("stat");
    expect(parseDiffMode("stat")).toBe("stat");
    expect(parseDiffMode("patch")).toBe("patch");
    expect(parseDiffMode("nope")).toBeNull();
  });

  it("formats diff stat and patch panels with truncation", () => {
    const stat = DiffPanel(null, " packages/agent-tui/src/app.tsx | 24 ++++++++++----", "stat", 72, 10);
    expect(stat).toContain("mode: stat");
    expect(stat).toContain("packages/agent-tui/src/app.tsx");

    const patch = DiffPanel(
      null,
      [
        "diff --git a/file.ts b/file.ts",
        "@@ -1,2 +1,2 @@",
        "-old",
        "+new",
        ...Array.from({ length: 40 }, (_, index) => ` context ${index}`)
      ].join("\n"),
      "patch",
      72,
      12
    );
    expect(patch).toContain("mode: patch");
    expect(patch).toContain("@@ -1,2 +1,2 @@");
    expect(patch).toContain("-old");
    expect(patch).toContain("+new");
    expect(patch).toContain("diff lines truncated");
  });

  it("parses mirrored TUI run flags without dropping existing flags", () => {
    const parsed = parseTuiArgs([
      "--workspace",
      ".",
      "--provider",
      "glm",
      "--model",
      "glm-5.2",
      "--permission-mode",
      "yolo",
      "--validation-mode",
      "auto",
      "--validation-command",
      "pnpm test",
      "--validation-commands",
      "pnpm build,pnpm lint",
      "--post-run-cleanup-globs",
      "tmp/*.log,.cache/*.tmp",
      "--harness-timeout-sec",
      "600",
      "--retry-min-budget-sec",
      "90",
      "--attempts-dir",
      ".agent/attempts",
      "--allowed-tools",
      "read,grep",
      "--disabled-tools",
      "bash",
      "--context-mode",
      "repo-map",
      "--repo-map-max-chars",
      "1234",
      "--final-evidence-mode",
      "auto",
      "--skills-mode",
      "off",
      "--skills-max-chars",
      "2000",
      "--enable-mcp",
      "--mcp-config",
      ".agent/mcp.json",
      "--trace-jsonl",
      "trace.jsonl",
      "--session-jsonl",
      "session.jsonl",
      "--summary-json",
      "summary.json"
    ]);

    expect(parsed).not.toBe("help");
    if (parsed === "help") return;
    expect(parsed.workspace).toBe(path.resolve("."));
    expect(parsed).toMatchObject({
      provider: "glm",
      model: "glm-5.2",
      permissionMode: "yolo",
      validationMode: "auto",
      validationCommands: ["pnpm test", "pnpm build", "pnpm lint"],
      postRunCleanupGlobs: ["tmp/*.log", ".cache/*.tmp"],
      harnessTimeoutSec: 600,
      retryMinBudgetSec: 90,
      attemptsDir: ".agent/attempts",
      allowedTools: ["read", "grep"],
      disabledTools: ["bash"],
      contextMode: "repo-map",
      repoMapMaxChars: 1234,
      finalEvidenceMode: "auto",
      skillsMode: "off",
      skillsMaxChars: 2000,
      enableMcp: true,
      mcpConfig: ".agent/mcp.json",
      traceJsonl: "trace.jsonl",
      sessionJsonl: "session.jsonl",
      summaryJson: "summary.json"
    });
  });
});
