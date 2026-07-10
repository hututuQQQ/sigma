export class VersionedContextCache<T> {
  private readonly entries = new Map<string, { version: string; value: T }>();

  get(key: string, version: string): T | undefined {
    const entry = this.entries.get(key);
    return entry?.version === version ? entry.value : undefined;
  }

  set(key: string, version: string, value: T): void {
    this.entries.set(key, { version, value });
  }

  invalidate(key?: string): void {
    if (key) this.entries.delete(key);
    else this.entries.clear();
  }
}
