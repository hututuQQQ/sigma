import type {
  ExecutionBroker,
  ProcessHandle,
  ProcessPollResult
} from "agent-execution";
import type { JsonValue } from "agent-protocol";

export const DEFAULT_EXECUTION_YIELD_MS = 10_000;
export const DEFAULT_PROCESS_POLL_YIELD_MS = 30_000;
export const MAXIMUM_PROCESS_YIELD_MS = 30_000;
export const MAXIMUM_PROCESS_POLL_YIELD_MS = 300_000;
const PROCESS_POLL_INTERVAL_MS = 250;

export function processYieldMs(
  input: Record<string, JsonValue>,
  fallback: number,
  maximum = MAXIMUM_PROCESS_YIELD_MS
): number {
  const value = input.yieldMs;
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value)
    || Number(value) < 0
    || Number(value) > maximum) {
    throw Object.assign(new Error(
      `yieldMs must be an integer from 0 to ${String(maximum)}.`
    ), { code: "tool_arguments_invalid" });
  }
  return Number(value);
}

function cancellationError(signal: AbortSignal): unknown {
  return signal.reason ?? Object.assign(new Error("Process wait cancelled."), {
    code: "tool_cancelled"
  });
}

async function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (milliseconds <= 0) return;
  if (signal.aborted) throw cancellationError(signal);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", aborted);
      resolve();
    }, milliseconds);
    const aborted = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", aborted);
      reject(cancellationError(signal));
    };
    signal.addEventListener("abort", aborted, { once: true });
  });
}

function mergeProcessResults(
  previous: ProcessPollResult | undefined,
  current: ProcessPollResult
): ProcessPollResult {
  if (!previous) return current;
  return {
    ...current,
    stdout: `${previous.stdout}${current.stdout}`,
    stderr: `${previous.stderr}${current.stderr}`,
    stdoutDroppedBytes:
      previous.stdoutDroppedBytes + current.stdoutDroppedBytes,
    stderrDroppedBytes:
      previous.stderrDroppedBytes + current.stderrDroppedBytes,
    outputTruncated:
      previous.outputTruncated || current.outputTruncated,
    outputArtifacts: [
      ...(previous.outputArtifacts ?? []),
      ...(current.outputArtifacts ?? [])
    ],
    outputDecodingErrors: [
      ...(previous.outputDecodingErrors ?? []),
      ...(current.outputDecodingErrors ?? [])
    ],
    failure: current.failure ?? previous.failure
  };
}

export async function pollProcessUntilYield(
  broker: ExecutionBroker,
  handle: ProcessHandle,
  yieldMs: number,
  signal: AbortSignal
): Promise<ProcessPollResult> {
  const deadline = Date.now() + yieldMs;
  let accumulated: ProcessPollResult | undefined;
  while (true) {
    const current = await broker.poll(handle, { signal });
    accumulated = mergeProcessResults(accumulated, current);
    if (current.state !== "running" || Date.now() >= deadline) {
      return accumulated;
    }
    await delay(
      Math.min(PROCESS_POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())),
      signal
    );
  }
}
