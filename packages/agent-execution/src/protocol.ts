import { BrokerProtocolError } from "./errors.js";
import { BROKER_PROTOCOL_VERSION } from "./types.js";

export interface BrokerRequestEnvelope {
  protocolVersion: typeof BROKER_PROTOCOL_VERSION;
  requestId: number;
  method: string;
  params: Record<string, unknown>;
}

export interface BrokerRpcErrorValue {
  code: string;
  message: string;
  data?: unknown;
}

export interface BrokerResponseEnvelope {
  protocolVersion: typeof BROKER_PROTOCOL_VERSION;
  requestId: number;
  ok: boolean;
  result?: unknown;
  error?: BrokerRpcErrorValue;
}

export function brokerRequest(requestId: number, method: string, params: Record<string, unknown>): BrokerRequestEnvelope {
  return { protocolVersion: BROKER_PROTOCOL_VERSION, requestId, method, params };
}

function record(input: unknown, label: string): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new BrokerProtocolError(`${label} must be an object.`);
  }
  return input as Record<string, unknown>;
}

export function parseBrokerResponse(input: unknown): BrokerResponseEnvelope {
  const value = record(input, "Broker response");
  if (value.protocolVersion !== BROKER_PROTOCOL_VERSION) {
    throw new BrokerProtocolError(`Unsupported broker protocol version '${String(value.protocolVersion)}'.`);
  }
  if (!Number.isSafeInteger(value.requestId) || (value.requestId as number) <= 0) {
    throw new BrokerProtocolError("Broker response requestId must be a positive safe integer.");
  }
  if (typeof value.ok !== "boolean") throw new BrokerProtocolError("Broker response ok must be boolean.");
  if (value.ok) {
    if ("error" in value) throw new BrokerProtocolError("Successful broker response cannot contain error.");
    return value as unknown as BrokerResponseEnvelope;
  }
  if ("result" in value) throw new BrokerProtocolError("Failed broker response cannot contain result.");
  const error = record(value.error, "Broker response error");
  if (typeof error.code !== "string" || typeof error.message !== "string") {
    throw new BrokerProtocolError("Broker response error requires string code and message.");
  }
  return value as unknown as BrokerResponseEnvelope;
}

export function protocolRecord(input: unknown, label: string): Record<string, unknown> {
  return record(input, label);
}
