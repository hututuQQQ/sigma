import { open, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { AgentEventEnvelope } from "agent-protocol";

export interface DurableEventTail {
  incomplete: boolean;
  lastSeq: number;
  segment: number;
}

const SEGMENT_PATTERN = /^\d{6}\.jsonl$/u;
const READ_CHUNK_BYTES = 64 * 1024;

async function lastCompleteLine(filePath: string, size: number): Promise<string | null> {
  const handle = await open(filePath, "r");
  try {
    const finalByte = Buffer.allocUnsafe(1);
    await handle.read(finalByte, 0, 1, size - 1);
    if (finalByte[0] !== 0x0a) return null;
    let cursor = size - 1;
    const chunks: Buffer[] = [];
    while (cursor > 0) {
      const length = Math.min(READ_CHUNK_BYTES, cursor);
      cursor -= length;
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(buffer, 0, length, cursor);
      const chunk = buffer.subarray(0, bytesRead);
      const delimiter = chunk.lastIndexOf(0x0a);
      if (delimiter >= 0) {
        chunks.unshift(chunk.subarray(delimiter + 1));
        return Buffer.concat(chunks).toString("utf8");
      }
      chunks.unshift(chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    await handle.close();
  }
}

export async function inspectDurableEventTail(
  sessionDir: string,
  decode: (line: string) => AgentEventEnvelope
): Promise<DurableEventTail> {
  const eventsDir = path.join(sessionDir, "events");
  const files = (await readdir(eventsDir).catch(() => [])).filter((name) => SEGMENT_PATTERN.test(name)).sort();
  const segment = files.length > 0 ? Number.parseInt(files.at(-1)!.slice(0, 6), 10) : 1;
  for (let index = files.length - 1; index >= 0; index -= 1) {
    const filePath = path.join(eventsDir, files[index]);
    const size = await stat(filePath).then((item) => item.size);
    if (size === 0) continue;
    const line = await lastCompleteLine(filePath, size);
    if (line === null) return { incomplete: true, lastSeq: 0, segment };
    if (!line.trim()) continue;
    return { incomplete: false, lastSeq: decode(line).seq, segment };
  }
  return { incomplete: false, lastSeq: 0, segment };
}
