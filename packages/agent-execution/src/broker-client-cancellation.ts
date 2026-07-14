import { cancellationError, containPostDispatchFailure } from "./broker-client-support.js";
import { attachBrokerLifecycleFailure } from "./errors.js";

export async function settleCancelledSpawn(
  signal: AbortSignal | undefined,
  terminate: () => Promise<unknown>,
  closeClient: () => Promise<void>
): Promise<never> {
  const failure = cancellationError(signal);
  try {
    await terminate();
  } catch (terminationError) {
    attachBrokerLifecycleFailure(
      failure, terminationError, "Cancelled background process termination failed."
    );
    return await containPostDispatchFailure(failure, closeClient);
  }
  throw failure;
}
