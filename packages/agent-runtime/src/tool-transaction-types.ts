import type { ToolCallApproval, ToolCallPlan, ToolDescriptor } from "agent-protocol";
import type { ToolAttempt } from "./effect-runner-helpers.js";
import type { FrozenValidationScope } from "./tool-plan-enforcement.js";

export interface PreparedTool extends ToolAttempt {
  descriptor: ToolDescriptor;
  plan: ToolCallPlan;
  startedAt: string;
  approval?: ToolCallApproval;
  validationScope?: FrozenValidationScope;
}

export interface TransactionState {
  executionStarted: boolean;
}
