export class AsyncMailbox<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<(value: IteratorResult<T>) => void> = [];
  private closed = false;

  constructor(private readonly capacity = 256) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error("Mailbox capacity must be a positive integer.");
  }

  send(value: T): void {
    if (this.closed) throw new Error("Mailbox is closed.");
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else {
      if (this.values.length >= this.capacity) throw new Error(`Mailbox is full (${this.capacity} messages).`);
      this.values.push(value);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined as T, done: true });
  }

  size(): number {
    return this.values.length;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async () => {
        const value = this.values.shift();
        if (value !== undefined) return { value, done: false };
        if (this.closed) return { value: undefined as T, done: true };
        return await new Promise<IteratorResult<T>>((resolve) => this.waiters.push(resolve));
      }
    };
  }
}
