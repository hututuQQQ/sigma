/** A byte-bounded tail buffer. It never splits its reported dropped byte count. */
export class BoundedByteRingBuffer {
  private value = Buffer.alloc(0);
  private dropped = 0;

  constructor(readonly maximumBytes: number) {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
      throw new RangeError("maximumBytes must be a positive safe integer.");
    }
  }

  get droppedBytes(): number { return this.dropped; }
  get byteLength(): number { return this.value.byteLength; }

  append(input: Buffer | string): void {
    const chunk = typeof input === "string" ? Buffer.from(input, "utf8") : input;
    const combined = this.value.byteLength === 0 ? Buffer.from(chunk) : Buffer.concat([this.value, chunk]);
    if (combined.byteLength <= this.maximumBytes) {
      this.value = combined;
      return;
    }
    const excess = combined.byteLength - this.maximumBytes;
    this.dropped += excess;
    this.value = combined.subarray(excess);
  }

  bytes(): Buffer { return Buffer.from(this.value); }
  text(): string { return this.value.toString("utf8"); }

  clear(): void {
    this.value = Buffer.alloc(0);
    this.dropped = 0;
  }
}
