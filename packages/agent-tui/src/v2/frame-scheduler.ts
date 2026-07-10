type FrameOutput = NodeJS.WritableStream;

export class FrameScheduler {
  private timer?: ReturnType<typeof setTimeout>;
  private dirty = false;
  private blocked = false;
  private stopped = false;
  private lastFrame?: string;

  constructor(
    private readonly output: FrameOutput,
    private readonly frame: () => string,
    private readonly maximumFps = 30
  ) {}

  private readonly onDrain = (): void => {
    this.blocked = false;
    if (this.dirty) this.schedule();
  };

  schedule(): void {
    this.dirty = true;
    if (this.stopped || this.timer || this.blocked) return;
    const fps = Math.max(1, Math.min(30, this.maximumFps));
    this.timer = setTimeout(() => this.render(), Math.ceil(1_000 / fps));
  }

  stop(): void {
    this.stopped = true;
    this.dirty = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.output.off("drain", this.onDrain);
  }

  private render(): void {
    this.timer = undefined;
    if (this.stopped || !this.dirty) return;
    this.dirty = false;
    const frame = this.frame();
    if (frame === this.lastFrame) return;
    this.lastFrame = frame;
    if (!this.output.write(frame)) {
      this.blocked = true;
      this.output.once("drain", this.onDrain);
    }
  }
}
