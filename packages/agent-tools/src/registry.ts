import type {
  RunMode,
  JsonValue,
  ToolCallPlan,
  ToolDescriptor,
  ToolEffect,
  ToolExecutionContext,
  ToolExecutor,
  ToolPreparationContext,
  ToolReceipt,
  ToolRequest
} from "agent-protocol";
import { assertDescriptorArguments } from "./tool-argument-validation.js";

export interface RegisteredEffectTool {
  descriptor: ToolDescriptor;
  execute(request: ToolRequest, context: PlannedToolExecutionContext): Promise<ToolReceipt>;
}

export interface PlannedToolExecutionContext extends ToolExecutionContext {
  /** The immutable plan prepared and approved for this exact call. Effect tools
   * must use this plan, rather than reparsing model arguments, as their
   * execution authority. Undefined only for legacy direct executor callers. */
  callPlan?: ToolCallPlan;
}

interface PreparedPlan {
  name: string;
  argumentsSignature: string;
  plan: ToolCallPlan;
}

function argumentsSignature(value: JsonValue): string {
  return JSON.stringify(value);
}

function preparedPlanKey(
  context: Pick<ToolPreparationContext, "sessionId" | "runId">,
  callId: string
): string {
  return `${context.sessionId}\0${context.runId}\0${callId}`;
}

function preparedPlanMismatch(
  prepared: PreparedPlan | undefined,
  request: ToolRequest
): boolean {
  return Boolean(prepared && (prepared.name !== request.name
    || prepared.argumentsSignature !== argumentsSignature(request.arguments)));
}

export function isToolAllowed(descriptor: ToolDescriptor, mode: RunMode): boolean {
  if (descriptor.approval === "deny") return false;
  if (descriptor.availableModes) return descriptor.availableModes.includes(mode);
  if (mode === "change") return true;
  const denied: ToolEffect[] = ["filesystem.write", "process.spawn", "destructive"];
  return !descriptor.possibleEffects.some((effect) => denied.includes(effect));
}

function pathArguments(argumentsValue: JsonValue, keys: readonly string[] | undefined): string[] {
  if (!keys || !argumentsValue || typeof argumentsValue !== "object" || Array.isArray(argumentsValue)) return [];
  const values = argumentsValue as Record<string, JsonValue>;
  return [...new Set(keys.flatMap((key) => typeof values[key] === "string" ? [values[key] as string] : []))];
}

export function maximumToolEffects(descriptor: ToolDescriptor): ToolEffect[] {
  return [...(descriptor.maximumEffects ?? descriptor.possibleEffects)];
}

function planError(message: string): Error {
  return Object.assign(new Error(message), { code: "effect_plan_invalid" });
}

function assertPlanEffects(descriptor: ToolDescriptor, plan: ToolCallPlan): void {
  if (!plan || !Array.isArray(plan.exactEffects)) {
    throw planError(`Tool '${descriptor.name}' returned an invalid effect plan.`);
  }
  const maximum = new Set(maximumToolEffects(descriptor));
  const outside = plan.exactEffects.filter((effect, index) =>
    !maximum.has(effect) || plan.exactEffects.indexOf(effect) !== index);
  if (outside.length > 0) {
    throw planError(
      `Tool '${descriptor.name}' planned undeclared or duplicated effects: ${[...new Set(outside)].join(", ")}.`
    );
  }
}

export async function prepareToolCallPlan(
  descriptor: ToolDescriptor,
  argumentsValue: JsonValue,
  context: ToolPreparationContext
): Promise<ToolCallPlan> {
  assertDescriptorArguments(descriptor, argumentsValue);
  const plan = descriptor.prepare
    ? await descriptor.prepare(argumentsValue, context)
    : (() => {
        const effects = maximumToolEffects(descriptor);
        const readPaths = pathArguments(argumentsValue, descriptor.contextPathArguments);
        const writePaths = pathArguments(argumentsValue, descriptor.writePathArguments);
        const mutates = effects.some((effect) => effect === "filesystem.write" || effect === "process.spawn"
          || effect === "destructive" || effect === "open_world");
        return {
          exactEffects: effects,
          readPaths,
          writePaths,
          network: effects.includes("network") ? "full" as const : "none" as const,
          processMode: effects.some((effect) => effect === "process.spawn" || effect === "process.spawn.readonly")
            ? "pipe" as const : "none" as const,
          checkpointScope: mutates ? (writePaths.length > 0 ? writePaths : ["."]) : [],
          idempotence: !mutates ? "read_only" as const : descriptor.idempotent ? "replay_safe" as const : "non_replayable" as const
        };
      })();
  assertPlanEffects(descriptor, plan);
  return plan;
}

export class EffectToolRegistry implements ToolExecutor {
  private readonly tools = new Map<string, RegisteredEffectTool>();
  private readonly preparedPlans = new Map<string, PreparedPlan>();

  register(tool: RegisteredEffectTool): void {
    if (this.tools.has(tool.descriptor.name)) throw new Error(`Duplicate tool '${tool.descriptor.name}'.`);
    const maximumEffects = maximumToolEffects(tool.descriptor);
    const missing = tool.descriptor.possibleEffects.filter((effect) => !maximumEffects.includes(effect));
    if (missing.length > 0) {
      throw new Error(`Tool '${tool.descriptor.name}' possible effects exceed maximumEffects: ${missing.join(", ")}.`);
    }
    const availableModes = tool.descriptor.availableModes ?? (["analyze", "change"] as RunMode[]).filter((mode) => {
      if (mode === "change") return true;
      return !maximumEffects.some((effect) => ["filesystem.write", "process.spawn", "destructive"].includes(effect));
    });
    this.tools.set(tool.descriptor.name, {
      ...tool,
      descriptor: { ...tool.descriptor, maximumEffects, availableModes }
    });
  }

  descriptors(): readonly ToolDescriptor[] {
    return [...this.tools.values()].map((tool) => tool.descriptor).sort((left, right) => left.name.localeCompare(right.name));
  }

  descriptor(name: string): ToolDescriptor | undefined {
    return this.tools.get(name)?.descriptor;
  }

  async prepare(request: ToolRequest, context: ToolPreparationContext): Promise<ToolCallPlan> {
    const descriptor = this.tools.get(request.name)?.descriptor;
    if (!descriptor) throw new Error(`Unknown tool '${request.name}'.`);
    const plan = await prepareToolCallPlan(descriptor, request.arguments, context);
    const key = preparedPlanKey(context, request.callId);
    this.preparedPlans.set(key, {
      name: request.name,
      argumentsSignature: argumentsSignature(request.arguments),
      plan
    });
    // An approval can be denied without executing the tool. Keep this
    // call-bound cache bounded while preserving the newest prepared calls.
    if (this.preparedPlans.size > 2_048) {
      const oldest = this.preparedPlans.keys().next().value;
      if (typeof oldest === "string") this.preparedPlans.delete(oldest);
    }
    return plan;
  }

  async execute(request: ToolRequest, context: ToolExecutionContext): Promise<ToolReceipt> {
    const tool = this.tools.get(request.name);
    if (!tool) throw new Error(`Unknown tool '${request.name}'.`);
    if (context.signal.aborted) throw context.signal.reason ?? new Error("Tool cancelled.");
    const key = preparedPlanKey(context, request.callId);
    const prepared = this.preparedPlans.get(key);
    if (prepared) this.preparedPlans.delete(key);
    assertDescriptorArguments(tool.descriptor, request.arguments);
    if (!context.callPlan && preparedPlanMismatch(prepared, request)) {
      throw Object.assign(new Error("Tool arguments changed after the call plan was prepared."), {
        code: "write_plan_invalid"
      });
    }
    const approvedPlan = context.callPlan ?? prepared?.plan;
    if (approvedPlan) assertPlanEffects(tool.descriptor, approvedPlan);
    const receipt = await tool.execute(request, {
      ...context,
      ...(approvedPlan ? { callPlan: approvedPlan } : {})
    });
    return {
      ...receipt,
      outcome: receipt.outcome ?? {
        status: receipt.ok ? "succeeded" : "failed",
        output: receipt.output,
        diagnosticCodes: [...receipt.diagnostics]
      },
      actualEffects: receipt.actualEffects ?? receipt.observedEffects,
      evidence: receipt.evidence ?? []
    };
  }
}
