export class PromptHistory {
  private readonly entries: string[] = [];
  private index = 0;
  private draft = "";

  add(value: string): void {
    const text = value.trim();
    if (!text) return;
    if (this.entries.at(-1) !== text) this.entries.push(text);
    if (this.entries.length > 100) this.entries.shift();
    this.reset();
  }

  previous(current: string): string | undefined {
    if (this.entries.length === 0 || this.index === 0) return undefined;
    if (this.index === this.entries.length) this.draft = current;
    this.index -= 1;
    return this.entries[this.index];
  }

  next(): string | undefined {
    if (this.index >= this.entries.length) return undefined;
    this.index += 1;
    return this.index === this.entries.length ? this.draft : this.entries[this.index];
  }

  reset(): void {
    this.index = this.entries.length;
    this.draft = "";
  }
}
