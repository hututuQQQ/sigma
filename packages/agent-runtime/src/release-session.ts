import type { RuntimeSession } from "./types.js";

export async function releaseRuntimeSession(
  session: RuntimeSession,
  waitForQuiescence: () => Promise<void>,
  releaseOwner: () => Promise<void>
): Promise<boolean> {
  const running = session.running;
  await running?.catch(() => undefined);
  await waitForQuiescence().catch(() => undefined);
  if (session.running && session.running !== running) return false;
  for (const subscriber of session.subscribers) subscriber.close();
  await releaseOwner();
  return true;
}
