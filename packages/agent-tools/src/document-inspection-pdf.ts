import type {
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  PDFPageProxy
} from "pdfjs-dist/legacy/build/pdf.mjs";
import type { JsonValue } from "agent-protocol";
import { LocalEnglishOcr, type OcrLayout } from "./local-ocr.js";
import type { PlannedToolExecutionContext } from "./registry.js";

const MAX_OCR_PAGES = 10;
const MAX_RENDER_PIXELS = 16_000_000;
const EMBEDDED_TEXT_THRESHOLD = 16;

export type OcrMode = "auto" | "never" | "always";
export type PdfDocument = PDFDocumentProxy;
export type PdfLoadingTask = PDFDocumentLoadingTask;

let canvasRuntime: Promise<typeof import("@napi-rs/canvas")> | undefined;
let pdfRuntime: Promise<typeof import("pdfjs-dist/legacy/build/pdf.mjs")> | undefined;

export interface PageInspection {
  page: number;
  source: "embedded_text" | "ocr" | "none";
  text: string;
  confidence?: number;
}

export interface PdfPageBatch {
  pages: PageInspection[];
  nextPage?: number;
}

export function parseOcrMode(value: JsonValue | undefined): OcrMode {
  if (value === undefined || value === "auto") return "auto";
  if (value === "never" || value === "always") return value;
  throw Object.assign(new Error("ocr must be auto, never, or always."), {
    code: "document_inspection_invalid_ocr_mode"
  });
}

function normalizeText(value: string): string {
  return value
    .replace(/\r\n?/gu, "\n")
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function embeddedText(items: Awaited<ReturnType<PDFPageProxy["getTextContent"]>>["items"]): string {
  let value = "";
  for (const item of items) {
    if (!("str" in item)) continue;
    const text = (item as { str: string; hasEOL: boolean }).str;
    if (!text) continue;
    if (value && !/[\s([{/-]$/u.test(value) && !/^[\s,.;:!?)}\]/-]/u.test(text)) value += " ";
    value += text;
    if ((item as { str: string; hasEOL: boolean }).hasEOL) value += "\n";
  }
  return normalizeText(value);
}

async function renderPage(page: PDFPageProxy): Promise<Buffer> {
  canvasRuntime ??= import("@napi-rs/canvas");
  const { createCanvas } = await canvasRuntime;
  const base = page.getViewport({ scale: 1 });
  const basePixels = Math.max(1, base.width * base.height);
  const scale = Math.max(0.5, Math.min(2, Math.sqrt(MAX_RENDER_PIXELS / basePixels)));
  const viewport = page.getViewport({ scale });
  const width = Math.max(1, Math.ceil(viewport.width));
  const height = Math.max(1, Math.ceil(viewport.height));
  const canvas = createCanvas(width, height);
  const task = page.render({
    canvas: canvas as never,
    canvasContext: canvas.getContext("2d") as never,
    viewport
  } as never);
  await task.promise;
  return await canvas.encode("png");
}

async function inspectPage(
  page: PDFPageProxy,
  pageNumber: number,
  extracted: string,
  needsOcr: boolean,
  layout: OcrLayout,
  ocr: LocalEnglishOcr | undefined
): Promise<PageInspection> {
  if (!needsOcr || !ocr) {
    return {
      page: pageNumber,
      source: extracted ? "embedded_text" : "none",
      text: extracted
    };
  }
  const recognized = await ocr.recognize(await renderPage(page), layout);
  return {
    page: pageNumber,
    source: recognized.text ? "ocr" : extracted ? "embedded_text" : "none",
    text: recognized.text || extracted,
    confidence: recognized.confidence
  };
}

function pdfBytes(bytes: Buffer, requested: string): Uint8Array {
  if (bytes.subarray(0, 5).toString("ascii") !== "%PDF-") {
    throw Object.assign(new Error(
      `Cannot inspect document '${requested}': its bytes do not have a PDF signature.`
    ), { code: "document_inspection_unsupported_format" });
  }
  return Uint8Array.from(bytes);
}

function needsPageOcr(mode: OcrMode, extracted: string): boolean {
  return mode === "always"
    || (mode === "auto"
      && extracted.replace(/\s/gu, "").length < EMBEDDED_TEXT_THRESHOLD);
}

async function extractedPageText(page: PDFPageProxy): Promise<string> {
  const content = await page.getTextContent({
    includeMarkedContent: false,
    disableNormalization: false
  });
  return embeddedText(content.items);
}

export async function loadPdf(
  bytes: Buffer,
  requested: string
): Promise<PdfLoadingTask> {
  pdfRuntime ??= import("pdfjs-dist/legacy/build/pdf.mjs");
  const { getDocument, VerbosityLevel } = await pdfRuntime;
  return getDocument({
    data: pdfBytes(bytes, requested),
    disableAutoFetch: true,
    disableFontFace: true,
    disableStream: true,
    enableXfa: false,
    useSystemFonts: false,
    stopAtErrors: true,
    verbosity: VerbosityLevel.ERRORS
  });
}

export function pageProjection(page: PageInspection): string {
  const text = page.text || "No embedded or OCR text was recognized on this page.";
  return `[Page ${page.page}; source=${page.source}]\n${text}`;
}

export async function inspectPdfPages(
  document: PdfDocument,
  startPage: number,
  endPage: number,
  mode: OcrMode,
  layout: OcrLayout,
  context: PlannedToolExecutionContext
): Promise<PdfPageBatch> {
  const pages: PageInspection[] = [];
  let ocrPages = 0;
  let ocr: LocalEnglishOcr | undefined;
  try {
    for (let pageNumber = startPage; pageNumber <= endPage; pageNumber += 1) {
      context.signal.throwIfAborted();
      context.heartbeat();
      await context.progress({
        message: `Inspecting PDF page ${pageNumber} of ${document.numPages}`,
        percent: Math.floor(((pageNumber - startPage) / (endPage - startPage + 1)) * 100)
      });
      const page = await document.getPage(pageNumber);
      try {
        const extracted = await extractedPageText(page);
        const needsOcr = needsPageOcr(mode, extracted);
        if (needsOcr && ocrPages >= MAX_OCR_PAGES) {
          return { pages, nextPage: pageNumber };
        }
        if (needsOcr) {
          ocr ??= new LocalEnglishOcr(context, "Inspecting PDF");
          ocrPages += 1;
        }
        pages.push(await inspectPage(
          page,
          pageNumber,
          extracted,
          needsOcr,
          layout,
          ocr
        ));
      } finally {
        page.cleanup();
      }
    }
    return { pages };
  } finally {
    await ocr?.close();
  }
}
