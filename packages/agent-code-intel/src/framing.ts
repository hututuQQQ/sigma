const HEADER_SEPARATOR = Buffer.from("\r\n\r\n", "ascii");
const MAXIMUM_HEADER_BYTES = 64 * 1024;
const MAXIMUM_FRAME_BYTES = 16 * 1024 * 1024;

export function encodeLspMessage(message: unknown): Uint8Array {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  return Buffer.concat([Buffer.from(`Content-Length: ${body.byteLength}\r\n\r\n`, "ascii"), body]);
}

export class LspFrameDecoder {
  private buffer = Buffer.alloc(0);

  push(chunk: Uint8Array): string[] {
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    const messages: string[] = [];
    while (true) {
      const headerEnd = this.buffer.indexOf(HEADER_SEPARATOR);
      if (headerEnd < 0) {
        if (this.buffer.byteLength > MAXIMUM_HEADER_BYTES) throw new Error("LSP header exceeds the safety limit.");
        break;
      }
      if (headerEnd > MAXIMUM_HEADER_BYTES) throw new Error("LSP header exceeds the safety limit.");
      const header = this.buffer.subarray(0, headerEnd).toString("ascii");
      const lengthLine = header.split("\r\n").find((line) => /^content-length:/iu.test(line));
      const length = lengthLine ? Number.parseInt(lengthLine.split(":", 2)[1]?.trim() ?? "", 10) : Number.NaN;
      if (!Number.isSafeInteger(length) || length < 0 || length > MAXIMUM_FRAME_BYTES) {
        throw new Error("Invalid or oversized LSP Content-Length header.");
      }
      const bodyStart = headerEnd + HEADER_SEPARATOR.length;
      if (this.buffer.byteLength < bodyStart + length) break;
      messages.push(this.buffer.subarray(bodyStart, bodyStart + length).toString("utf8"));
      this.buffer = this.buffer.subarray(bodyStart + length);
    }
    return messages;
  }
}
