export class McpProtocolError extends Error {
  override name = "McpProtocolError";
}

export class McpConnectionError extends Error {
  override name = "McpConnectionError";
}

export class McpRpcError extends Error {
  override name = "McpRpcError";

  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown
  ) {
    super(message);
  }
}

export class McpTimeoutError extends Error {
  override name = "TimeoutError";

  constructor(
    public readonly timeoutKind: "idle" | "deadline",
    message: string
  ) {
    super(message);
  }
}

export class McpCancelledError extends Error {
  override name = "AbortError";

  constructor(message = "MCP request cancelled.", options?: ErrorOptions) {
    super(message, options);
  }
}
