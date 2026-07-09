import { StringDecoder } from "node:string_decoder";
import { McpProtocolError } from "./errors.js";

export class JsonLineDecoder {
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";

  constructor(private readonly maximumBytes: number) {}

  push(chunk: Buffer): unknown[] {
    this.buffer += this.decoder.write(chunk);
    return this.drain(false);
  }

  end(): unknown[] {
    this.buffer += this.decoder.end();
    return this.drain(true);
  }

  private drain(end: boolean): unknown[] {
    const messages: unknown[] = [];
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      if (line.length > 0) messages.push(this.parse(line));
    }
    if (end && this.buffer.trim().length > 0) {
      const tail = this.buffer;
      this.buffer = "";
      messages.push(this.parse(tail));
    }
    this.assertBounded();
    return messages;
  }

  private parse(line: string): unknown {
    if (Buffer.byteLength(line, "utf8") > this.maximumBytes) {
      throw new McpProtocolError(`MCP message exceeded ${this.maximumBytes} bytes.`);
    }
    try {
      return JSON.parse(line) as unknown;
    } catch (error) {
      throw new McpProtocolError(`MCP server emitted invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private assertBounded(): void {
    if (Buffer.byteLength(this.buffer, "utf8") > this.maximumBytes) {
      throw new McpProtocolError(`MCP message exceeded ${this.maximumBytes} bytes.`);
    }
  }
}
