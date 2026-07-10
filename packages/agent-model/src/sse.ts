function timeoutError(message: string): Error {
  const error = new Error(message);
  error.name = "TimeoutError";
  return error;
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
  idleTimeoutMs: number
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
        break;
      }
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        for (const line of frame.split("\n")) {
          const trimmed = line.trim();
          if (trimmed.startsWith("data:")) yield trimmed.slice(5).trim();
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
    buffer += decoder.decode();
    for (const line of buffer.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.startsWith("data:")) yield trimmed.slice(5).trim();
    }
  } finally {
    if (!exhausted) await reader.cancel(signal.reason).catch(() => undefined);
    try { reader.releaseLock(); } catch { /* A cancelled pending read owns cleanup. */ }
  }
}
