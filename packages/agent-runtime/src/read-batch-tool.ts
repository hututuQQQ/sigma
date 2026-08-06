import type {
  JsonValue,
  ModelToolCall,
  ToolCallPlan,
  ToolDescriptor,
  ToolEffect,
  ToolReceipt
} from "agent-protocol";
import { maximumToolEffects } from "agent-tools";

export const READ_BATCH_TOOL_NAME = "read_batch";
export const MAX_READ_BATCH_CALLS = 8;

const ELIGIBLE_MAXIMUM_EFFECTS = new Set<ToolEffect>([
  "filesystem.read",
  "filesystem.read.external",
  "process.spawn.readonly"
]);
const ALLOWED_PLAN_EFFECTS = new Set<ToolEffect>([
  "filesystem.read",
  "process.spawn.readonly"
]);

export interface ReadBatchMember {
  call: ModelToolCall;
  descriptor: ToolDescriptor;
}

export function eligibleReadBatchDescriptors(
  descriptors: readonly ToolDescriptor[]
): ToolDescriptor[] {
  return descriptors.filter((descriptor) => {
    const effects = maximumToolEffects(descriptor);
    return descriptor.name !== READ_BATCH_TOOL_NAME
      && descriptor.approval === "auto"
      && effects.includes("filesystem.read")
      && effects.every((effect) => ELIGIBLE_MAXIMUM_EFFECTS.has(effect));
  });
}

export function readBatchDescriptor(
  descriptors: readonly ToolDescriptor[]
): ToolDescriptor | undefined {
  const eligible = eligibleReadBatchDescriptors(descriptors);
  if (eligible.length < 2) return undefined;
  return {
    name: READ_BATCH_TOOL_NAME,
    description:
      "Run 2-8 independent, read-only workspace inspection calls concurrently and return one bounded aggregate result. Call this tool alone. Nested calls still use their normal schemas, policies, budgets, tracing, and durable receipts. External reads, mutation, network, validation, control, and recursive batching are rejected.",
    inputSchema: {
      type: "object",
      properties: {
        calls: {
          type: "array",
          minItems: 2,
          maxItems: MAX_READ_BATCH_CALLS,
          items: {
            type: "object",
            properties: {
              name: {
                type: "string",
                enum: eligible.map((descriptor) => descriptor.name).sort()
              },
              arguments: { type: "object", additionalProperties: true }
            },
            required: ["name", "arguments"],
            additionalProperties: false
          }
        }
      },
      required: ["calls"],
      additionalProperties: false
    },
    possibleEffects: ["filesystem.read", "process.spawn.readonly"],
    maximumEffects: ["filesystem.read", "process.spawn.readonly"],
    availableModes: ["analyze", "change"],
    executionMode: "parallel",
    resourceKeys: [],
    approval: "auto",
    idempotent: true,
    timeoutMs: 120_000
  };
}

export function withReadBatchDescriptor(
  descriptors: readonly ToolDescriptor[]
): ToolDescriptor[] {
  const batch = readBatchDescriptor(descriptors);
  return batch ? [...descriptors, batch] : [...descriptors];
}

function object(value: JsonValue): Record<string, JsonValue> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, JsonValue> : null;
}

export function parseReadBatchMembers(
  outer: ModelToolCall,
  descriptors: readonly ToolDescriptor[]
): ReadBatchMember[] {
  const input = object(outer.arguments);
  const calls = input?.calls;
  if (!Array.isArray(calls) || calls.length < 2 || calls.length > MAX_READ_BATCH_CALLS) {
    throw Object.assign(new Error(
      `read_batch requires between 2 and ${MAX_READ_BATCH_CALLS} calls.`
    ), { code: "tool_arguments_invalid" });
  }
  const eligible = new Map(eligibleReadBatchDescriptors(descriptors)
    .map((descriptor) => [descriptor.name, descriptor]));
  return calls.map((value, index) => {
    const member = object(value);
    const name = member?.name;
    const argumentsValue = member?.arguments;
    if (typeof name !== "string" || !eligible.has(name)
      || !object(argumentsValue as JsonValue)) {
      throw Object.assign(new Error(
        `read_batch member ${index + 1} must name an offered read-only tool and provide object arguments.`
      ), { code: "tool_arguments_invalid" });
    }
    return {
      call: {
        id: `${outer.id}:read:${index + 1}`,
        name,
        arguments: argumentsValue as JsonValue
      },
      descriptor: eligible.get(name)!
    };
  });
}

export function readBatchPlanAllowed(plan: ToolCallPlan): boolean {
  return plan.idempotence === "read_only"
    && plan.network === "none"
    && plan.checkpointScope.length === 0
    && plan.writePaths.length === 0
    && plan.exactEffects.every((effect) => ALLOWED_PLAN_EFFECTS.has(effect));
}

function boundedMemberOutput(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  const marker = `\n...[${value.length - maximum} chars omitted]...\n`;
  const available = Math.max(0, maximum - marker.length);
  const head = Math.ceil(available / 2);
  const tail = available - head;
  return `${value.slice(0, head)}${marker}${tail > 0 ? value.slice(-tail) : ""}`;
}

export function readBatchReceipt(
  outer: ModelToolCall,
  members: readonly ReadBatchMember[],
  receipts: readonly ToolReceipt[],
  startedAt: string
): ToolReceipt {
  const completedAt = new Date().toISOString();
  const perMemberOutput = Math.max(640, Math.floor(8_000 / Math.max(1, receipts.length)));
  const calls = receipts.map((receipt, index) => ({
    index: index + 1,
    name: members[index]?.call.name ?? "tool",
    ok: receipt.ok,
    diagnostics: [...new Set([
      ...receipt.outcome.diagnosticCodes,
      ...receipt.diagnostics
    ])].slice(0, 8),
    output: boundedMemberOutput(receipt.output, perMemberOutput)
  }));
  const ok = receipts.length === members.length && receipts.every((receipt) => receipt.ok);
  const effects = [...new Set(receipts.flatMap((receipt) =>
    receipt.actualEffects ?? receipt.observedEffects))] as ToolEffect[];
  const artifactRefs = [...new Map(receipts.flatMap((receipt) =>
    receipt.artifactRefs ?? []).map((artifact) => [artifact.artifactId, artifact])).values()];
  const artifacts = [...new Set(receipts.flatMap((receipt) => receipt.artifacts))];
  const diagnostics = ok ? [] : ["batch_member_failed"];
  const output = JSON.stringify({ calls });
  return {
    callId: outer.id,
    ok,
    output,
    result: {
      count: calls.length,
      succeeded: calls.filter((call) => call.ok).length,
      failed: calls.filter((call) => !call.ok).length,
      calls: calls.map(({ index, name, ok: memberOk, diagnostics: memberDiagnostics }) => ({
        index, name, ok: memberOk, diagnostics: memberDiagnostics
      }))
    },
    outcome: { status: ok ? "succeeded" : "failed", output, diagnosticCodes: diagnostics },
    observedEffects: effects,
    actualEffects: effects,
    artifacts,
    ...(artifactRefs.length > 0 ? { artifactRefs } : {}),
    diagnostics,
    // Nested evidence is emitted with each durable nested receipt. Repeating
    // it on the aggregate would duplicate ledger events and model metadata.
    evidence: [],
    startedAt,
    completedAt
  };
}
