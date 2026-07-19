export class OciEngineApiError extends Error {
  constructor(
    message: string,
    readonly operation: string,
    readonly statusCode?: number,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "OciEngineApiError";
  }
}

export class OciEngineCapabilityError extends OciEngineApiError {
  constructor(
    readonly capability: string,
    message: string,
    operation: string,
    statusCode?: number,
    options?: ErrorOptions
  ) {
    super(message, operation, statusCode, options);
    this.name = "OciEngineCapabilityError";
  }
}
