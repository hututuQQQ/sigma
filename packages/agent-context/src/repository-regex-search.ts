import { Worker } from "node:worker_threads";
import { textLines } from "agent-platform";

export const MAX_REPOSITORY_REGEX_CHARACTERS = 4_096;

const workerSource = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
let matcher;
let initializationError;
try {
  matcher = new RegExp(workerData.query, "u");
} catch (error) {
  initializationError = error instanceof Error ? error.message : String(error);
}
function searchLines(content, maximum) {
  const matches = [];
  if (content.length === 0) return { matches, limitReached: false };
  let line = 1;
  let start = 0;
  for (let index = 0; index <= content.length; index += 1) {
    const atEnd = index === content.length;
    if (atEnd && start === content.length) break;
    const character = atEnd ? "" : content[index];
    if (!atEnd && character !== "\n" && character !== "\r") continue;
    const text = content.slice(start, index);
    if (matcher.test(text)) {
      if (matches.length >= maximum) return { matches, limitReached: true };
      matches.push({ line, text });
    }
    if (!atEnd && character === "\r" && content[index + 1] === "\n") index += 1;
    start = index + 1;
    line += 1;
  }
  return { matches, limitReached: false };
}
parentPort.on("message", (message) => {
  if (initializationError) {
    parentPort.postMessage({ id: message.id, error: initializationError });
    return;
  }
  try {
    parentPort.postMessage({ id: message.id, ...searchLines(message.content, message.maximum) });
  } catch (error) {
    parentPort.postMessage({
      id: message.id,
      error: error instanceof Error ? error.message : String(error)
    });
  }
});
`;

export interface RepositoryLineMatch {
  line: number;
  text: string;
}

export interface RegexSearchOutcome {
  matches: RepositoryLineMatch[];
  limitReached: boolean;
  deadlineReached: boolean;
}

export function literalLineMatches(
  content: string,
  query: string,
  maximum: number,
  deadline: number,
  signal: AbortSignal
): RegexSearchOutcome {
  const matches: RepositoryLineMatch[] = [];
  for (const line of textLines(content)) {
    if ((line.number & 63) === 0) signal.throwIfAborted();
    if (performance.now() >= deadline) {
      return { matches, limitReached: false, deadlineReached: true };
    }
    if (line.text.includes(query)) {
      if (matches.length >= maximum) {
        return { matches, limitReached: true, deadlineReached: false };
      }
      matches.push({ line: line.number, text: line.text });
    }
  }
  signal.throwIfAborted();
  return { matches, limitReached: false, deadlineReached: false };
}

interface WorkerResponse {
  id: number;
  matches?: RepositoryLineMatch[];
  limitReached?: boolean;
  error?: string;
}

export class BoundedRegexMatcher {
  private readonly worker: Worker;
  private requestSequence = 0;
  private stopped = false;

  constructor(query: string) {
    if (query.length > MAX_REPOSITORY_REGEX_CHARACTERS) {
      throw new Error(
        `Regex exceeds the ${MAX_REPOSITORY_REGEX_CHARACTERS}-character safety limit.`
      );
    }
    this.worker = new Worker(workerSource, { eval: true, workerData: { query } });
  }

  async search(
    content: string,
    maximum: number,
    deadline: number,
    signal: AbortSignal
  ): Promise<RegexSearchOutcome> {
    signal.throwIfAborted();
    if (this.stopped || performance.now() >= deadline) {
      return { matches: [], limitReached: false, deadlineReached: true };
    }
    const id = ++this.requestSequence;
    return await new Promise<RegexSearchOutcome>((resolve, reject) => {
      const remaining = Math.max(1, Math.ceil(deadline - performance.now()));
      let settled = false;
      const cleanup = (): void => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        this.worker.off("message", onMessage);
        this.worker.off("error", onError);
        this.worker.off("exit", onExit);
      };
      const settle = (operation: () => void): void => {
        if (settled) return;
        settled = true;
        cleanup();
        operation();
      };
      const terminateThen = (operation: () => void, primary?: unknown): void => {
        if (settled) return;
        settled = true;
        cleanup();
        this.stopped = true;
        void this.worker.terminate().then(operation, (cleanupError) => {
          reject(primary === undefined ? cleanupError : new AggregateError(
            [primary, cleanupError], "Regex search cancellation and worker cleanup failed."
          ));
        });
      };
      const onMessage = (value: WorkerResponse): void => {
        if (value.id !== id) return;
        settle(() => {
          if (value.error) reject(new Error(`Invalid or failed repository regex: ${value.error}`));
          else resolve({
            matches: value.matches ?? [],
            limitReached: value.limitReached === true,
            deadlineReached: false
          });
        });
      };
      const onError = (error: Error): void => settle(() => reject(error));
      const onExit = (code: number): void => settle(() => reject(
        new Error(`Repository regex worker exited before replying (code ${code}).`)
      ));
      const onAbort = (): void => terminateThen(
        () => reject(signal.reason ?? new Error("Repository search cancelled.")),
        signal.reason
      );
      this.worker.on("message", onMessage);
      this.worker.once("error", onError);
      this.worker.once("exit", onExit);
      signal.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => terminateThen(() => resolve({
        matches: [], limitReached: false, deadlineReached: true
      })), remaining);
      try {
        this.worker.postMessage({ id, content, maximum: Math.max(0, maximum) });
      } catch (error) {
        terminateThen(() => reject(error), error);
      }
    });
  }

  async close(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    await this.worker.terminate();
  }
}
