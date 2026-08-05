import type {
  JsonValue,
  ModelPlanUpdate,
  ModelPlanUpdateResult,
  ToolCallPlan,
  ToolDescriptor,
  ToolReceipt,
  ToolRequest
} from "agent-protocol";
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
  const output = JSON.stringify(value);
  return {
    callId: request.callId,
    ok: true,
    output,
    outcome: { status: "succeeded", output, diagnosticCodes: [] },
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
    descriptor: descriptor("read_plan", "Read the durable low-friction work checklist.", {}),
    async execute(request, context) {
      return receipt(request, new Date().toISOString(), await requiredControl(context).readWorkPlan(), ["runtime.control"]);
    }
  };
}

const UPDATE_PLAN_PROPERTIES: Record<string, JsonValue> = {
  explanation: { type: "string" },
  goal: { type: "string" },
  acceptanceCriteria: {
    type: "array",
    maxItems: 32,
    items: { type: "string" }
  },
  plan: {
    type: "array",
    minItems: 0,
    maxItems: 32,
    items: {
      type: "object",
      properties: {
        id: { type: "string" },
        step: { type: "string" },
        status: {
          type: "string",
          enum: ["pending", "in_progress", "blocked", "completed"]
        },
        blockedReason: { type: "string" }
      },
      required: ["step", "status"],
      additionalProperties: false
    }
  }
};

function updatePlanTool(): RegisteredEffectTool {
  return {
    descriptor: descriptor(
      "update_plan",
      "Update the durable work checklist only for work with several distinct milestones, multiple components, or substantial uncertainty; a focused inspect-edit-test fix does not require one. Keep 3-7 meaningful steps and update only at meaningful milestones or when evidence changes the approach, not after every small action. The runtime owns revisions, active-step normalization, dependencies, ownership, and evidence.",
      UPDATE_PLAN_PROPERTIES,
      ["plan"]
    ),
    async execute(request, context) {
      const startedAt = new Date().toISOString();
      const input = object(request.arguments);
      if (!Array.isArray(input.plan)) throw new Error("plan is required.");
      const updated = await requiredControl(context).updateWorkPlan({
        ...(typeof input.explanation === "string" ? { explanation: input.explanation } : {}),
        ...(typeof input.goal === "string" ? { goal: input.goal } : {}),
        ...(Array.isArray(input.acceptanceCriteria)
          ? { acceptanceCriteria: input.acceptanceCriteria.filter((item): item is string => typeof item === "string") }
          : {}),
        plan: input.plan
      } as unknown as ModelPlanUpdate);
      return receipt(
        request,
        startedAt,
        compactPlanUpdateResult(updated),
        ["runtime.control"]
      );
    }
  };
}

function compactPlanUpdateResult(updated: ModelPlanUpdateResult): JsonValue {
  return {
    status: updated.status,
    revision: updated.plan.revision,
    stepCount: updated.plan.plan.length,
    ...(updated.plan.activeStepId ? { activeStepId: updated.plan.activeStepId } : {}),
    warnings: updated.warnings.map((warning) => ({
      code: warning.code,
      message: warning.message,
      ...(warning.stepId ? { stepId: warning.stepId } : {})
    }))
  };
}

function workspaceFrontierTool(): RegisteredEffectTool {
  return {
    descriptor: descriptor(
      "read_workspace_frontier",
      "Page through the complete current changed-path frontier and its validation state. Cursors are bound to one frontier revision and fail if the frontier changes.",
      {
        cursor: { type: "string" },
        limit: { type: "number", minimum: 1, maximum: 500 }
      }
    ),
    async execute(request, context) {
      const input = object(request.arguments);
      return receipt(request, new Date().toISOString(), await requiredControl(context).readWorkspaceFrontier({
        ...(typeof input.cursor === "string" ? { cursor: input.cursor } : {}),
        ...(Number.isSafeInteger(input.limit) ? { limit: Number(input.limit) } : {})
      }), ["runtime.control"]);
    }
  };
}

function readArtifactTool(): RegisteredEffectTool {
  const effects: ToolDescriptor["possibleEffects"] = ["runtime.control", "filesystem.read"];
  return {
    descriptor: descriptor(
      "read_artifact",
      "Read a byte range from a large artifact referenced by a receipt in this session. Pass exactly the artifactId field from artifactRefs, without appending its name or size. Continue with nextOffset until eof.",
      {
        artifactId: { type: "string" },
        offsetBytes: { type: "number", minimum: 0 },
        maxBytes: { type: "number", minimum: 1, maximum: 65_536 }
      },
      ["artifactId"],
      effects
    ),
    async execute(request, context) {
      const input = object(request.arguments);
      if (typeof input.artifactId !== "string" || !input.artifactId) {
        throw new Error("artifactId is required.");
      }
      return receipt(request, new Date().toISOString(), await requiredControl(context).readArtifact({
        artifactId: input.artifactId,
        ...(Number.isSafeInteger(input.offsetBytes) ? { offsetBytes: Number(input.offsetBytes) } : {}),
        ...(Number.isSafeInteger(input.maxBytes) ? { maxBytes: Number(input.maxBytes) } : {})
      }), effects);
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
      "Request an independent review of the current mutation frontier only when the user asks, the change is high-risk or cross-cutting, or material uncertainty remains after validation; do not use it as a routine completion step for a focused change with direct evidence. Call it as a standalone tool. Supply no evidence IDs: the runtime binds the current frontier and objective receipts. The first substantive rejection opens one repair opportunity. In Standard mode unresolved findings remain advisory and must be reported honestly; in Strict mode an unchanged repeat or non-approved final review round ends with a typed verification failure.",
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

function requestStrategyTool(): RegisteredEffectTool {
  return {
    descriptor: descriptor(
      "request_strategy",
      "Request one optional fresh-context strategy reset when the current approach needs an independent hypothesis and next discriminating action. A later objective resource checkpoint may still occur; both are advisory and resource-capped.",
      {}
    ),
    async execute(request) {
      return receipt(request, new Date().toISOString(), {
        status: "strategy_requested"
      }, ["runtime.control"]);
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
    readPlanTool(), updatePlanTool(), budgetTool(), workspaceFrontierTool(), readArtifactTool(),
    checkpointTool(), requestReviewTool(), requestStrategyTool(),
    restoreRunChangesTool(), confirmRunRestoredTool(), loadSkillTool()
  ]) {
    registry.register(tool);
  }
  return registry;
}
