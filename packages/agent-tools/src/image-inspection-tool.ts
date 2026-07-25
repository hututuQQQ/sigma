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
  ocrLayout,
  recognizeEnglishText
} from "./local-ocr.js";
import type { PlannedToolExecutionContext, RegisteredEffectTool } from "./registry.js";
import { readStableWorkspaceFile } from "./stable-workspace-read.js";

export const MAX_IMAGE_INSPECTION_BYTES = 16 * 1024 * 1024;

interface SupportedImage {
  mediaType: string;
  format: string;
}

function startsWith(bytes: Buffer, signature: readonly number[], offset = 0): boolean {
  return signature.every((value, index) => bytes[offset + index] === value);
}

function isGif(prefix: string): boolean {
  return prefix.startsWith("GIF87a") || prefix.startsWith("GIF89a");
}

function isWebp(prefix: string): boolean {
  return prefix.startsWith("RIFF") && prefix.slice(8, 12) === "WEBP";
}

function isTiff(bytes: Buffer): boolean {
  return startsWith(bytes, [0x49, 0x49, 0x2a, 0x00])
    || startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a]);
}

function isPortableAnymap(bytes: Buffer): boolean {
  return bytes[0] === 0x50 && bytes[1] !== undefined
    && bytes[1] >= 0x31 && bytes[1] <= 0x36
    && bytes[2] !== undefined && /\s/u.test(String.fromCharCode(bytes[2]));
}

function supportedImage(bytes: Buffer): SupportedImage | undefined {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { mediaType: "image/png", format: "png" };
  }
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    return { mediaType: "image/jpeg", format: "jpeg" };
  }
  const prefix = bytes.subarray(0, 12).toString("ascii");
  if (isGif(prefix)) {
    return { mediaType: "image/gif", format: "gif" };
  }
  if (isWebp(prefix)) {
    return { mediaType: "image/webp", format: "webp" };
  }
  if (prefix.startsWith("BM")) {
    return { mediaType: "image/bmp", format: "bmp" };
  }
  if (isTiff(bytes)) {
    return { mediaType: "image/tiff", format: "tiff" };
  }
  if (isPortableAnymap(bytes)) {
    return { mediaType: "image/x-portable-anymap", format: "pnm" };
  }
  return undefined;
}

async function prepareImagePlan(
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
    throw Object.assign(new Error(`Image path escapes the workspace: ${requested}`), {
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

async function approvedImageLocation(
  requested: string,
  context: PlannedToolExecutionContext
): Promise<{ target: string; external: boolean }> {
  const workspace = await realpath(context.workspacePath);
  const target = path.isAbsolute(requested)
    ? path.resolve(requested) : path.resolve(workspace, requested);
  const external = !isInside(workspace, target);
  if (external && (!context.callPlan?.exactEffects.includes("filesystem.read.external")
    || context.approval?.externalReadApproved !== true)) {
    throw Object.assign(new Error(`External image read lacks a fresh grant: ${requested}`), {
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
    summary: `Inspected external image input '${requested}'.`,
    data: {
      path: target,
      scope: "external",
      sha256: loaded.sha256,
      byteLength: loaded.byteLength
    }
  }];
}

async function executeImageInspection(
  request: ToolRequest,
  context: PlannedToolExecutionContext
): Promise<ToolReceipt> {
  const startedAt = new Date().toISOString();
  const input = args(request.arguments);
  const requested = stringArg(input, "path");
  const layout = ocrLayout(input.layout);
  const { target, external } = await approvedImageLocation(requested, context);
  const loaded = await readStableWorkspaceFile(
    context.workspacePath,
    requested,
    context.signal,
    {
      maxBytes: MAX_IMAGE_INSPECTION_BYTES,
      allowExternalAbsolutePath: external
    }
  );
  const image = supportedImage(loaded.bytes);
  if (!image) {
    throw Object.assign(
      new Error(
        `Cannot inspect image '${requested}': its bytes are not a supported PNG, JPEG, GIF, WebP, BMP, TIFF, or PNM image.`
      ),
      { code: "image_inspection_unsupported_format" }
    );
  }
  let recognized: { text: string; confidence: number };
  try {
    recognized = await recognizeEnglishText(
      loaded.bytes,
      layout,
      context,
      "Inspecting image"
    );
  } catch (error) {
    context.signal.throwIfAborted();
    throw Object.assign(
      new Error(
        `Cannot inspect image '${requested}': the local OCR engine failed.`,
        error instanceof Error ? { cause: error } : undefined
      ),
      { code: "image_inspection_failed" }
    );
  }
  const output = recognized.text.length > 0
    ? recognized.text
    : "No English text was recognized in this image.";
  return receipt(request, startedAt, {
    output,
    result: {
      status: "inspected",
      path: requested,
      scope: external ? "external" : "workspace",
      format: image.format,
      mediaType: image.mediaType,
      byteLength: loaded.byteLength,
      sha256: loaded.sha256,
      engine: "tesseract.js",
      language: "eng",
      layout,
      confidence: recognized.confidence,
      textLength: recognized.text.length
    },
    observedEffects: external
      ? ["filesystem.read", "filesystem.read.external"] : ["filesystem.read"],
    evidence: external ? inputEvidence(request, context, requested, target, loaded) : []
  });
}

export function imageInspectionTool(readScope: "workspace" | "host"): RegisteredEffectTool {
  return {
    descriptor: descriptor({
      name: "inspect_image",
      description: `Extract English text from a raster image with bundled local OCR (maximum ${MAX_IMAGE_INSPECTION_BYTES} bytes). Use this for image inputs when the main model cannot receive pixels. It never uses the network or modifies the workspace. OCR may be imperfect; inspect the returned text and validate task results independently.`,
      properties: {
        path: { type: "string" },
        layout: {
          type: "string",
          enum: ["auto", "single_block", "sparse_text"],
          description: "Optional OCR layout hint. Use auto unless the image is clearly one text block or sparse labels."
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
      timeoutMs: 120_000,
      async prepare(argumentsValue, context) {
        return await prepareImagePlan(readScope, argumentsValue, context);
      }
    }),
    async execute(request, context) {
      return await executeImageInspection(request, context);
    }
  };
}
