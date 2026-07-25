import {
  SandboxUnavailableError,
  type ExecutionBroker
} from "agent-execution";
import type {
  ToolDescriptor,
  ToolReceipt,
  ToolRequest
} from "agent-protocol";

export function simpleExecutionReceipt(
  request: ToolRequest,
  startedAt: string,
  value: unknown,
  effects: ToolDescriptor["possibleEffects"]
): ToolReceipt {
  return {
    callId: request.callId,
    ok: true,
    output: JSON.stringify(value),
    outcome: { status: "succeeded", output: JSON.stringify(value), diagnosticCodes: [] },
    observedEffects: effects,
    actualEffects: effects,
    artifacts: [],
    diagnostics: [],
    evidence: [],
    startedAt,
    completedAt: new Date().toISOString()
  };
}

export function unavailableExecutionBroker(
  message = "sigma-exec broker is not configured"
): ExecutionBroker {
  const fail = async (): Promise<never> => {
    throw new SandboxUnavailableError(message);
  };
  return {
    lostProcessHandles: [],
    connect: fail,
    doctor: fail,
    execute: fail,
    spawn: fail,
    poll: fail,
    write: fail,
    terminate: fail,
    close: async () => undefined
  };
}
