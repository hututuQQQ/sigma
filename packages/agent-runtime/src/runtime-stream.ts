import type { AgentEventEnvelope, RunStore } from "agent-protocol";
import { AsyncQueue } from "./async-queue.js";
import type { RuntimeSession } from "./types.js";

export async function* streamSessionEvents(
  store: RunStore,
  session: RuntimeSession | undefined,
  sessionId: string,
  signal?: AbortSignal
): AsyncIterable<AgentEventEnvelope> {
  const queue = new AsyncQueue<AgentEventEnvelope>();
  const onAbort = (): void => queue.close();
  if (signal?.aborted) onAbort(); else signal?.addEventListener("abort", onAbort, { once: true });
  session?.interaction.subscribers.add(queue);
  let lastSeq = 0;
  try {
    for await (const event of store.events(sessionId)) {
      lastSeq = Math.max(lastSeq, event.seq);
      yield event;
    }
    if (!session) return;
    for await (const event of queue) {
      if (event.seq <= lastSeq) continue;
      lastSeq = event.seq;
      yield event;
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    session?.interaction.subscribers.delete(queue);
    queue.close();
  }
}
