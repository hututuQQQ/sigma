import { createHash, randomUUID } from "node:crypto";
import type {
  DiagnosticEvidence,
  ToolCallPlan,
  ToolEffect,
  ToolReceipt
} from "agent-protocol";

export function enclosingContainerMutationDiagnostic(
  receipt: ToolReceipt,
  plan: ToolCallPlan,
  scope: { sessionId: string; runId: string },
  actualEffects: readonly ToolEffect[]
): DiagnosticEvidence {
  const declaredPaths = [...new Set([
    ...plan.checkpointScope,
    ...plan.writePaths
  ])].sort();
  return {
    evidenceId: randomUUID(),
    sessionId: scope.sessionId,
    runId: scope.runId,
    createdAt: receipt.completedAt || new Date().toISOString(),
    producer: { authority: "tool", id: receipt.callId },
    kind: "diagnostic",
    status: receipt.ok ? "passed" : "failed",
    summary: receipt.ok
      ? "A declared mutation ran inside the attested disposable enclosing container."
      : "A declared enclosing-container mutation failed and may have partially changed its declared paths.",
    data: {
      source: "enclosing_container_mutation",
      diagnostic: {
        schemaVersion: 1,
        scope: "enclosing_container",
        callId: receipt.callId,
        declaredPaths,
        resultDigest: createHash("sha256")
          .update(receipt.output, "utf8")
          .digest("hex"),
        ok: receipt.ok,
        effects: [...actualEffects]
      }
    }
  };
}
