import {
  BrokerCancelledError,
  BrokerConnectionError,
  BrokerTimeoutError,
  attachBrokerLifecycleFailure,
  isBrokerGenerationTerminalError
} from "./errors.js";
import type { BrokerGeneration } from "./lazy-execution-broker-types.js";

export class ScratchLeaseLifecycle {
  private readonly sessions = new Set<string>();
  private readonly releases = new Map<string, Promise<void>>();

  acquired(sessionId: string): void {
    this.sessions.add(sessionId);
  }

  async release(sessionId: string, operation: () => Promise<void>): Promise<void> {
    // RuntimeSession teardown is allowed before a tool has ever needed scratch.
    // Do not start a broker, or require a capability, merely to release a lease
    // that this lazy broker never acquired.
    if (!this.sessions.has(sessionId)) return;
    const inFlight = this.releases.get(sessionId);
    if (inFlight) return await inFlight;
    const release = (async (): Promise<void> => {
      await operation();
      this.sessions.delete(sessionId);
    })();
    this.releases.set(sessionId, release);
    try {
      await release;
    } finally {
      if (this.releases.get(sessionId) === release) this.releases.delete(sessionId);
    }
  }

  clear(): void {
    this.sessions.clear();
    this.releases.clear();
  }
}

export function assertBrokerGenerationUsable(
  generation: BrokerGeneration,
  current: BrokerGeneration,
  closed: boolean
): void {
  if (closed) {
    throw new BrokerConnectionError("Execution broker is closed.", { retrySafe: true });
  }
  if (generation !== current || generation.failure || generation.retiring || generation.retired) {
    throw new BrokerConnectionError("Execution broker generation is not accepting new requests.", {
      cause: generation.failure,
      retrySafe: true,
      diagnostic: { generationId: generation.id }
    });
  }
}

export function cancellationError(signal: AbortSignal): BrokerCancelledError {
  const cause = signal.reason instanceof Error ? signal.reason : undefined;
  return new BrokerCancelledError(cause?.message ?? "Execution request cancelled.", { cause });
}

export async function awaitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return await promise;
  if (signal.aborted) throw cancellationError(signal);
  return await new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      cleanup();
      reject(cancellationError(signal));
    };
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => { cleanup(); resolve(value); },
      (error: unknown) => { cleanup(); reject(error); }
    );
  });
}

export function lifecycleFailure(error: unknown): error is BrokerConnectionError | BrokerTimeoutError {
  return error instanceof BrokerConnectionError || error instanceof BrokerTimeoutError;
}

export function errorIdentity(error: unknown): { name: string; code?: string } {
  if (!(error instanceof Error)) return { name: "NonError" };
  const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
  return { name: error.name, ...(code ? { code } : {}) };
}

export function preserveConnectionFailure(
  original: BrokerConnectionError | BrokerTimeoutError,
  retirementFailure: unknown
): BrokerConnectionError | BrokerTimeoutError {
  if (!(original instanceof BrokerConnectionError) || !original.retrySafe) {
    return attachBrokerLifecycleFailure(
      original, retirementFailure, "Execution broker generation retirement failed."
    ) as BrokerConnectionError | BrokerTimeoutError;
  }
  const failure = new BrokerConnectionError(original.message, {
    cause: original,
    retrySafe: false,
    diagnostic: {
      original: errorIdentity(original),
      retirement: errorIdentity(retirementFailure)
    }
  });
  return attachBrokerLifecycleFailure(
    failure, retirementFailure, "Execution broker generation retirement failed."
  ) as BrokerConnectionError;
}

export function retireTerminalGenerationError(
  error: unknown,
  retire: (terminalError: Error) => Promise<void>
): Promise<never> | undefined {
  if (!isBrokerGenerationTerminalError(error)) return undefined;
  return (async (): Promise<never> => {
    try {
      await retire(error);
    } catch (retirementFailure) {
      throw attachBrokerLifecycleFailure(
        error,
        retirementFailure,
        "Terminal execution broker generation retirement failed."
      );
    }
    throw error;
  })();
}
