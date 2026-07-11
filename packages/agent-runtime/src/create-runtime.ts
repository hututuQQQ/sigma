import { InProcessRuntimeClient } from "./runtime-client.js";
import type { RuntimeOptions } from "./types.js";

export interface CreateRuntimeOptions extends RuntimeOptions {
  storeRootDir: string;
}

export function createRuntime(options: CreateRuntimeOptions): InProcessRuntimeClient {
  return new InProcessRuntimeClient(options);
}
