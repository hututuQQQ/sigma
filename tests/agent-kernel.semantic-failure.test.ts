import { describe, expect, it } from "vitest";
import {
  type EvidenceRecord,
  type ToolReceipt
} from "../packages/agent-protocol/src/index.js";
import {
  createKernelState,
  recordSemanticEvidenceProgress,
  recordSemanticToolResult,
  type KernelState
} from "../packages/agent-kernel/src/index.js";
import { receiptContent, toolReceipt } from "../packages/agent-kernel/src/receipt-parsing.js";

const NOW = "2026-07-12T00:00:00.000Z";

function initial(): KernelState {
  return createKernelState({
    sessionId: "semantic-session",
    runId: "semantic-run",
    mode: "change",
    startedAt: NOW,
    deadlineAt: "2026-07-12T00:15:00.000Z"
  });
}

function receipt(overrides: Partial<ToolReceipt> = {}): ToolReceipt {
  return {
    callId: "call",
    ok: true,
    output: "completed",
    outcome: { status: "succeeded", output: "completed", diagnosticCodes: [] },
    observedEffects: ["filesystem.read"],
    actualEffects: ["filesystem.read"],
    artifacts: [],
    diagnostics: [],
    startedAt: "start",
    completedAt: "end",
    ...overrides
  };
}

describe("semantic fact ledger", () => {
  it("puts structured outcome, diagnostics, and evidence summaries in model-visible history", () => {
    const evidence: EvidenceRecord = {
      evidenceId: "diagnostic-proof",
      sessionId: "semantic-session",
      runId: "semantic-run",
      kind: "diagnostic",
      status: "failed",
      createdAt: NOW,
      producer: { authority: "tool", id: "modern" },
      summary: "Executable capability probe failed.",
      data: { source: "sigma-exec", diagnostic: { code: "executable_not_found" } }
    };
    const content = receiptContent(receipt({
      callId: "modern",
      ok: false,
      output: "node was unavailable",
      outcome: {
        status: "failed",
        output: "node was unavailable",
        diagnosticCodes: ["executable_not_found"]
      },
      diagnostics: ["executable_not_found"],
      evidence: [evidence]
    }));
    expect(content).toContain("Failed tool receipt ID: modern");
    expect(content).toContain('"diagnosticCodes":["executable_not_found"]');
    expect(content).toContain('"evidenceId":"diagnostic-proof"');
    expect(content).toContain("Output:\nnode was unavailable");
  });

  it("clips large receipt output while retaining artifact and digest summaries", () => {
    const parsed = toolReceipt({
      callId: "large-receipt",
      ok: true,
      output: "head\n" + "payload ".repeat(20_000) + "\ntail",
      outcome: { status: "succeeded", output: "ok", diagnosticCodes: [] },
      observedEffects: ["filesystem.read"],
      artifacts: ["artifact-1"],
      artifactRefs: [{
        artifactId: "artifact-1", name: "stdout.log", digest: "a".repeat(64), sizeBytes: 123_456
      }],
      diagnostics: [],
      startedAt: "start",
      completedAt: "end"
    });
    expect(parsed).not.toBeNull();
    const content = receiptContent(parsed!);
    expect(content.length).toBeLessThan(20_000);
    expect(content).toContain("receipt output omitted");
    expect(content).toContain("artifact-1");
    expect(content).toContain("sha256=");
    expect(content).toContain("tail");
  });

  it("preserves an explicit empty actual-effects projection during durable parsing", () => {
    expect(toolReceipt({
      callId: "empty-effects",
      ok: false,
      output: "denied",
      observedEffects: ["process.spawn.readonly"],
      actualEffects: [],
      artifacts: [],
      diagnostics: ["policy_denied"],
      startedAt: "start",
      completedAt: "end"
    })).toMatchObject({ actualEffects: [] });
  });

  it("does not count process output, call IDs, or diagnostics as task progress", () => {
    let state = recordSemanticToolResult(initial(), receipt({
      callId: "one", output: "first output", diagnostics: ["first"]
    }), "exec").state;
    state = recordSemanticToolResult(state, receipt({
      callId: "two", output: "different output", diagnostics: ["second"]
    }), "shell").state;
    expect(state.taskControl.semanticFacts.entries).toEqual([]);
  });

  it("deduplicates new output from successful runtime-confirmed read-only processes", () => {
    const diagnostic = (callId: string, output: string): ToolReceipt => receipt({
      callId,
      output,
      observedEffects: ["process.spawn.readonly"],
      actualEffects: ["process.spawn.readonly"]
    });
    let state = recordSemanticToolResult(initial(), diagnostic("one", "first observation"), "shell").state;
    state = recordSemanticToolResult(state, diagnostic("two", "first observation"), "shell").state;
    expect(state.taskControl.semanticFacts.entries).toHaveLength(1);

    state = recordSemanticToolResult(state, diagnostic("three", "second observation"), "shell").state;
    expect(state.taskControl.semanticFacts.entries).toHaveLength(2);
  });

  it("rejects failed or mutating process output as semantic progress", () => {
    let state = recordSemanticToolResult(initial(), receipt({
      ok: false,
      observedEffects: ["process.spawn.readonly"],
      actualEffects: ["process.spawn.readonly"]
    }), "shell").state;
    state = recordSemanticToolResult(state, receipt({
      callId: "mutating",
      observedEffects: ["process.spawn", "filesystem.write"],
      actualEffects: ["process.spawn", "filesystem.write"]
    }), "shell").state;
    expect(state.taskControl.semanticFacts.entries).toEqual([]);
  });

  it("deduplicates exact content facts while accepting a genuinely new content digest", () => {
    const read = (callId: string, sha256: string): ToolReceipt => receipt({
      callId,
      result: { status: "read", path: "README.md", sha256 },
      output: `content ${sha256}`
    });
    let state = recordSemanticToolResult(initial(), read("one", "a".repeat(64)), "read").state;
    state = recordSemanticToolResult(state, read("two", "a".repeat(64)), "read").state;
    expect(state.taskControl.semanticFacts.entries).toHaveLength(1);
    state = recordSemanticToolResult(state, read("three", "b".repeat(64)), "read").state;
    expect(state.taskControl.semanticFacts.entries).toHaveLength(2);
  });

  it("records canonical workspace and validation facts but ignores diagnostic evidence", () => {
    const workspace: EvidenceRecord = {
      evidenceId: "workspace",
      sessionId: "semantic-session",
      runId: "semantic-run",
      kind: "workspace_delta",
      status: "passed",
      createdAt: NOW,
      producer: { authority: "runtime" },
      summary: "changed",
      data: {
        checkpointId: "checkpoint",
        delta: { added: [], modified: ["src/index.ts"], deleted: [] },
        reviewDiff: "diff",
        reviewDiffPaths: ["src/index.ts"]
      }
    };
    const diagnostic: EvidenceRecord = {
      evidenceId: "diagnostic",
      sessionId: "semantic-session",
      runId: "semantic-run",
      kind: "diagnostic",
      status: "passed",
      createdAt: NOW,
      producer: { authority: "runtime" },
      summary: "probe",
      data: { source: "test", diagnostic: { output: "variant" } }
    };
    let state = recordSemanticEvidenceProgress(initial(), workspace);
    expect(state.taskControl.semanticFacts.entries.map((item) => item.kind)).toEqual(["workspace_frontier"]);
    state = recordSemanticEvidenceProgress(state, diagnostic);
    expect(state.taskControl.semanticFacts.entries).toHaveLength(1);
  });
});
