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

export class BrokerConnectionError extends BrokerError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, "broker_connection_error", undefined, options);
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

export class BrokerTimeoutError extends BrokerError {
  constructor(message: string) {
    super(message, "broker_timeout");
  }
}

const propagatedCancellationCodes = new Set([
  "run_deadline",
  "process_deadline",
  "process_idle_timeout",
  "steering_restart"
]);

export class BrokerCancelledError extends BrokerError {
  constructor(message = "Execution request cancelled.", options?: ErrorOptions) {
    const causeCode = (options?.cause as { code?: unknown } | undefined)?.code;
    const code = typeof causeCode === "string" && propagatedCancellationCodes.has(causeCode)
      ? causeCode : "broker_cancelled";
    super(message, code, undefined, options);
  }
}

export class BrokerProcessLostError extends BrokerError {
  constructor(handleId: string) {
    super(`Process '${handleId}' was lost when its broker connection ended.`, "process_lost", { handleId });
  }
}

export class BrokerOutputDecodingError extends BrokerError {
  constructor(stream: "stdout" | "stderr", diagnosticCode: "invalid_output_encoding" | "encoding_lossy", message: string) {
    super(message, diagnosticCode, { stream, diagnosticCode });
  }
}
