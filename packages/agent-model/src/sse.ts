function timeoutError(message: string): Error {
  const error = new Error(message);
  error.name = "TimeoutError";
  return error;
}

export interface SseStreamState {
  startedAtMs: number;
  firstByteAtMs?: number;
  lastFrameAtMs?: number;
  lastActivityAtMs?: number;
  chunksRead: number;
  bytesRead: number;
  framesRead: number;
  dataPayloads: number;
  transportEnded: boolean;
  trailingBytes: number;
}

export function createSseStreamState(startedAtMs = performance.now()): SseStreamState {
  return {
    startedAtMs,
    chunksRead: 0,
    bytesRead: 0,
    framesRead: 0,
    dataPayloads: 0,
    transportEnded: false,
    trailingBytes: 0
  };
}

export interface SseTimeouts {
  /** Time from starting the HTTP attempt until the first response-body byte. */
  firstByteTimeoutMs: number;
  /** Maximum time without a complete SSE data payload. Raw partial chunks do not reset it. */
  idleTimeoutMs: number;
  /** Optional maximum body-stream lifetime after the first byte. The parent signal remains the absolute session deadline. */
  activeTimeoutMs?: number;
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
  const observedAt = performance.now();
  state.lastFrameAtMs = observedAt;
  state.framesRead += 1;
  const data: string[] = [];
  for (const line of frame.split(/\r\n|\r|\n/u)) {
    if (!line.startsWith("data:")) continue;
    const value = line.slice(5);
    data.push(value.startsWith(" ") ? value.slice(1) : value);
  }
  if (data.length === 0) return undefined;
  state.lastActivityAtMs = observedAt;
  state.dataPayloads += 1;
  return data.join("\n");
}

async function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
  timeouts: SseTimeouts,
  state: SseStreamState
): Promise<Awaited<ReturnType<typeof reader.read>>> {
  const now = performance.now();
  const candidates = state.firstByteAtMs === undefined
    ? [{ deadlineAt: state.startedAtMs + timeouts.firstByteTimeoutMs,
        message: `Model stream first byte exceeded ${timeouts.firstByteTimeoutMs}ms.` }]
    : [
        { deadlineAt: (state.lastActivityAtMs ?? state.firstByteAtMs) + timeouts.idleTimeoutMs,
          message: `Model stream idle for ${timeouts.idleTimeoutMs}ms without an SSE data payload.` },
        ...(timeouts.activeTimeoutMs === undefined ? [] : [{
          deadlineAt: state.firstByteAtMs + timeouts.activeTimeoutMs,
          message: `Model active stream exceeded ${timeouts.activeTimeoutMs}ms.`
        }])
      ];
  const next = candidates.reduce((earliest, candidate) =>
    candidate.deadlineAt < earliest.deadlineAt ? candidate : earliest);
  const timeoutMs = Math.max(0, next.deadlineAt - now);
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
    const timer = setTimeout(() => fail(timeoutError(next.message)), timeoutMs);
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
  configuredTimeouts: number | SseTimeouts,
  state: SseStreamState = createSseStreamState()
): AsyncIterable<string> {
  const timeouts = typeof configuredTimeouts === "number"
    ? { firstByteTimeoutMs: configuredTimeouts, idleTimeoutMs: configuredTimeouts }
    : configuredTimeouts;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let exhausted = false;
  try {
    while (true) {
      const { done, value } = await readChunk(reader, signal, timeouts, state);
      if (done) {
        exhausted = true;
        state.transportEnded = true;
        break;
      }
      if (state.firstByteAtMs === undefined && value.byteLength > 0) {
        state.firstByteAtMs = performance.now();
        state.lastActivityAtMs = state.firstByteAtMs;
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
