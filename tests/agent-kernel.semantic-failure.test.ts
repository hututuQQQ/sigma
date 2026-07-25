import { describe, expect, it } from "vitest";
import type { EvidenceRecord, ToolReceipt } from "../packages/agent-protocol/src/index.js";
import { receiptContent, toolReceipt } from "../packages/agent-kernel/src/receipt-parsing.js";

const NOW = "2026-07-23T00:00:00.000Z";

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
    startedAt: NOW,
    completedAt: NOW,
    ...overrides
  };
}

describe("model-visible tool receipts", () => {
  it("keeps a failed tool as structured observation rather than semantic control state", () => {
    const evidence: EvidenceRecord = {
      evidenceId: "diagnostic-proof",
      sessionId: "session",
      runId: "run",
      kind: "diagnostic",
      status: "failed",
      createdAt: NOW,
      producer: { authority: "tool", id: "exec" },
      summary: "Executable probe failed.",
      data: { source: "exec", diagnostic: { code: "executable_not_found" } }
    };
    const content = receiptContent(receipt({
      callId: "exec",
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
    expect(content).toContain("Failed tool receipt ID: exec");
    expect(content).toContain('"diagnosticCodes":["executable_not_found"]');
    expect(content).toContain('"evidenceId":"diagnostic-proof"');
    expect(content).toContain("Output:\nnode was unavailable");
  });

  it("clips large output while retaining artifacts, digest summaries, and the tail", () => {
    const parsed = toolReceipt({
      callId: "large-receipt",
      ok: true,
      output: `head\n${"payload ".repeat(20_000)}\ntail`,
      outcome: { status: "succeeded", output: "ok", diagnosticCodes: [] },
      observedEffects: ["filesystem.read"],
      artifacts: ["artifact-1"],
      artifactRefs: [{
        artifactId: "artifact-1",
        name: "stdout.log",
        digest: "a".repeat(64),
        sizeBytes: 123_456
      }],
      diagnostics: [],
      startedAt: NOW,
      completedAt: NOW
    });
    expect(parsed).not.toBeNull();
    const content = receiptContent(parsed!);
    expect(content.length).toBeLessThan(20_000);
    expect(content).toContain("receipt output omitted");
    expect(content).toContain("artifact-1");
    expect(content).toContain("sha256=");
    expect(content).toContain("tail");
  });

  it("preserves an explicit empty actual-effects projection", () => {
    expect(toolReceipt({
      callId: "empty-effects",
      ok: false,
      output: "denied",
      observedEffects: ["process.spawn.readonly"],
      actualEffects: [],
      artifacts: [],
      diagnostics: ["policy_denied"],
      startedAt: NOW,
      completedAt: NOW
    })).toMatchObject({ actualEffects: [] });
  });
});
