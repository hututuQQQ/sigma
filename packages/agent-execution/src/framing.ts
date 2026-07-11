import { BrokerProtocolError } from "./errors.js";
import { DEFAULT_MAX_FRAME_BYTES } from "./types.js";

const HEADER_BYTES = 4;

export function encodeBrokerFrame(value: unknown, maximumBytes = DEFAULT_MAX_FRAME_BYTES): Buffer {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new BrokerProtocolError("Broker frame value is not JSON serializable.", {
      cause: error
    });
  }
  if (serialized === undefined) throw new BrokerProtocolError("Broker frame value is not JSON serializable.");
  const payload = Buffer.from(serialized, "utf8");
  if (payload.byteLength === 0 || payload.byteLength > maximumBytes) {
    throw new BrokerProtocolError(`Broker frame payload must be between 1 and ${maximumBytes} bytes.`);
  }
  const frame = Buffer.allocUnsafe(HEADER_BYTES + payload.byteLength);
  frame.writeUInt32BE(payload.byteLength, 0);
  payload.copy(frame, HEADER_BYTES);
  return frame;
}

export class BrokerFrameDecoder {
  private buffer = Buffer.alloc(0);

  constructor(private readonly maximumBytes = DEFAULT_MAX_FRAME_BYTES) {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
      throw new RangeError("maximumBytes must be a positive safe integer.");
    }
  }

  push(chunk: Buffer): unknown[] {
    this.buffer = this.buffer.byteLength === 0 ? Buffer.from(chunk) : Buffer.concat([this.buffer, chunk]);
    const messages: unknown[] = [];
    while (this.buffer.byteLength >= HEADER_BYTES) {
      const payloadBytes = this.buffer.readUInt32BE(0);
      if (payloadBytes === 0 || payloadBytes > this.maximumBytes) {
        throw new BrokerProtocolError(`Broker frame declared invalid payload length ${payloadBytes}.`);
      }
      if (this.buffer.byteLength < HEADER_BYTES + payloadBytes) break;
      const payload = this.buffer.subarray(HEADER_BYTES, HEADER_BYTES + payloadBytes);
      this.buffer = this.buffer.subarray(HEADER_BYTES + payloadBytes);
      messages.push(this.parse(payload));
    }
    return messages;
  }

  end(): void {
    if (this.buffer.byteLength !== 0) throw new BrokerProtocolError("Broker stream ended inside a frame.");
  }

  private parse(payload: Buffer): unknown {
    try {
      return JSON.parse(payload.toString("utf8")) as unknown;
    } catch (error) {
      throw new BrokerProtocolError("Broker emitted invalid JSON.", {
        cause: error
      });
    }
  }
}
