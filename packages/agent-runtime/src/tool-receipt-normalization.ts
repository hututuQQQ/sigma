import type { ToolReceipt } from "agent-protocol";
import { normalizeReceiptEvidence } from "./tool-evidence.js";
import { validationScope } from "./tool-plan-enforcement.js";
import type { PreparedTool } from "./tool-transaction-types.js";
import type { RuntimeSession } from "./types.js";

export function normalizeToolTransactionReceipt(
  session: RuntimeSession,
  prepared: PreparedTool,
  receipt: ToolReceipt
): ToolReceipt {
  const { call, descriptor, plan } = prepared;
  const finalValidationScope = plan.exactEffects.includes("validation")
    && plan.exactEffects.includes("filesystem.write")
    ? validationScope(session, call, plan)
    : prepared.validationScope;
  return normalizeReceiptEvidence(receipt, descriptor.name, plan, {
    sessionId: session.identity.sessionId,
    runId: session.durable.runId,
    workspaceDeltas: [],
    repositoryScope: {
      goalEpoch: session.durable.state.messages.filter((message) => message.role === "user").length,
      frontier: session.durable.state.mutationFrontier,
      mutationEvidence: [...session.durable.state.mutationEvidence]
    },
    ...(finalValidationScope ? { validationScope: finalValidationScope } : {})
  });
}
