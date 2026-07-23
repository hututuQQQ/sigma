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
      "Request an independent review of the current mutation frontier. Supply no evidence IDs: the runtime binds the current frontier, structural validation records, and latest completion candidate. A failed or unavailable review is returned as an ordinary receipt; choose the next step yourself.",
      {}
    ),
    async execute(request, context) {
      const startedAt = new Date().toISOString();
      const result = await requiredControl(context).requestReview();
      const base = receipt(request, startedAt, result, ["runtime.control"]);
      return result.status === "validation_required" || result.status === "changes_required"
        || result.status === "review_unavailable" ? {
        ...base,
        ok: false,
        diagnostics: [result.status === "validation_required" ? "review_validation_required"
          : result.status === "changes_required" ? "review_changes_required" : "review_unavailable"]
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
        "Atomically restore every sealed mutation checkpoint created by this run. The runtime verifies the complete LIFO postimage chain and does not create a nested checkpoint.",
        {},
        [],
        effects
      ),
      availableModes: ["change"],
      prepare: async (_argumentsValue, context): Promise<ToolCallPlan> => {
        const checkpoints = await requiredControl(context).listCheckpoints();
        const unresolved = checkpoints.filter((item) => item.status !== "restored");
        const latest = unresolved.at(-1);
        if (!latest) throw controlError("The current session has no checkpoint to restore.", "checkpoint_missing");
        if (latest.status !== "sealed") {
          throw controlError("Resolve the open checkpoint before restoring run changes.", "checkpoint_recovery_required");
        }
        const first = unresolved.findIndex((item) => item.runId === context.runId);
        if (first < 0 || unresolved.slice(first).some((item) => item.runId !== context.runId)) {
          throw controlError("The current run is not the latest restorable checkpoint group.", "checkpoint_run_mismatch");
        }
        const targets = unresolved.slice(first);
        if (targets.some((item) => item.status !== "sealed" || !item.delta)) {
          throw controlError("All current-run checkpoints must be sealed before restoration.", "checkpoint_not_sealed");
        }
        const paths = [...new Set(targets.flatMap((item) => item.delta
          ? [...item.delta.added, ...item.delta.modified, ...item.delta.deleted] : []))].sort();
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
      const restoration = await requiredControl(context).restoreRunChanges(request.callId);
      const restored = (await requiredControl(context).listCheckpoints())
        .filter((item) => restoration.restoredCheckpointIds.includes(item.checkpointId));
      const delta = inverseRunDelta(restored);
      return {
        ...receipt(request, startedAt, {
          checkpointIds: restoration.restoredCheckpointIds,
          status: "restored",
          restoration
        }, effects),
        workspaceDelta: delta
      };
    }
  };
}

function inverseRunDelta(checkpoints: readonly import("agent-protocol").CheckpointRef[]): {
  added: string[]; modified: string[]; deleted: string[];
} {
  const states = new Map<string, "added" | "modified" | "deleted">();
  for (const checkpoint of checkpoints) {
    if (!checkpoint.delta) continue;
    for (const path of checkpoint.delta.added) {
      const before = states.get(path);
      states.set(path, before === "deleted" || before === "modified" ? "modified" : "added");
    }
    for (const path of checkpoint.delta.modified) if (states.get(path) !== "added") states.set(path, "modified");
    for (const path of checkpoint.delta.deleted) {
      if (states.get(path) === "added") states.delete(path);
      else states.set(path, "deleted");
    }
  }
  return {
    added: [...states].filter(([, state]) => state === "deleted").map(([path]) => path).sort(),
    modified: [...states].filter(([, state]) => state === "modified").map(([path]) => path).sort(),
    deleted: [...states].filter(([, state]) => state === "added").map(([path]) => path).sort()
  };
}

function confirmRunRestoredTool(): RegisteredEffectTool {
  const effects: ToolDescriptor["possibleEffects"] = ["runtime.control", "filesystem.read"];
  return {
    descriptor: {
      ...descriptor(
        "confirm_run_restored",
        "Confirm that a user-steered run is quiescent and its workspace exactly matches the recorded pre-run baseline. This does not mutate the workspace.",
        {},
        [],
        effects
      ),
      availableModes: ["change"]
    },
    async execute(request, context) {
      const startedAt = new Date().toISOString();
      const restoration = await requiredControl(context).confirmRunRestored(request.callId);
      return receipt(request, startedAt, restoration, effects);
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
    restoreRunChangesTool(), confirmRunRestoredTool(), loadSkillTool()
  ]) {
    registry.register(tool);
  }
  return registry;
}
