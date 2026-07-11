import { BrokerProtocolError } from "./errors.js";
import type { SecretRedactor } from "./redaction.js";

const HEADER_SEPARATOR = Buffer.from("\r\n\r\n", "ascii");
const MAXIMUM_HEADER_BYTES = 64 * 1024;
const MAXIMUM_FRAME_BYTES = 16 * 1024 * 1024;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function redactError(value: unknown, redactor: SecretRedactor): unknown {
  if (!record(value)) throw new BrokerProtocolError("Framed JSON-RPC error must be an object.");
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "code") {
      if (!Number.isInteger(item)) throw new BrokerProtocolError("Framed JSON-RPC error.code must be an integer.");
      output[key] = item;
    } else output[key] = redactor.redactJsonValue(item);
  }
  return output;
}

function validateEnvelope(value: Record<string, unknown>): void {
  if (value.jsonrpc !== "2.0") throw new BrokerProtocolError("Framed JSON-RPC jsonrpc must equal '2.0'.");
  const id = value.id;
  if (Object.hasOwn(value, "id") && id !== null && typeof id !== "string" && typeof id !== "number") {
    throw new BrokerProtocolError("Framed JSON-RPC id must be a string, number, or null.");
  }
  if (typeof id === "number" && !Number.isFinite(id)) {
    throw new BrokerProtocolError("Framed JSON-RPC numeric id must be finite.");
  }
  if (Object.hasOwn(value, "method") && typeof value.method !== "string") {
    throw new BrokerProtocolError("Framed JSON-RPC method must be a string.");
  }
}

function redactMessage(value: unknown, redactor: SecretRedactor): unknown {
  if (Array.isArray(value)) {
    if (value.length === 0) throw new BrokerProtocolError("Framed JSON-RPC batch must not be empty.");
    return value.map((item) => redactMessage(item, redactor));
  }
  if (!record(value)) throw new BrokerProtocolError("Framed JSON-RPC output must contain an object or batch.");
  validateEnvelope(value);
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "jsonrpc") output[key] = item;
    else if (key === "id") output[key] = typeof item === "string" ? redactor.redactJsonValue(item) : item;
    else if (key === "method") output[key] = redactor.redactJsonValue(item);
    else if (key === "error") output[key] = redactError(item, redactor);
    else output[key] = redactor.redactJsonValue(item);
  }
  return output;
}

/** Redacts LSP-style framed JSON-RPC without scanning structural headers or tokens. */
export class FramedJsonRpcRedactionStream {
  private buffer = Buffer.alloc(0);

  constructor(private readonly redactor: SecretRedactor) {}

  push(input: string, options: { final?: boolean; discontinuity?: boolean } = {}): string {
    if (options.discontinuity) {
      this.buffer = Buffer.alloc(0);
      throw new BrokerProtocolError("Framed JSON-RPC output was truncated before redaction.");
    }
    this.buffer = Buffer.concat([this.buffer, Buffer.from(input, "utf8")]);
    const frames: Buffer[] = [];
    while (true) {
      const headerEnd = this.buffer.indexOf(HEADER_SEPARATOR);
      if (headerEnd < 0) {
        if (this.buffer.byteLength > MAXIMUM_HEADER_BYTES) {
          throw new BrokerProtocolError("Framed JSON-RPC header exceeds the safety limit.");
        }
        break;
      }
      if (headerEnd > MAXIMUM_HEADER_BYTES) {
        throw new BrokerProtocolError("Framed JSON-RPC header exceeds the safety limit.");
      }
      const header = this.buffer.subarray(0, headerEnd).toString("ascii");
      const match = /(?:^|\r\n)Content-Length:\s*(\d+)/iu.exec(header);
      const length = match ? Number(match[1]) : Number.NaN;
      if (!Number.isSafeInteger(length) || length < 0 || length > MAXIMUM_FRAME_BYTES) {
        throw new BrokerProtocolError("Framed JSON-RPC Content-Length is invalid or oversized.");
      }
      const bodyStart = headerEnd + HEADER_SEPARATOR.byteLength;
      if (this.buffer.byteLength < bodyStart + length) break;
      const body = this.buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
      let parsed: unknown;
      try { parsed = JSON.parse(body); }
      catch (error) { throw new BrokerProtocolError("Framed JSON-RPC body is not valid JSON.", { cause: error }); }
      const redacted = Buffer.from(JSON.stringify(redactMessage(parsed, this.redactor)), "utf8");
      frames.push(Buffer.from(`Content-Length: ${redacted.byteLength}\r\n\r\n`, "ascii"), redacted);
      this.buffer = this.buffer.subarray(bodyStart + length);
    }
    if (options.final === true && this.buffer.byteLength > 0) {
      this.buffer = Buffer.alloc(0);
      throw new BrokerProtocolError("Framed JSON-RPC output ended inside a frame.");
    }
    return Buffer.concat(frames).toString("utf8");
  }
}
