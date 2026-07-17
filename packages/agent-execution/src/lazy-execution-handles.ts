import { randomUUID } from "node:crypto";
import type { ExecutionBroker, ProcessHandle } from "./types.js";

const PROCESS_HANDLE_NAMESPACE = randomUUID();
let lazyBrokerSequence = 0;

function handleKey(handle: ProcessHandle): string {
  return `${handle.brokerInstanceId}\0${handle.id}`;
}

export interface LazyProcessHandleOwner {
  readonly publicHandle: ProcessHandle;
  readonly nativeHandle: ProcessHandle;
  readonly generationId: number;
  readonly client: ExecutionBroker;
}

/**
 * Gives native process handles a LazyExecutionBroker-scoped identity. Native
 * broker generations may reuse their own tuple; wrapper tuples never do.
 */
export class LazyExecutionHandleRegistry {
  private readonly brokerInstanceId = `lazy:${PROCESS_HANDLE_NAMESPACE}:${++lazyBrokerSequence}`;
  private readonly active = new Map<string, LazyProcessHandleOwner>();
  private readonly lost = new Map<string, ProcessHandle>();
  private handleSequence = 0;

  get lostProcessHandles(): readonly ProcessHandle[] {
    return [...this.lost.values()];
  }

  register(
    nativeHandle: ProcessHandle,
    generationId: number,
    client: ExecutionBroker
  ): LazyProcessHandleOwner {
    const publicHandle = Object.freeze({
      id: `process:${++this.handleSequence}`,
      brokerInstanceId: this.brokerInstanceId,
      ...(nativeHandle.systemProcessId === undefined
        ? {}
        : { systemProcessId: nativeHandle.systemProcessId }),
      ...(nativeHandle.lifecycle === undefined ? {} : { lifecycle: nativeHandle.lifecycle })
    });
    const owner = { publicHandle, nativeHandle, generationId, client };
    this.active.set(handleKey(publicHandle), owner);
    return owner;
  }

  owner(handle: ProcessHandle): LazyProcessHandleOwner | undefined {
    return this.active.get(handleKey(handle));
  }

  release(owner: LazyProcessHandleOwner): void {
    const key = handleKey(owner.publicHandle);
    if (this.active.get(key) === owner) this.active.delete(key);
  }

  lose(owner: LazyProcessHandleOwner): void {
    this.release(owner);
    this.lost.set(handleKey(owner.publicHandle), owner.publicHandle);
  }

  loseGeneration(generationId: number): void {
    for (const owner of [...this.active.values()]) {
      if (owner.generationId === generationId) this.lose(owner);
    }
  }

  loseAll(): void {
    for (const owner of [...this.active.values()]) this.lose(owner);
  }

  captureClientLost(client: ExecutionBroker): void {
    const nativeLost = new Set(client.lostProcessHandles.map(handleKey));
    if (nativeLost.size === 0) return;
    for (const owner of [...this.active.values()]) {
      if (owner.client === client && nativeLost.has(handleKey(owner.nativeHandle))) {
        this.lose(owner);
      }
    }
  }
}
