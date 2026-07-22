import { setTimeout as delay } from "node:timers/promises";
import { ContainerUnavailableError } from "./errors.js";

export const OWNED_CLEANUP_TIMEOUT_MS = 10_000;

export async function withOwnedCleanupDeadline<T>(operation: Promise<T>): Promise<T> {
  return await Promise.race([
    operation,
    delay(OWNED_CLEANUP_TIMEOUT_MS, undefined, { ref: false }).then(() => {
      throw new ContainerUnavailableError("Owned OCI client cleanup exceeded its deadline.");
    })
  ]);
}
