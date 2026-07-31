import type { ModelFailureCategory, ModelSpec } from "./catalog.js";
import type { ModelResolution } from "./route-policy.js";

function retrySameProvider(category: ModelFailureCategory, spec: ModelSpec | undefined): boolean {
  return category === "rate_limit"
    || category === "network"
    || category === "server"
    || category === "timeout"
    || (category === "capacity" && spec?.providerId === "deepseek");
}

export function abortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (delayMs <= 0) return Promise.resolve();
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const completed = (): void => {
      signal.removeEventListener("abort", aborted);
      resolve();
    };
    const timeout = setTimeout(completed, delayMs);
    const aborted = (): void => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", aborted);
      reject(signal.reason ?? Object.assign(new Error("Model retry was cancelled."), {
        name: "AbortError"
      }));
    };
    signal.addEventListener("abort", aborted, { once: true });
  });
}

function sameCandidateRetryOrdinal(attempts: readonly ModelSpec[], nextIndex: number): number {
  const candidateId = attempts[nextIndex]?.id;
  if (!candidateId) return 0;
  let ordinal = 0;
  for (let index = nextIndex - 1; index >= 0 && attempts[index]?.id === candidateId; index -= 1) {
    ordinal += 1;
  }
  return ordinal;
}

export function retryDelay(
  attempts: readonly ModelSpec[],
  currentIndex: number,
  nextIndex: number,
  baseDelayMs: number,
  maxDelayMs: number,
  jitterRatio = 0
): number {
  if (baseDelayMs === 0 || attempts[currentIndex]?.id !== attempts[nextIndex]?.id) return 0;
  const ordinal = sameCandidateRetryOrdinal(attempts, nextIndex);
  if (ordinal < 1) return 0;
  const exponential = Math.min(
    maxDelayMs,
    baseDelayMs * (2 ** Math.min(ordinal - 1, 30))
  );
  if (jitterRatio === 0) return exponential;
  const jitter = 1 - jitterRatio + (Math.random() * jitterRatio * 2);
  return Math.min(maxDelayMs, Math.max(0, Math.round(exponential * jitter)));
}

export function executionCandidates(
  resolution: ModelResolution,
  retries: number,
  totalAttemptLimit: number | undefined
): ModelSpec[] {
  const candidates = resolution.candidates.slice(0, resolution.route.maxAttempts);
  const attempts = candidates.flatMap((spec) => Array.from({ length: retries + 1 }, () => spec));
  return totalAttemptLimit === undefined ? attempts : attempts.slice(0, totalAttemptLimit);
}

export function nextExecutionIndex(
  attempts: readonly ModelSpec[],
  currentIndex: number,
  category: ModelFailureCategory
): number | undefined {
  const current = attempts[currentIndex];
  const next = attempts[currentIndex + 1];
  if (retrySameProvider(category, current) && next?.id === current?.id) return currentIndex + 1;
  const nextProvider = attempts.findIndex((spec, index) =>
    index > currentIndex && spec.id !== current?.id);
  return nextProvider < 0 ? undefined : nextProvider;
}
