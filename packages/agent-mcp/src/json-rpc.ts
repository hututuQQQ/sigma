import { McpProtocolError } from "./errors.js";
import { objectValue } from "./protocol-values.js";

export type IncomingJsonRpcMessage =
  | { kind: "response"; value: Record<string, unknown> }
  | { kind: "request"; value: Record<string, unknown> }
  | { kind: "notification"; value: Record<string, unknown> };

export function parseIncomingJsonRpc(input: unknown): IncomingJsonRpcMessage[] {
  if (Array.isArray(input)) return input.flatMap(parseIncomingJsonRpc);
  const message = objectValue(input, "JSON-RPC message");
  if (message.jsonrpc !== "2.0") throw new McpProtocolError("MCP message must use JSON-RPC 2.0.");
  if ("id" in message && ("result" in message || "error" in message)) {
    if ("result" in message && "error" in message) {
      throw new McpProtocolError("MCP response cannot contain both result and error.");
    }
    return [{ kind: "response", value: message }];
  }
  if (typeof message.method === "string" && "id" in message) return [{ kind: "request", value: message }];
  if (typeof message.method === "string") return [{ kind: "notification", value: message }];
  throw new McpProtocolError("Unrecognized MCP JSON-RPC message.");
}
