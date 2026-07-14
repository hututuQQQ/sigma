import {
  BrokerCancelledError,
  BrokerConnectionError,
  BrokerTimeoutError,
  attachBrokerLifecycleFailure,
  isBrokerGenerationTerminalError
} from "./errors.js";

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
