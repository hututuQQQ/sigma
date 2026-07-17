import type {
  JsonValue,
  ModelToolCall,
  ToolCallPlan,
  ToolReceipt
} from "agent-protocol";
import type { RuntimeSession } from "./types.js";
import type { RuntimeEventEmitter } from "./runtime-event-emitter.js";

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw Object.assign(new Error(`${label} must be an object.`), { code: "tool_protocol_error" });
  }
  return value as Record<string, unknown>;
}

function receiptOutput(receipt: ToolReceipt): Record<string, unknown> {
  try {
    return object(JSON.parse(receipt.output) as JsonValue, "Process tool output");
  } catch (error) {
    if ((error as { code?: unknown })?.code === "tool_protocol_error") throw error;
    throw Object.assign(new Error("Process tool returned invalid JSON output.", { cause: error }), {
      code: "tool_protocol_error"
    });
  }
}

function processId(value: Record<string, unknown>): string {
  const direct = value.id;
  const nested = value.handle;
  const id = typeof direct === "string"
    ? direct
    : nested && typeof nested === "object" && !Array.isArray(nested)
      ? (nested as Record<string, unknown>).id
      : undefined;
  if (typeof id !== "string" || id.length === 0) {
    throw Object.assign(new Error("Process tool output is missing its process handle."), {
      code: "tool_protocol_error"
    });
  }
  return id;
}

async function outputEvents(
  session: RuntimeSession,
  id: string,
  value: Record<string, unknown>,
  emit: RuntimeEventEmitter
): Promise<void> {
  for (const stream of ["stdout", "stderr"] as const) {
    const chunk = value[stream];
    if (typeof chunk === "string" && chunk.length > 0) {
      await emit(session, "process.output", "runtime", { processId: id, stream, chunk });
    }
  }
}

async function recordSpawnedProcess(
  session: RuntimeSession,
  call: ModelToolCall,
  plan: ToolCallPlan,
  value: Record<string, unknown>,
  id: string,
  emit: RuntimeEventEmitter
): Promise<void> {
  const brokerInstanceId = typeof value.brokerInstanceId === "string" ? value.brokerInstanceId : "unknown";
  session.execution.processHandles ??= new Map();
  session.execution.processHandles.set(id, {
    id,
    brokerInstanceId,
    ...(typeof value.systemProcessId === "number" ? { systemProcessId: value.systemProcessId } : {}),
    lifecycle: value.lifecycle === "deliverable" ? "deliverable" : "session"
  });
  await emit(session, "process.spawned", "runtime", {
    processId: id,
    executionId: call.id,
    mode: plan.processMode === "pty" ? "pty" : "background",
    brokerInstanceId,
    lifecycle: value.lifecycle === "deliverable" ? "deliverable" : "session"
  });
}

async function recordPolledProcess(
  session: RuntimeSession,
  value: Record<string, unknown>,
  id: string,
  emit: RuntimeEventEmitter
): Promise<void> {
  await outputEvents(session, id, value, emit);
  if (value.state === "running") return;
  session.execution.processHandles?.delete(id);
  await emit(session, "process.exited", "runtime", {
    processId: id,
    exitCode: typeof value.exitCode === "number" ? value.exitCode : null,
    ...(typeof value.signal === "string" ? { signal: value.signal } : {}),
    state: typeof value.state === "string" ? value.state : "exited"
  });
}

export async function recordProcessReceipt(
  session: RuntimeSession,
  call: ModelToolCall,
  plan: ToolCallPlan,
  receipt: ToolReceipt,
  emit: RuntimeEventEmitter
): Promise<void> {
  if (call.name !== "process_spawn" && call.name !== "process_poll"
    && call.name !== "process_terminate" && call.name !== "process_handoff") return;
  const value = receiptOutput(receipt);
  const id = processId(value);
  if (call.name === "process_spawn") {
    await recordSpawnedProcess(session, call, plan, value, id, emit);
    return;
  }
  if (call.name === "process_handoff") {
    session.execution.processHandles?.delete(id);
    await emit(session, "process.handed_off", "runtime", {
      processId: id,
      handoffId: typeof value.handoffId === "string" ? value.handoffId : `handoff:${id}`,
      ...(typeof value.systemProcessId === "number" ? { systemProcessId: value.systemProcessId } : {})
    });
    return;
  }
  await recordPolledProcess(session, value, id, emit);
}

export async function recordLostProcess(
  session: RuntimeSession,
  call: ModelToolCall,
  error: unknown,
  emit: RuntimeEventEmitter
): Promise<void> {
  if ((error as { code?: unknown })?.code !== "process_lost") return;
  const data = (error as { data?: unknown }).data;
  const errorId = data && typeof data === "object" && !Array.isArray(data)
    ? (data as Record<string, unknown>).handleId : undefined;
  const args = call.arguments && typeof call.arguments === "object" && !Array.isArray(call.arguments)
    ? call.arguments as Record<string, JsonValue> : {};
  const id = typeof errorId === "string" ? errorId : args.handleId;
  if (typeof id !== "string" || id.length === 0) return;
  session.execution.processHandles?.delete(id);
  await emit(session, "process.lost", "runtime", {
    processId: id,
    reason: error instanceof Error ? error.message : "The process broker connection was lost."
  });
}
