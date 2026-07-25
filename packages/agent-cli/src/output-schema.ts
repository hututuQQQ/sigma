import {
  CLI_OUTPUT_SCHEMA_VERSION as CURRENT_CLI_OUTPUT_SCHEMA_VERSION,
  type AgentEventEnvelope
} from "agent-protocol";

export const CLI_OUTPUT_SCHEMA_VERSION = CURRENT_CLI_OUTPUT_SCHEMA_VERSION;

interface ChunkEnvelope {
  schemaVersion: number;
  kind: "chunk";
  recordId: string;
  index: number;
  total: number;
  encoding: "base64-json-utf8";
  data: string;
}

export function outputEvent(event: AgentEventEnvelope): unknown {
  return {
    ...event,
    schemaVersion: CLI_OUTPUT_SCHEMA_VERSION,
    kind: "event"
  };
}

export function outputResult(result: unknown): unknown {
  const flattened = result && typeof result === "object" && !Array.isArray(result) ? result : {};
  return { ...flattened, schemaVersion: CLI_OUTPUT_SCHEMA_VERSION, kind: "result", type: "result", result };
}

export function outputError(error: { code: string; message: string }): unknown {
  return { schemaVersion: CLI_OUTPUT_SCHEMA_VERSION, kind: "error", type: "error", error };
}

export function outputJsonLines(record: unknown, recordId: string, maxLineBytes: number): string[] {
  const encoded = JSON.stringify(record);
  if (maxLineBytes <= 0 || Buffer.byteLength(encoded, "utf8") <= maxLineBytes) return [encoded];

  const base64 = Buffer.from(encoded, "utf8").toString("base64");
  let dataChars = Math.max(4, Math.floor((maxLineBytes - 512) / 4) * 4);
  for (;;) {
    const total = Math.ceil(base64.length / dataChars);
    const chunks: string[] = [];
    let fits = true;
    for (let index = 0; index < total; index += 1) {
      const envelope: ChunkEnvelope = {
        schemaVersion: CLI_OUTPUT_SCHEMA_VERSION,
        kind: "chunk",
        recordId,
        index,
        total,
        encoding: "base64-json-utf8",
        data: base64.slice(index * dataChars, (index + 1) * dataChars)
      };
      const line = JSON.stringify(envelope);
      if (Buffer.byteLength(line, "utf8") > maxLineBytes) {
        fits = false;
        break;
      }
      chunks.push(line);
    }
    if (fits) return chunks;
    dataChars -= 4;
    if (dataChars < 4) throw new Error("stream-json max line size is too small for chunk framing");
  }
}
