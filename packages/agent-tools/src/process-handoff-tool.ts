import { Socket } from "node:net";
import type { ProcessHandle } from "agent-execution";
import type { JsonValue, ToolReceipt, ToolRequest } from "agent-protocol";
import type { ExecutionToolOptions } from "./execution-tool-types.js";
import { executionArgs, executionText, executionToolSchema } from "./execution-tool-values.js";
import type { PlannedToolExecutionContext, RegisteredEffectTool } from "./registry.js";

function processHandle(input: Record<string, JsonValue>): ProcessHandle {
  return {
    id: executionText(input, "handleId"),
    brokerInstanceId: executionText(input, "brokerInstanceId")
  };
}

interface TcpReadinessProbe {
  host: "127.0.0.1" | "::1" | "localhost";
  port: number;
  timeoutMs: number;
}

function readinessError(message: string, cause?: unknown): Error {
  return Object.assign(
    cause === undefined ? new Error(message) : new Error(message, { cause }),
    { code: "process_readiness_failed" }
  );
}

function cancellationError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason : readinessError("Process readiness probe was cancelled.");
}

function readinessProbe(input: Record<string, JsonValue>): TcpReadinessProbe {
  const raw = input.readiness;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw Object.assign(new Error("Process handoff requires a TCP readiness probe."), {
      code: "tool_arguments_invalid"
    });
  }
  const host = raw.host === "::1" || raw.host === "localhost"
    ? raw.host : "127.0.0.1";
  return {
    host,
    port: Number(raw.port),
    timeoutMs: typeof raw.timeoutMs === "number" ? raw.timeoutMs : 3_000
  };
}

async function connectTcpOnce(
  probe: TcpReadinessProbe,
  timeoutMs: number,
  signal: AbortSignal
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = new Socket();
    let settled = false;
    const cleanup = (): void => {
      signal.removeEventListener("abort", onAbort);
      socket.removeAllListeners();
      socket.destroy();
    };
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onAbort = (): void => finish(cancellationError(signal));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    socket.setTimeout(Math.max(1, timeoutMs), () => finish(readinessError(
      `Process readiness probe timed out at ${probe.host}:${probe.port}.`
    )));
    socket.once("error", (error) => finish(readinessError(
      `Process readiness probe failed at ${probe.host}:${probe.port}.`, error
    )));
    socket.connect({ host: probe.host, port: probe.port }, () => finish());
  });
}

async function readinessRetryDelay(timeoutMs: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(cancellationError(signal));
      return;
    }
    const cleanup = (): void => {
      signal.removeEventListener("abort", onAbort);
      clearTimeout(timer);
    };
    const onAbort = (): void => {
      cleanup();
      reject(cancellationError(signal));
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, timeoutMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function probeTcpReadiness(
  probe: TcpReadinessProbe,
  signal: AbortSignal
): Promise<void> {
  const deadline = Date.now() + probe.timeoutMs;
  let lastError: unknown;
  do {
    const remaining = deadline - Date.now();
    try {
      await connectTcpOnce(probe, remaining, signal);
      return;
    } catch (error) {
      if (signal.aborted) throw cancellationError(signal);
      lastError = error;
    }
    const retryIn = Math.min(50, deadline - Date.now());
    if (retryIn > 0) await readinessRetryDelay(retryIn, signal);
  } while (Date.now() < deadline);
  throw readinessError(
    `Process endpoint ${probe.host}:${probe.port} was not ready within ${probe.timeoutMs} ms.`,
    lastError
  );
}

function handoffReceipt(request: ToolRequest, startedAt: string, value: unknown): ToolReceipt {
  const output = JSON.stringify(value);
  return {
    callId: request.callId,
    ok: true,
    output,
    outcome: { status: "succeeded", output, diagnosticCodes: [] },
    observedEffects: ["process.handoff"],
    actualEffects: ["process.handoff"],
    artifacts: [],
    diagnostics: [],
    evidence: [],
    startedAt,
    completedAt: new Date().toISOString()
  };
}

export function processHandoffTool(
  options: ExecutionToolOptions,
  handleProperties: Record<string, JsonValue>
): RegisteredEffectTool {
  return {
    descriptor: executionToolSchema(
      "process_handoff",
      "Verify and transfer in one call a TCP service that was explicitly started with lifecycle=deliverable and network=full. The runtime probes its loopback endpoint from the outer delivery boundary, then the broker performs the authoritative final process-liveness check during handoff. Session-lifecycle, exited, or unreachable processes cannot be handed off. The process can no longer be controlled through this session afterward.",
      {
        ...handleProperties,
        readiness: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["tcp"] },
            host: { type: "string", enum: ["127.0.0.1", "::1", "localhost"] },
            port: {
              type: "integer", minimum: 1, maximum: 65_535,
              description: "Loopback TCP port that consumers will use after handoff."
            },
            timeoutMs: {
              type: "integer", minimum: 100, maximum: 10_000,
              description: "Overall readiness window, including brief connection retries. Defaults to 3000 ms."
            }
          },
          required: ["kind", "port"],
          additionalProperties: false
        }
      },
      ["handleId", "brokerInstanceId", "readiness"],
      ["process.handoff"]
    ),
    async execute(request: ToolRequest, context: PlannedToolExecutionContext) {
      const startedAt = new Date().toISOString();
      if (!options.broker.handoff) {
        throw Object.assign(new Error("Process handoff is unavailable for this execution broker."), {
          code: "process_handoff_unavailable"
        });
      }
      const input = executionArgs(request.arguments);
      const handle = processHandle(input);
      const readiness = readinessProbe(input);
      await probeTcpReadiness(readiness, context.signal);
      // Do not poll here: polling consumes process output and could orphan
      // broker-spooled artifacts. Handoff refreshes the exact managed process
      // under its process lock and refuses it if it exited after the probe.
      const result = await options.broker.handoff(
        handle, { signal: context.signal }
      );
      return handoffReceipt(request, startedAt, {
        ...result,
        readiness: { kind: "tcp", ...readiness }
      });
    }
  };
}
