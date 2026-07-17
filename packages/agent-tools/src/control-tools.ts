import type {
  JsonValue,
  PlanGraph,
  ToolCallPlan,
  ToolDescriptor,
  ToolReceipt,
  ToolRequest
} from "agent-protocol";
import { isPlanGraph } from "agent-protocol";
import type { EffectToolRegistry, RegisteredEffectTool } from "./registry.js";

function object(value: JsonValue): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function descriptor(
  name: string,
  description: string,
  properties: Record<string, JsonValue>,
  required: string[] = [],
  effects: ToolDescriptor["possibleEffects"] = ["runtime.control"]
): ToolDescriptor {
  return {
    name,
    description,
    inputSchema: { type: "object", properties, required, additionalProperties: false },
    possibleEffects: effects,
    maximumEffects: effects,
    availableModes: ["analyze", "change"],
    executionMode: effects.includes("filesystem.write") ? "exclusive" : "sequential",
    resourceKeys: ["runtime:control"],
    approval: effects.includes("destructive") ? "prompt" : "auto",
    idempotent: !effects.includes("destructive"),
    timeoutMs: 30_000
  };
}

function receipt(request: ToolRequest, startedAt: string, value: unknown, effects: ToolDescriptor["possibleEffects"]): ToolReceipt {
  return {
    callId: request.callId,
    ok: true,
    output: JSON.stringify(value),
    result: value as JsonValue,
    observedEffects: effects,
    actualEffects: effects,
    artifacts: [],
    diagnostics: [],
    evidence: [],
    startedAt,
    completedAt: new Date().toISOString()
  };
}

function requiredControl(context: { runtimeControl?: Parameters<RegisteredEffectTool["execute"]>[1]["runtimeControl"] }) {
  if (!context.runtimeControl) throw new Error("Runtime control port is unavailable.");
  return context.runtimeControl;
}

function controlError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

function readPlanTool(): RegisteredEffectTool {
  return {
    descriptor: descriptor("read_plan", "Read the durable plan DAG and optimistic revision.", {}),
    async execute(request, context) {
      return receipt(request, new Date().toISOString(), await requiredControl(context).readPlan(), ["runtime.control"]);
    }
  };
}

function updatePlanTool(): RegisteredEffectTool {
  return {
    descriptor: descriptor("update_plan", "Replace the durable plan DAG using optimistic revision control.", {
      expectedRevision: { type: "number" },
      goal: { type: "string" },
      activeNodeId: { type: "string" },
      nodes: { type: "array", items: { type: "object" }, maxItems: 128 }
    }, ["expectedRevision", "goal", "nodes"]),
    async execute(request, context) {
      const startedAt = new Date().toISOString();
      const input = object(request.arguments);
      if (!Number.isSafeInteger(input.expectedRevision)) throw new Error("expectedRevision must be an integer.");
      const plan = {
        revision: Number(input.expectedRevision) + 1,
        goal: input.goal,
        ...(typeof input.activeNodeId === "string" ? { activeNodeId: input.activeNodeId } : {}),
        nodes: input.nodes
      } as unknown;
      if (!isPlanGraph(plan)) throw new Error("Proposed plan is invalid, cyclic, or lacks required completion evidence.");
      const updated = await requiredControl(context).updatePlan({
        expectedRevision: Number(input.expectedRevision), plan: plan as PlanGraph
      });
      return receipt(request, startedAt, updated, ["runtime.control"]);
    }
  };
}

function budgetTool(): RegisteredEffectTool {
  return {
    descriptor: descriptor("read_budget", "Read shared hard budget limits, consumption and reservations when the next strategy materially depends on remaining budget; do not use it as a startup ritual.", {}),
    async execute(request, context) {
      return receipt(request, new Date().toISOString(), await requiredControl(context).readBudget(), ["runtime.control"]);
    }
  };
}

function checkpointTool(): RegisteredEffectTool {
  return {
    descriptor: descriptor("list_checkpoints", "List durable mutation checkpoints for this session.", {}),
    async execute(request, context) {
      return receipt(request, new Date().toISOString(), await requiredControl(context).listCheckpoints(), ["runtime.control"]);
    }
  };
}

function requestReviewTool(): RegisteredEffectTool {
  return {
    descriptor: descriptor(
      "request_review",
      "Eligible workspace changes receive internal review automatically after passed validation. Use this tool only when completion_status requests review or to retry a prior reviewer infrastructure/interruption failure. Supply no evidence IDs: the runtime selects the current frontier and validation. Genuine changes_requested findings must be addressed and revalidated first.",
      {}
    ),
    async execute(request, context) {
      const startedAt = new Date().toISOString();
      const result = await requiredControl(context).requestReview();
      const base = receipt(request, startedAt, result, ["runtime.control"]);
      return result.status === "validation_required" || result.status === "changes_required" ? {
        ...base,
        ok: false,
        diagnostics: [result.status === "validation_required"
          ? "review_validation_required" : "review_changes_required"]
      } : base;
    }
  };
}

function restoreRunChangesTool(): RegisteredEffectTool {
  const effects: ToolDescriptor["possibleEffects"] = [
    "runtime.control", "filesystem.write", "destructive", "checkpoint.restore"
  ];
  return {
    descriptor: {
      ...descriptor(
        "restore_run_changes",
        "Restore the latest sealed mutation checkpoint created by this run. The runtime freezes the target, checks LIFO safety, and does not create a nested checkpoint.",
        {},
        [],
        effects
      ),
      availableModes: ["change"],
      prepare: async (_argumentsValue, context): Promise<ToolCallPlan> => {
        const checkpoints = await requiredControl(context).listCheckpoints();
        const latest = [...checkpoints].reverse().find((item) => item.status !== "restored");
        if (!latest) throw controlError("The current session has no checkpoint to restore.", "checkpoint_missing");
        if (latest.status !== "sealed") {
          throw controlError("Resolve the open checkpoint before restoring run changes.", "checkpoint_recovery_required");
        }
        if (latest.runId !== context.runId) {
          throw controlError("The latest checkpoint was not created by the current run.", "checkpoint_run_mismatch");
        }
        const delta = latest.delta;
        const paths = delta
          ? [...new Set([...delta.added, ...delta.modified, ...delta.deleted])]
          : [];
        if (paths.length === 0) {
          throw controlError("The latest checkpoint contains no workspace changes.", "checkpoint_delta_empty");
        }
        return {
          exactEffects: effects,
          readPaths: paths,
          writePaths: paths,
          network: "none",
          processMode: "none",
          checkpointScope: paths,
          checkpointAction: { kind: "restore", checkpointId: latest.checkpointId },
          idempotence: "non_replayable"
        };
      }
    },
    async execute(request, context) {
      const startedAt = new Date().toISOString();
      const action = context.callPlan?.checkpointAction;
      if (!action || action.kind !== "restore") {
        throw controlError("A frozen checkpoint restore plan is required.", "checkpoint_action_invalid");
      }
      const restored = await requiredControl(context).restoreRunCheckpoint(action.checkpointId);
      if (!restored.delta) {
        throw controlError("The restored checkpoint has no workspace delta.", "checkpoint_delta_empty");
      }
      return {
        ...receipt(request, startedAt, {
          checkpointId: restored.checkpointId,
          status: restored.status
        }, effects),
        workspaceDelta: {
          added: [...restored.delta.deleted],
          modified: [...restored.delta.modified],
          deleted: [...restored.delta.added]
        }
      };
    }
  };
}

function loadSkillTool(): RegisteredEffectTool {
  return {
    descriptor: descriptor("load_skill", "Load a discovered skill's frozen instructions by qualified name.", {
      qualifiedName: { type: "string" }
    }, ["qualifiedName"], ["runtime.control", "filesystem.read"]),
    async execute(request, context) {
      const input = object(request.arguments);
      if (typeof input.qualifiedName !== "string" || !input.qualifiedName) throw new Error("qualifiedName is required.");
      const loaded = await requiredControl(context).loadSkill(input.qualifiedName);
      return {
        ...receipt(request, new Date().toISOString(), { content: loaded.content }, ["runtime.control", "filesystem.read"]),
        evidence: [loaded.evidence]
      };
    }
  };
}

export function registerControlTools(registry: EffectToolRegistry): EffectToolRegistry {
  for (const tool of [
    readPlanTool(), updatePlanTool(), budgetTool(), checkpointTool(), requestReviewTool(),
    restoreRunChangesTool(), loadSkillTool()
  ]) {
    registry.register(tool);
  }
  return registry;
}
