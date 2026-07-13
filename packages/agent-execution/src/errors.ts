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

export class BrokerTimeoutError extends BrokerError {
  constructor(message: string) {
    super(message, "broker_timeout");
  }
}

export class BrokerCancelledError extends BrokerError {
  constructor(message = "Execution request cancelled.", options?: ErrorOptions) {
    super(message, "broker_cancelled", undefined, options);
  }
}

export class BrokerProcessLostError extends BrokerError {
  constructor(handleId: string) {
    super(`Process '${handleId}' was lost when its broker connection ended.`, "process_lost", { handleId });
  }
}
