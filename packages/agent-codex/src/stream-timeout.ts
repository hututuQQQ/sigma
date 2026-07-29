import { OpenAICodexError } from "./errors.js";

interface StreamTimeoutOptions {
  signal: AbortSignal;
  idleTimeoutMs: number;
  activeTimeoutMs?: number;
}

function timeoutError(): OpenAICodexError {
  return new OpenAICodexError("timeout", "timeout");
}

async function nextWithDeadline<T>(
  iterator: AsyncIterator<T>,
  controller: AbortController,
  idleTimeoutMs: number
): Promise<IteratorResult<T>> {
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = timeoutError();
      controller.abort(error);
      reject(error);
    }, idleTimeoutMs);
  });
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(controller.signal.reason ?? timeoutError());
    controller.signal.addEventListener("abort", onAbort, { once: true });
    if (controller.signal.aborted) onAbort();
  });
  try {
    return await Promise.race([iterator.next(), timeout, aborted]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) controller.signal.removeEventListener("abort", onAbort);
  }
}

export async function* monitoredCodexStream<T>(
  create: (signal: AbortSignal) => AsyncIterable<T>,
  options: StreamTimeoutOptions
): AsyncIterable<T> {
  options.signal.throwIfAborted();
  const controller = new AbortController();
  const onParentAbort = (): void => controller.abort(options.signal.reason);
  options.signal.addEventListener("abort", onParentAbort, { once: true });
  const activeTimer = options.activeTimeoutMs === undefined
    ? undefined
    : setTimeout(() => controller.abort(timeoutError()), options.activeTimeoutMs);
  const iterator = create(controller.signal)[Symbol.asyncIterator]();
  try {
    while (true) {
      const item = await nextWithDeadline(iterator, controller, options.idleTimeoutMs);
      if (item.done) return;
      yield item.value;
    }
  } catch (error) {
    options.signal.throwIfAborted();
    throw error;
  } finally {
    if (activeTimer) clearTimeout(activeTimer);
    options.signal.removeEventListener("abort", onParentAbort);
    controller.abort(new Error("Codex stream closed."));
    await iterator.return?.().catch(() => undefined);
  }
}
