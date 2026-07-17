import type { ProcessHandle } from "agent-execution";
import type { JsonValue, ToolReceipt, ToolRequest } from "agent-protocol";
import type { ExecutionToolOptions } from "./execution-tool-types.js";
import { executionArgs, executionText, executionToolSchema } from "./execution-tool-values.js";
import type { PlannedToolExecutionContext, RegisteredEffectTool } from "./registry.js";

function processHandle(input: Record<string, JsonValue>): ProcessHandle {
  return {
    id: executionText(input, "handleId"),
    brokerInstanceId: executionText(input, "brokerInstanceId")
  };
}

function handoffReceipt(request: ToolRequest, startedAt: string, value: unknown): ToolReceipt {
  return {
    callId: request.callId,
    ok: true,
    output: JSON.stringify(value),
    observedEffects: ["process.handoff"],
    actualEffects: ["process.handoff"],
    artifacts: [],
    diagnostics: [],
    evidence: [],
    startedAt,
    completedAt: new Date().toISOString()
  };
}

export function processHandoffTool(
  options: ExecutionToolOptions,
  handleProperties: Record<string, JsonValue>
): RegisteredEffectTool {
  return {
    descriptor: executionToolSchema(
      "process_handoff",
      "Transfer a verified running deliverable process to the outer environment so it survives successful task completion. The process can no longer be polled, written, or terminated through this session.",
      handleProperties,
      ["handleId", "brokerInstanceId"],
      ["process.handoff"]
    ),
    async execute(request: ToolRequest, context: PlannedToolExecutionContext) {
      const startedAt = new Date().toISOString();
      if (!options.broker.handoff) {
        throw Object.assign(new Error("Process handoff is unavailable for this execution broker."), {
          code: "process_handoff_unavailable"
        });
      }
      const result = await options.broker.handoff(
        processHandle(executionArgs(request.arguments)), { signal: context.signal }
      );
      return handoffReceipt(request, startedAt, result);
    }
  };
}
