import { realpath } from "node:fs/promises";
import path from "node:path";
import type {
  EvidenceRecord,
  JsonValue,
  ToolCallPlan,
  ToolPreparationContext,
  ToolReceipt,
  ToolRequest
} from "agent-protocol";
import { isInside } from "agent-platform";
import { args, descriptor, receipt, stringArg } from "./builtin-tool-support.js";
import {
  inspectPdfPages,
  loadPdf,
  pageProjection,
  parseOcrMode,
  type OcrMode,
  type PageInspection,
  type PdfDocument,
  type PdfLoadingTask
} from "./document-inspection-pdf.js";
import { ocrLayout, type OcrLayout } from "./local-ocr.js";
import type { PlannedToolExecutionContext, RegisteredEffectTool } from "./registry.js";
import { readStableWorkspaceFile } from "./stable-workspace-read.js";

export const MAX_DOCUMENT_INSPECTION_BYTES = 32 * 1024 * 1024;
const DEFAULT_PAGE_COUNT = 10;
const MAX_PAGE_COUNT = 25;
const DEFAULT_OUTPUT_BYTES = 32 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_EXTRACTED_TEXT_BYTES = 2 * 1024 * 1024;

function integer(
  value: JsonValue | undefined,
  fallback: number,
  label: string,
  minimum: number,
  maximum: number
): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value)
    || value < minimum || value > maximum) {
    throw Object.assign(new Error(`${label} must be an integer from ${minimum} to ${maximum}.`), {
      code: "document_inspection_invalid_range"
    });
  }
  return value;
}

async function prepareDocumentPlan(
  readScope: "workspace" | "host",
  argumentsValue: JsonValue,
  context: ToolPreparationContext
): Promise<ToolCallPlan> {
  const input = args(argumentsValue);
  const requested = stringArg(input, "path");
  const workspace = await realpath(context.workspacePath);
  const target = path.isAbsolute(requested)
    ? path.resolve(requested) : path.resolve(workspace, requested);
  const external = !isInside(workspace, target);
  if (external && readScope !== "host") {
    throw Object.assign(new Error(`Document path escapes the workspace: ${requested}`), {
      code: "policy_denied"
    });
  }
  return {
    exactEffects: external
      ? ["filesystem.read", "filesystem.read.external"] : ["filesystem.read"],
    readPaths: [external ? target : path.relative(workspace, target).split(path.sep).join("/") || "."],
    writePaths: [],
    network: "none",
    processMode: "none",
    checkpointScope: [],
    idempotence: "read_only"
  };
}

async function approvedDocumentLocation(
  requested: string,
  context: PlannedToolExecutionContext
): Promise<{ target: string; external: boolean }> {
  const workspace = await realpath(context.workspacePath);
  const target = path.isAbsolute(requested)
    ? path.resolve(requested) : path.resolve(workspace, requested);
  const external = !isInside(workspace, target);
  if (external && (!context.callPlan?.exactEffects.includes("filesystem.read.external")
    || context.approval?.externalReadApproved !== true)) {
    throw Object.assign(new Error(`External document read lacks a fresh grant: ${requested}`), {
      code: "per_call_approval_required"
    });
  }
  return { target, external };
}

function inputEvidence(
  request: ToolRequest,
  context: PlannedToolExecutionContext,
  requested: string,
  target: string,
  loaded: { sha256: string; byteLength: number }
): EvidenceRecord[] {
  return [{
    evidenceId: `input-access:${request.callId}`,
    sessionId: context.sessionId,
    runId: context.runId,
    kind: "input_access",
    status: "passed",
    createdAt: new Date().toISOString(),
    producer: { authority: "tool", id: request.callId },
    summary: `Inspected external PDF input '${requested}'.`,
    data: {
      path: target,
      scope: "external",
      sha256: loaded.sha256,
      byteLength: loaded.byteLength
    }
  }];
}

function utf8Page(bytes: Buffer, offset: number, maximum: number): {
  content: string;
  end: number;
  next?: number;
} {
  if (offset > bytes.byteLength) {
    throw Object.assign(new Error("offsetBytes exceeds the extracted document text length."), {
      code: "document_inspection_invalid_range"
    });
  }
  if (offset < bytes.byteLength && (bytes[offset]! & 0xc0) === 0x80) {
    throw Object.assign(new Error("offsetBytes must point to a UTF-8 character boundary."), {
      code: "document_inspection_invalid_range"
    });
  }
  let end = Math.min(bytes.byteLength, offset + maximum);
  while (end > offset && end < bytes.byteLength && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return {
    content: bytes.subarray(offset, end).toString("utf8"),
    end,
    ...(end < bytes.byteLength ? { next: end } : {})
  };
}

interface DocumentInspectionRequest {
  input: Record<string, JsonValue>;
  requested: string;
  mode: OcrMode;
  layout: OcrLayout;
  startPage: number;
  offsetBytes: number;
  maxBytes: number;
  target: string;
  external: boolean;
  loaded: Awaited<ReturnType<typeof readStableWorkspaceFile>>;
}

interface InspectedPageBatch {
  pages: PageInspection[];
  requestedEnd: number;
  nextPage?: number;
}

async function documentInspectionRequest(
  request: ToolRequest,
  context: PlannedToolExecutionContext
): Promise<DocumentInspectionRequest> {
  const input = args(request.arguments);
  const requested = stringArg(input, "path");
  const mode = parseOcrMode(input.ocr);
  const layout = ocrLayout(input.layout);
  const startPage = integer(input.startPage, 1, "startPage", 1, 1_000_000);
  const offsetBytes = integer(
    input.offsetBytes, 0, "offsetBytes", 0, MAX_EXTRACTED_TEXT_BYTES
  );
  const maxBytes = integer(
    input.maxBytes, DEFAULT_OUTPUT_BYTES, "maxBytes", 1, MAX_OUTPUT_BYTES
  );
  const { target, external } = await approvedDocumentLocation(requested, context);
  const loaded = await readStableWorkspaceFile(
    context.workspacePath,
    requested,
    context.signal,
    {
      maxBytes: MAX_DOCUMENT_INSPECTION_BYTES,
      allowExternalAbsolutePath: external
    }
  );
  return {
    input,
    requested,
    mode,
    layout,
    startPage,
    offsetBytes,
    maxBytes,
    target,
    external,
    loaded
  };
}

function selectedEndPage(
  request: DocumentInspectionRequest,
  document: PdfDocument
): number {
  if (request.startPage > document.numPages) {
    throw Object.assign(new Error(
      `startPage ${request.startPage} exceeds the PDF page count ${document.numPages}.`
    ), { code: "document_inspection_invalid_range" });
  }
  const requestedEnd = integer(
    request.input.endPage,
    Math.min(document.numPages, request.startPage + DEFAULT_PAGE_COUNT - 1),
    "endPage",
    request.startPage,
    document.numPages
  );
  if (requestedEnd - request.startPage + 1 > MAX_PAGE_COUNT) {
    throw Object.assign(new Error(
      `A document inspection may include at most ${MAX_PAGE_COUNT} pages.`
    ), { code: "document_inspection_invalid_range" });
  }
  return requestedEnd;
}

async function inspectSelectedPages(
  request: DocumentInspectionRequest,
  document: PdfDocument,
  context: PlannedToolExecutionContext
): Promise<InspectedPageBatch> {
  const requestedEnd = selectedEndPage(request, document);
  return {
    ...await inspectPdfPages(
      document,
      request.startPage,
      requestedEnd,
      request.mode,
      request.layout,
      context
    ),
    requestedEnd
  };
}

function extractedDocumentBytes(pages: readonly PageInspection[]): Buffer {
  const fullBytes = Buffer.from(pages.map(pageProjection).join("\n\n"), "utf8");
  if (fullBytes.byteLength > MAX_EXTRACTED_TEXT_BYTES) {
    throw Object.assign(new Error(
      `Selected PDF pages exceed the ${MAX_EXTRACTED_TEXT_BYTES}-byte extraction limit; request a narrower page range.`
    ), { code: "document_inspection_output_too_large" });
  }
  return fullBytes;
}

function documentInspectionReceipt(
  toolRequest: ToolRequest,
  startedAt: string,
  request: DocumentInspectionRequest,
  document: PdfDocument,
  batch: InspectedPageBatch,
  context: PlannedToolExecutionContext
): ToolReceipt {
  const fullBytes = extractedDocumentBytes(batch.pages);
  const projection = utf8Page(fullBytes, request.offsetBytes, request.maxBytes);
  const continuationPage = projection.next === undefined
    ? batch.nextPage
      ?? (batch.requestedEnd < document.numPages ? batch.requestedEnd + 1 : undefined)
    : undefined;
  return receipt(toolRequest, startedAt, {
    output: projection.content || "No text was recognized in the selected PDF pages.",
    result: {
      status: "inspected",
      path: request.requested,
      scope: request.external ? "external" : "workspace",
      format: "pdf",
      mediaType: "application/pdf",
      byteLength: request.loaded.byteLength,
      sha256: request.loaded.sha256,
      pageCount: document.numPages,
      startPage: request.startPage,
      endPage: batch.pages.at(-1)?.page ?? request.startPage - 1,
      pages: batch.pages.map((page) => ({
        page: page.page,
        source: page.source,
        textLength: page.text.length,
        ...(page.confidence === undefined ? {} : { confidence: page.confidence })
      })),
      ocr: request.mode,
      language: "eng",
      totalTextBytes: fullBytes.byteLength,
      offsetBytes: request.offsetBytes,
      endOffsetBytes: projection.end,
      ...(projection.next === undefined ? {} : { nextOffsetBytes: projection.next }),
      ...(continuationPage === undefined ? {} : { nextPage: continuationPage }),
      eof: projection.next === undefined && continuationPage === undefined
    },
    observedEffects: request.external
      ? ["filesystem.read", "filesystem.read.external"] : ["filesystem.read"],
    evidence: request.external
      ? inputEvidence(
          toolRequest,
          context,
          request.requested,
          request.target,
          request.loaded
        )
      : []
  });
}

function documentInspectionFailure(requested: string, error: unknown): Error {
  if (error instanceof Error
    && "code" in error
    && typeof error.code === "string"
    && error.code.startsWith("document_inspection_")) return error;
  return Object.assign(new Error(
    `Cannot inspect PDF '${requested}': ${
      error instanceof Error ? error.message : String(error)
    }`,
    error instanceof Error ? { cause: error } : undefined
  ), { code: "document_inspection_failed" });
}

async function executeDocumentInspection(
  toolRequest: ToolRequest,
  context: PlannedToolExecutionContext
): Promise<ToolReceipt> {
  const startedAt = new Date().toISOString();
  const request = await documentInspectionRequest(toolRequest, context);
  let loading: PdfLoadingTask | undefined;
  try {
    loading = await loadPdf(request.loaded.bytes, request.requested);
    const document = await loading.promise;
    const batch = await inspectSelectedPages(request, document, context);
    return documentInspectionReceipt(
      toolRequest,
      startedAt,
      request,
      document,
      batch,
      context
    );
  } catch (error) {
    context.signal.throwIfAborted();
    throw documentInspectionFailure(request.requested, error);
  } finally {
    await loading?.destroy();
  }
}

export function documentInspectionTool(readScope: "workspace" | "host"): RegisteredEffectTool {
  return {
    descriptor: descriptor({
      name: "inspect_document",
      description: `Extract text from PDF inputs (maximum ${MAX_DOCUMENT_INSPECTION_BYTES} bytes). Embedded text is preferred; scanned pages use bundled local English OCR. Page and byte ranges are explicit and bounded. The tool never uses the network or modifies the workspace, and its objective output does not prove task completion.`,
      properties: {
        path: { type: "string" },
        startPage: { type: "integer", minimum: 1 },
        endPage: { type: "integer", minimum: 1 },
        offsetBytes: {
          type: "integer",
          minimum: 0,
          description: "UTF-8 byte offset within the selected pages' extracted text."
        },
        maxBytes: {
          type: "integer",
          minimum: 1,
          maximum: MAX_OUTPUT_BYTES,
          description: `Maximum UTF-8 output bytes (default ${DEFAULT_OUTPUT_BYTES}).`
        },
        ocr: {
          type: "string",
          enum: ["auto", "never", "always"],
          description: "auto uses OCR only when a page has little embedded text."
        },
        layout: {
          type: "string",
          enum: ["auto", "single_block", "sparse_text"],
          description: "Optional OCR layout hint for scanned pages."
        }
      },
      required: ["path"],
      possibleEffects: ["filesystem.read"],
      maximumEffects: ["filesystem.read", "filesystem.read.external"],
      executionMode: "parallel",
      resourceKeys: [],
      contextPathArguments: ["path"],
      approval: "auto",
      idempotent: true,
      timeoutMs: 180_000,
      async prepare(argumentsValue, context) {
        return await prepareDocumentPlan(readScope, argumentsValue, context);
      }
    }),
    async execute(request, context) {
      return await executeDocumentInspection(request, context);
    }
  };
}
