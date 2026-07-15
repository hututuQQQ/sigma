function timeoutError(message: string): Error {
  const error = new Error(message);
  error.name = "TimeoutError";
  return error;
}

export interface SseStreamState {
  chunksRead: number;
  bytesRead: number;
  framesRead: number;
  dataPayloads: number;
  transportEnded: boolean;
  trailingBytes: number;
}

export function createSseStreamState(): SseStreamState {
  return {
    chunksRead: 0,
    bytesRead: 0,
    framesRead: 0,
    dataPayloads: 0,
    transportEnded: false,
    trailingBytes: 0
  };
}

interface FrameBoundary { index: number; length: number }

function lineEndingLength(value: string, index: number): number {
  if (value[index] === "\r") return value[index + 1] === "\n" ? 2 : 1;
  if (value[index] === "\n" && value[index - 1] !== "\r") return 1;
  return 0;
}

function nextFrameBoundary(value: string): FrameBoundary | undefined {
  for (let index = 0; index < value.length; index += 1) {
    const first = lineEndingLength(value, index);
    if (first === 0) continue;
    const second = lineEndingLength(value, index + first);
    if (second > 0) return { index, length: first + second };
    index += first - 1;
  }
  return undefined;
}

function payloadFromFrame(frame: string, state: SseStreamState): string | undefined {
  state.framesRead += 1;
  const data: string[] = [];
  for (const line of frame.split(/\r\n|\r|\n/u)) {
    if (!line.startsWith("data:")) continue;
    const value = line.slice(5);
    data.push(value.startsWith(" ") ? value.slice(1) : value);
  }
  if (data.length === 0) return undefined;
  state.dataPayloads += 1;
  return data.join("\n");
}

async function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
  idleTimeoutMs: number
): Promise<Awaited<ReturnType<typeof reader.read>>> {
  return await new Promise((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    };
    const fail = (error: Error): void => {
      cleanup();
      void reader.cancel(error).catch(() => undefined);
      reject(error);
    };
    const onAbort = (): void => fail(signal.reason instanceof Error ? signal.reason : new Error("Stream aborted."));
    const timer = setTimeout(() => {
      fail(timeoutError(`Model stream idle for ${idleTimeoutMs}ms.`));
    }, idleTimeoutMs);
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    reader.read().then(
      (chunk) => { cleanup(); resolve(chunk); },
      (error) => { cleanup(); reject(error); }
    );
  });
}

export async function *ssePayloads(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  idleTimeoutMs: number,
  state: SseStreamState = createSseStreamState()
): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let exhausted = false;
  try {
    while (true) {
      const { done, value } = await readChunk(reader, signal, idleTimeoutMs);
      if (done) {
        exhausted = true;
        state.transportEnded = true;
        break;
      }
      state.chunksRead += 1;
      state.bytesRead += value.byteLength;
      buffer += decoder.decode(value, { stream: true });
      let boundary = nextFrameBoundary(buffer);
      while (boundary) {
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.length);
        const payload = payloadFromFrame(frame, state);
        if (payload !== undefined) yield payload;
        boundary = nextFrameBoundary(buffer);
      }
    }
    buffer += decoder.decode();
    state.trailingBytes = new TextEncoder().encode(buffer).byteLength;
    if (buffer.length > 0) {
      const payload = payloadFromFrame(buffer, state);
      if (payload !== undefined) yield payload;
    }
  } finally {
    if (!exhausted) await reader.cancel(signal.reason).catch(() => undefined);
    try { reader.releaseLock(); } catch { /* A cancelled pending read owns cleanup. */ }
  }
}
