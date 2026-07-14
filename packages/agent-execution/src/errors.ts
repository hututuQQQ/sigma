export class BrokerError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly data?: unknown,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class BrokerProtocolError extends BrokerError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, "broker_protocol_error", undefined, options);
  }
}

export interface BrokerConnectionErrorOptions extends ErrorOptions {
  /** True only when the request was rejected before any frame could be dispatched. */
  retrySafe?: boolean;
  diagnostic?: unknown;
}

export class BrokerConnectionError extends BrokerError {
  readonly retrySafe: boolean;

  constructor(message: string, options?: BrokerConnectionErrorOptions) {
    super(message, "broker_connection_error", options?.diagnostic, options);
    this.retrySafe = options?.retrySafe === true;
  }
}

export class SandboxUnavailableError extends BrokerError {
  constructor(message: string, data?: unknown) {
    super(message, "sandbox_unavailable", data);
  }
}

export class BrokerPolicyError extends BrokerError {
  constructor(message: string, data?: unknown) {
    super(message, "policy_denied", data);
  }
}

export class BrokerExecutableUnavailableError extends BrokerError {
  constructor(message: string, data?: unknown) {
    super(message, "executable_unavailable", data);
  }
}

export class BrokerToolchainEnvironmentConflictError extends BrokerError {
  constructor(name: string, toolchainId: string) {
    super(
      `Environment key '${name}' conflicts with trusted toolchain '${toolchainId}'.`,
      "toolchain_environment_conflict",
      { name, toolchainId }
    );
  }
}

export class BrokerToolchainUnavailableError extends BrokerError {
  constructor(toolchainId: string, reason: string) {
    super(
      `Trusted toolchain '${toolchainId}' is unavailable: ${reason}`,
      "toolchain_unavailable",
      { toolchainId, reason }
    );
  }
}

export interface BrokerTimeoutErrorOptions extends ErrorOptions {
  /** True only when the timed-out frame was still queued and never dispatched. */
  preDispatch?: boolean;
}

export class BrokerTimeoutError extends BrokerError {
  readonly preDispatch: boolean;

  constructor(message: string, options?: BrokerTimeoutErrorOptions) {
    super(message, "broker_timeout", undefined, options);
    this.preDispatch = options?.preDispatch === true;
  }
}

const propagatedCancellationCodes = new Set([
  "run_deadline",
  "process_deadline",
  "process_idle_timeout",
  "steering_restart"
]);

export interface BrokerCancelledErrorOptions extends ErrorOptions {
  /** True only when the cancelled frame was still queued and never dispatched. */
  preDispatch?: boolean;
}

export class BrokerCancelledError extends BrokerError {
  readonly preDispatch: boolean;

  constructor(message = "Execution request cancelled.", options?: BrokerCancelledErrorOptions) {
    const causeCode = (options?.cause as { code?: unknown } | undefined)?.code;
    const code = typeof causeCode === "string" && propagatedCancellationCodes.has(causeCode)
      ? causeCode : "broker_cancelled";
    super(message, code, undefined, options);
    this.preDispatch = options?.preDispatch === true;
  }
}

export class BrokerProcessLostError extends BrokerError {
  constructor(handleId: string, options?: ErrorOptions) {
    super(`Process '${handleId}' was lost when its broker connection ended.`, "process_lost", { handleId }, options);
  }
}

export class BrokerOutputDecodingError extends BrokerError {
  constructor(stream: "stdout" | "stderr", diagnosticCode: "invalid_output_encoding" | "encoding_lossy", message: string) {
    super(message, diagnosticCode, { stream, diagnosticCode });
  }
}

const terminalBrokerErrors = new WeakSet<Error>();

/** Marks an operation error whose broker generation has already become unusable. */
export function markBrokerGenerationTerminal<T extends Error>(error: T): T {
  terminalBrokerErrors.add(error);
  return error;
}

/** True when preserving this operation error still requires retiring its generation. */
export function isBrokerGenerationTerminalError(error: unknown): error is Error {
  return error instanceof Error && terminalBrokerErrors.has(error);
}

/** Preserve the primary error identity while recording a failed containment step. */
export function attachBrokerLifecycleFailure(
  primary: Error,
  lifecycle: unknown,
  message: string
): Error {
  const previous = primary.cause;
  if (previous === lifecycle
    || (previous instanceof AggregateError && previous.errors.includes(lifecycle))) {
    return primary;
  }
  const causes = previous === undefined ? [lifecycle] : [previous, lifecycle];
  Object.defineProperty(primary, "cause", {
    configurable: true,
    value: new AggregateError(causes, message, { cause: lifecycle })
  });
  return primary;
}
