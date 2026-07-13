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

export interface RegisteredEffectTool {
  descriptor: ToolDescriptor;
  execute(request: ToolRequest, context: ToolExecutionContext): Promise<ToolReceipt>;
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

export async function prepareToolCallPlan(
  descriptor: ToolDescriptor,
  argumentsValue: JsonValue,
  context: ToolPreparationContext
): Promise<ToolCallPlan> {
  if (descriptor.prepare) return await descriptor.prepare(argumentsValue, context);
  const effects = maximumToolEffects(descriptor);
  const readPaths = pathArguments(argumentsValue, descriptor.contextPathArguments);
  const writePaths = pathArguments(argumentsValue, descriptor.writePathArguments);
  const mutates = effects.some((effect) => effect === "filesystem.write" || effect === "process.spawn"
    || effect === "destructive" || effect === "open_world");
  return {
    exactEffects: effects,
    readPaths,
    writePaths,
    network: effects.includes("network") ? "full" : "none",
    processMode: effects.some((effect) => effect === "process.spawn" || effect === "process.spawn.readonly") ? "pipe" : "none",
    checkpointScope: mutates ? (writePaths.length > 0 ? writePaths : ["."]) : [],
    idempotence: !mutates ? "read_only" : descriptor.idempotent ? "replay_safe" : "non_replayable"
  };
}

export class EffectToolRegistry implements ToolExecutor {
  private readonly tools = new Map<string, RegisteredEffectTool>();

  register(tool: RegisteredEffectTool): void {
    if (this.tools.has(tool.descriptor.name)) throw new Error(`Duplicate tool '${tool.descriptor.name}'.`);
    const maximumEffects = maximumToolEffects(tool.descriptor);
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
    return await prepareToolCallPlan(descriptor, request.arguments, context);
  }

  async execute(request: ToolRequest, context: ToolExecutionContext): Promise<ToolReceipt> {
    const tool = this.tools.get(request.name);
    if (!tool) throw new Error(`Unknown tool '${request.name}'.`);
    if (context.signal.aborted) throw context.signal.reason ?? new Error("Tool cancelled.");
    const receipt = await tool.execute(request, context);
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
