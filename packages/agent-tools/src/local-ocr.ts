import { createRequire } from "node:module";
import path from "node:path";
import { createWorker, OEM, PSM, type Worker } from "tesseract.js";
import type { JsonValue } from "agent-protocol";
import type { PlannedToolExecutionContext } from "./registry.js";

export type OcrLayout = "auto" | "single_block" | "sparse_text";

const require = createRequire(import.meta.url);

function bundledEnglishLanguagePath(): string {
  const packageEntry = require.resolve("@tesseract.js-data/eng");
  return path.join(path.dirname(packageEntry), "4.0.0_best_int");
}

export function ocrLayout(value: JsonValue | undefined): OcrLayout {
  return value === "single_block" || value === "sparse_text" ? value : "auto";
}

function pageSegmentation(layout: OcrLayout): PSM {
  if (layout === "single_block") return PSM.SINGLE_BLOCK;
  if (layout === "sparse_text") return PSM.SPARSE_TEXT;
  return PSM.AUTO;
}

function normalizeOcrText(value: string): string {
  return value.replace(/\r\n?/gu, "\n").replace(/[ \t]+\n/gu, "\n").trimEnd();
}

export class LocalEnglishOcr {
  private worker?: Worker;
  private termination?: Promise<unknown>;
  private lastProgressPercent = -1;
  private readonly abort: () => void;

  constructor(
    private readonly context: PlannedToolExecutionContext,
    private readonly progressLabel: string
  ) {
    this.abort = () => {
      void this.close().catch(() => undefined);
    };
    context.signal.addEventListener("abort", this.abort, { once: true });
  }

  private async readyWorker(): Promise<Worker> {
    if (this.worker) return this.worker;
    this.worker = await createWorker("eng", OEM.LSTM_ONLY, {
      langPath: bundledEnglishLanguagePath(),
      gzip: true,
      cacheMethod: "none",
      logger: (message) => {
        this.context.heartbeat();
        const percent = Math.max(0, Math.min(100, Math.floor(message.progress * 100)));
        if (percent < this.lastProgressPercent + 10 && percent !== 100) return;
        this.lastProgressPercent = percent;
        void this.context.progress({
          message: `${this.progressLabel}: ${message.status}`,
          percent
        }).catch(() => undefined);
      }
    });
    this.context.signal.throwIfAborted();
    return this.worker;
  }

  async recognize(
    bytes: Buffer | Uint8Array,
    layout: OcrLayout
  ): Promise<{ text: string; confidence: number }> {
    const worker = await this.readyWorker();
    await worker.setParameters({
      tessedit_pageseg_mode: pageSegmentation(layout),
      preserve_interword_spaces: "1"
    });
    const result = await worker.recognize(
      bytes,
      { rotateAuto: true },
      { text: true, blocks: false }
    );
    this.context.signal.throwIfAborted();
    return {
      text: normalizeOcrText(result.data.text),
      confidence: Number.isFinite(result.data.confidence) ? result.data.confidence : 0
    };
  }

  async close(): Promise<void> {
    this.context.signal.removeEventListener("abort", this.abort);
    if (!this.termination && this.worker) this.termination = this.worker.terminate();
    await this.termination;
  }
}

export async function recognizeEnglishText(
  bytes: Buffer | Uint8Array,
  layout: OcrLayout,
  context: PlannedToolExecutionContext,
  progressLabel: string
): Promise<{ text: string; confidence: number }> {
  const ocr = new LocalEnglishOcr(context, progressLabel);
  try {
    return await ocr.recognize(bytes, layout);
  } finally {
    await ocr.close();
  }
}
