import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentEvent, PermissionRequest } from "../packages/agent-core/src/index.js";
import { ApprovalPrompt } from "../packages/agent-tui/src/components/approval-prompt.js";
import { parseDiffMode } from "../packages/agent-tui/src/components/diff-panel.js";
import { formatTimelineEvent } from "../packages/agent-tui/src/components/timeline.js";
import { parseTuiArgs } from "../packages/agent-tui/src/index.js";

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
  it("shows bash command and workspace in approval prompts", () => {
    const request: PermissionRequest = {
      toolName: "bash",
      arguments: { command: "pnpm test" },
      risk: "execute",
      reason: "Run tests",
      workspacePath: "D:\\software\\sigma"
    };

    const rendered = ApprovalPrompt(request);
    expect(rendered).toContain("tool: bash");
    expect(rendered).toContain("workspace: D:\\software\\sigma");
    expect(rendered).toContain("arguments: command=pnpm test");
    expect(rendered).toContain("keys: y = allow once");
  });

  it("formats harness timeline events with command and result details", () => {
    expect(formatTimelineEvent(event("harness_check_start", {
      kind: "validation",
      attempt: 1,
      command: "pnpm test"
    }))).toContain("validation check started attempt=1 command=pnpm test");

    expect(formatTimelineEvent(event("harness_check_end", {
      kind: "validation",
      attempt: 1,
      exitCode: 0,
      durationMs: 123
    }))).toContain("validation check ended attempt=1 exit=0 duration=123ms");
  });

  it("parses diff command modes", () => {
    expect(parseDiffMode("")).toBe("stat");
    expect(parseDiffMode("stat")).toBe("stat");
    expect(parseDiffMode("patch")).toBe("patch");
    expect(parseDiffMode("nope")).toBeNull();
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
