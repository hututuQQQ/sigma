export class ResourceLockManager {
  private readonly tails = new Map<string, Promise<void>>();

  async withLocks<T>(keys: readonly string[], action: () => Promise<T>): Promise<T> {
    const normalized = [...new Set(keys)].sort();
    const waits = normalized.map((key) => this.tails.get(key) ?? Promise.resolve());
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const prior = Promise.all(waits).then(() => undefined);
    const tail = prior.then(() => gate);
    for (const key of normalized) this.tails.set(key, tail);
    await prior;
    try {
      return await action();
    } finally {
      release();
      for (const key of normalized) {
        if (this.tails.get(key) === tail) this.tails.delete(key);
      }
    }
  }
}
