import type {
  JsonValue,
  PlanGraph,
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
    observedEffects: effects,
    actualEffects: effects,
    artifacts: [],
    diagnostics: [],
    evidence: [],
    startedAt,
    completedAt: new Date().toISOString()
  };
}

function requiredControl(context: Parameters<RegisteredEffectTool["execute"]>[1]) {
  if (!context.runtimeControl) throw new Error("Runtime control port is unavailable.");
  return context.runtimeControl;
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
    descriptor: descriptor("read_budget", "Read shared hard budget limits, consumption and reservations.", {}),
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
  for (const tool of [readPlanTool(), updatePlanTool(), budgetTool(), checkpointTool(), loadSkillTool()]) {
    registry.register(tool);
  }
  return registry;
}
