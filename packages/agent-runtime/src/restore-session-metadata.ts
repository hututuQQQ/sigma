import {
  createBudgetLedger,
  isAssuranceResourcePolicy,
  isBudgetLedgerState,
  type AgentEventEnvelope,
  type AssuranceResourcePolicy,
  type BudgetLimits,
  type JsonValue,
  type ModelExecutionRole,
  type RunMode
} from "agent-protocol";

export interface RestoredSessionMetadata {
  workspacePath: string;
  parentSessionId?: string;
  mode: RunMode;
  writeScope: string[];
  strictWriteScope: boolean;
  modelRole: ModelExecutionRole;
  budgetLimits: BudgetLimits;
  assurancePolicy?: AssuranceResourcePolicy;
}

function modelExecutionRole(value: JsonValue | undefined): ModelExecutionRole {
  return value === "planner" || value === "reviewer" || value === "child_analyze"
    || value === "child_write" || value === "summarizer" ? value : "orchestrator";
}

function validBudgetLimits(value: JsonValue | undefined): BudgetLimits {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("session.created budgetLimits are missing.");
  }
  const candidate = createBudgetLedger(value as unknown as BudgetLimits);
  if (!isBudgetLedgerState(candidate)) throw new Error("session.created budgetLimits are invalid.");
  return candidate.limits;
}

function validAssurancePolicy(
  value: JsonValue | undefined
): { assurancePolicy: AssuranceResourcePolicy } | Record<string, never> {
  return isAssuranceResourcePolicy(value)
    ? { assurancePolicy: { ...(value as unknown as AssuranceResourcePolicy) } }
    : {};
}

export function createdSessionMetadata(event: AgentEventEnvelope | undefined): RestoredSessionMetadata | null {
  if (!event || event.type !== "session.created" || !event.payload
    || typeof event.payload !== "object" || Array.isArray(event.payload)) return null;
  const value = event.payload as Record<string, JsonValue>;
  return {
    workspacePath: typeof value.workspacePath === "string" ? value.workspacePath : ".",
    ...(typeof value.parentSessionId === "string" && value.parentSessionId
      ? { parentSessionId: value.parentSessionId } : {}),
    mode: value.mode === "analyze" ? "analyze" : "change",
    writeScope: Array.isArray(value.writeScope)
      ? value.writeScope.filter((item): item is string => typeof item === "string") : [],
    strictWriteScope: value.strictWriteScope === true,
    modelRole: modelExecutionRole(value.modelRole),
    budgetLimits: validBudgetLimits(value.budgetLimits),
    ...validAssurancePolicy(value.assurancePolicy)
  };
}
