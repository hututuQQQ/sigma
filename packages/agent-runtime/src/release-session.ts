import type { RuntimeSession } from "./types.js";

export async function releaseRuntimeSession(
  session: RuntimeSession,
  waitForQuiescence: () => Promise<void>,
  releaseOwner: () => Promise<void>
): Promise<boolean> {
  const running = session.execution.running;
  await running?.catch(() => undefined);
  await waitForQuiescence().catch(() => undefined);
  if (session.execution.running && session.execution.running !== running) return false;
  for (const subscriber of session.interaction.subscribers) subscriber.close();
  await releaseOwner();
  return true;
}
