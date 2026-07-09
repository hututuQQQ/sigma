import { describe, expect, it } from "vitest";
import type { AgentRunResult, PermissionRequest } from "../packages/agent-core/src/index.js";
import { buildTuiRunState } from "../packages/agent-tui/src/run-state.js";

function result(status: AgentRunResult["status"], finishReason = "assistant_stop"): AgentRunResult {
  return {
    status,
    finishReason,
    toolCalls: 0,
    turns: 1,
    usage: { inputTokens: 0, outputTokens: 0, cacheTokens: 0, totalTokens: 0 }
  };
}

describe("agent-tui run state", () => {
  it("models idle input as ready for a normal prompt", () => {
    expect(buildTuiRunState({
      running: false,
      result: null
    })).toMatchObject({
      phase: "idle",
      label: "idle",
      tone: "dim",
      active: false,
      composerPrompt: ">",
      queuedCount: 0
    });
  });

  it("keeps running state while exposing queued follow-up input", () => {
    expect(buildTuiRunState({
      running: true,
      result: null,
      queuedInstruction: "run focused tests"
    })).toMatchObject({
      phase: "running",
      label: "running",
      tone: "warning",
      active: true,
      composerPrompt: "queue >",
      queuedCount: 1,
      queuedInstruction: "run focused tests"
    });
  });

  it("makes approval the visible interaction state while preserving queue metadata", () => {
    const pendingApproval: PermissionRequest = {
      toolName: "bash",
      arguments: { command: "pnpm test" },
      risk: "execute",
      reason: "Run tests",
      workspacePath: "/tmp/sigma"
    };

    expect(buildTuiRunState({
      running: true,
      result: null,
      queuedInstruction: "summarize after approval",
      pendingApproval
    })).toMatchObject({
      phase: "approval",
      label: "approval",
      tone: "warning",
      active: true,
      approvalPending: true,
      composerPrompt: "approval >",
      queuedCount: 1
    });
  });

  it("maps terminal results to product-level labels and tones", () => {
    expect(buildTuiRunState({ running: false, result: result("completed") })).toMatchObject({
      phase: "completed",
      label: "completed",
      tone: "success",
      active: false,
      lastResult: "completed assistant_stop"
    });
    expect(buildTuiRunState({ running: false, result: result("stopped", "cancelled") })).toMatchObject({
      phase: "stopped",
      label: "stopped",
      tone: "warning",
      lastResult: "stopped cancelled"
    });
    expect(buildTuiRunState({ running: false, result: result("error", "model_error") })).toMatchObject({
      phase: "error",
      label: "error",
      tone: "danger",
      lastResult: "error model_error"
    });
  });

  it("includes structured loop phase and reason in terminal result labels", () => {
    const stopped = result("stopped", "blocked_no_verification_progress");
    stopped.loopDiagnostics = {
      intent: "mutation",
      mode: "normal",
      phase: "stopped",
      stepOutcome: "blocked",
      providerTurns: 4,
      readOnlyTurns: 2,
      noChangeTurns: 2,
      broadReadTurns: 0,
      repeatedReadIntents: 0,
      mutationCount: 1,
      validationCount: 0,
      verifyNoProgressTurns: 2,
      postMutationNoProgressTurns: 2,
      forcedActions: ["blocked_no_verification_progress"],
      lastControllerReason: "blocked_no_verification_progress"
    };

    expect(buildTuiRunState({ running: false, result: stopped })).toMatchObject({
      lastResult: "stopped blocked_no_verification_progress phase=stopped reason=blocked_no_verification_progress"
    });
  });
});
