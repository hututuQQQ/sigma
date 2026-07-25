import { deflateSync } from "node:zlib";
import {
  mkdtemp,
  readdir,
  rm,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  JsonValue,
  ToolExecutionContext,
  ToolRequest
} from "../packages/agent-protocol/src/index.js";
import {
  EffectToolRegistry,
  MAX_DOCUMENT_INSPECTION_BYTES,
  registerBuiltinTools
} from "../packages/agent-tools/src/index.js";

const temporaryPaths: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryPaths.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map(async (directory) => {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }));
});

function context(workspacePath: string): ToolExecutionContext {
  return {
    sessionId: "document-inspection-session",
    runId: "document-inspection-run",
    workspacePath,
    runMode: "analyze",
    signal: new AbortController().signal,
    heartbeat: () => undefined,
    progress: async () => undefined,
    createArtifact: async ({ name }) => name
  };
}

function request(callId: string, argumentsValue: JsonValue): ToolRequest {
  return { callId, name: "inspect_document", arguments: argumentsValue };
}

function escapePdfText(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
}

function assemblePdf(objects: readonly Buffer[]): Buffer {
  const header = Buffer.from("%PDF-1.4\n% local document inspection fixture\n", "ascii");
  const body: Buffer[] = [header];
  const offsets: number[] = [0];
  let byteLength = header.byteLength;
  for (const [index, object] of objects.entries()) {
    offsets.push(byteLength);
    const record = Buffer.concat([
      Buffer.from(`${index + 1} 0 obj\n`, "ascii"),
      object,
      Buffer.from("\nendobj\n", "ascii")
    ]);
    body.push(record);
    byteLength += record.byteLength;
  }
  const xrefOffset = byteLength;
  const xref = Buffer.from([
    `xref\n0 ${objects.length + 1}\n`,
    "0000000000 65535 f \n",
    ...offsets.slice(1).map((offset) =>
      `${offset.toString().padStart(10, "0")} 00000 n \n`),
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`,
    `startxref\n${xrefOffset}\n%%EOF\n`
  ].join(""), "ascii");
  return Buffer.concat([...body, xref]);
}

function textPdf(pages: readonly string[]): Buffer {
  const fontObject = 3 + pages.length * 2;
  const pageObjects = pages.map((_page, index) => 3 + index * 2);
  const objects: Buffer[] = [
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>", "ascii"),
    Buffer.from(
      `<< /Type /Pages /Kids [${pageObjects.map((item) => `${item} 0 R`).join(" ")}] /Count ${pages.length} >>`,
      "ascii"
    )
  ];
  for (const [index, text] of pages.entries()) {
    const contentObject = 4 + index * 2;
    const content = Buffer.from(
      `BT\n/F1 30 Tf\n72 720 Td\n(${escapePdfText(text)}) Tj\nET`,
      "ascii"
    );
    objects.push(Buffer.from(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontObject} 0 R >> >> /Contents ${contentObject} 0 R >>`,
      "ascii"
    ));
    objects.push(Buffer.concat([
      Buffer.from(`<< /Length ${content.byteLength} >>\nstream\n`, "ascii"),
      content,
      Buffer.from("\nendstream", "ascii")
    ]));
  }
  objects.push(Buffer.from(
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "ascii"
  ));
  return assemblePdf(objects);
}

const glyphs: Record<string, readonly string[]> = {
  "O": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "C": ["01111", "10000", "10000", "10000", "10000", "10000", "01111"],
  "R": ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"]
};

function scannedTextPdf(text: string): Buffer {
  const scale = 12;
  const padding = 30;
  const width = padding * 2 + (text.length * 6 - 1) * scale;
  const height = padding * 2 + 7 * scale;
  const rgb = Buffer.alloc(width * height * 3);
  rgb.fill(255);
  for (const [index, character] of [...text].entries()) {
    const glyph = glyphs[character];
    if (!glyph) throw new Error(`Missing test glyph '${character}'.`);
    for (const [row, pattern] of glyph.entries()) {
      for (const [column, enabled] of [...pattern].entries()) {
        if (enabled !== "1") continue;
        for (let y = 0; y < scale; y += 1) {
          for (let x = 0; x < scale; x += 1) {
            const pixel = (
              (padding + row * scale + y) * width
              + padding + index * 6 * scale + column * scale + x
            ) * 3;
            rgb[pixel] = 0;
            rgb[pixel + 1] = 0;
            rgb[pixel + 2] = 0;
          }
        }
      }
    }
  }
  const image = deflateSync(rgb);
  const content = Buffer.from(
    `q\n${width} 0 0 ${height} 0 0 cm\n/Im0 Do\nQ`,
    "ascii"
  );
  return assemblePdf([
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>", "ascii"),
    Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "ascii"),
    Buffer.from(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>`,
      "ascii"
    ),
    Buffer.concat([
      Buffer.from(`<< /Length ${content.byteLength} >>\nstream\n`, "ascii"),
      content,
      Buffer.from("\nendstream", "ascii")
    ]),
    Buffer.concat([
      Buffer.from(
        `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${image.byteLength} >>\nstream\n`,
        "ascii"
      ),
      image,
      Buffer.from("\nendstream", "ascii")
    ])
  ]);
}

describe("local PDF document inspection", () => {
  it("registers an objective read-only, offline tool contract", async () => {
    const workspace = await temporaryDirectory("sigma-document-contract-");
    await writeFile(path.join(workspace, "input.pdf"), textPdf(["Contract sample"]));
    const tools = registerBuiltinTools(new EffectToolRegistry());
    const descriptor = tools.descriptor("inspect_document");

    expect(descriptor).toMatchObject({
      approval: "auto",
      possibleEffects: ["filesystem.read"],
      maximumEffects: ["filesystem.read", "filesystem.read.external"],
      contextPathArguments: ["path"],
      idempotent: true
    });
    await expect(tools.prepare(request("document-plan", { path: "input.pdf" }), {
      sessionId: "document-inspection-session",
      runId: "document-inspection-run",
      workspacePath: workspace,
      runMode: "analyze"
    })).resolves.toMatchObject({
      exactEffects: ["filesystem.read"],
      readPaths: ["input.pdf"],
      writePaths: [],
      network: "none",
      processMode: "none",
      idempotence: "read_only"
    });
  });

  it("extracts embedded text with explicit page and byte continuations", async () => {
    const workspace = await temporaryDirectory("sigma-document-text-");
    await writeFile(
      path.join(workspace, "input.pdf"),
      textPdf(["First embedded page", "Second embedded page"])
    );
    const tools = registerBuiltinTools(new EffectToolRegistry());

    const first = await tools.execute(request("document-first", {
      path: "input.pdf",
      startPage: 1,
      endPage: 1,
      maxBytes: 24,
      ocr: "never"
    }), context(workspace));

    expect(first.output).toContain("[Page 1;");
    expect(first.result).toMatchObject({
      status: "inspected",
      path: "input.pdf",
      scope: "workspace",
      format: "pdf",
      mediaType: "application/pdf",
      pageCount: 2,
      startPage: 1,
      endPage: 1,
      nextOffsetBytes: 24,
      eof: false,
      pages: [{
        page: 1,
        source: "embedded_text",
        textLength: expect.any(Number)
      }]
    });
    const result = first.result as Record<string, JsonValue>;
    expect(result.nextPage).toBeUndefined();
    const continued = await tools.execute(request("document-continued", {
      path: "input.pdf",
      startPage: 1,
      endPage: 1,
      offsetBytes: result.nextOffsetBytes,
      maxBytes: 64,
      ocr: "never"
    }), context(workspace));
    expect(continued.output).toContain("First embedded page");
    expect(continued.result).toMatchObject({
      eof: false,
      nextPage: 2
    });
    expect(await readdir(workspace)).toEqual(["input.pdf"]);
  });

  it("renders image-only pages and extracts text with bundled local OCR", async () => {
    const workspace = await temporaryDirectory("sigma-document-ocr-");
    await writeFile(path.join(workspace, "scan.pdf"), scannedTextPdf("OCR 314"));
    const tools = registerBuiltinTools(new EffectToolRegistry());

    const inspected = await tools.execute(request("document-ocr", {
      path: "scan.pdf",
      ocr: "auto",
      layout: "single_block"
    }), context(workspace));

    expect(inspected.output).toContain("[Page 1; source=ocr]");
    expect(inspected.output).not.toContain("No embedded or OCR text was recognized");
    expect(inspected.result).toMatchObject({
      status: "inspected",
      pageCount: 1,
      eof: true,
      pages: [{
        page: 1,
        source: "ocr",
        confidence: expect.any(Number),
        textLength: expect.any(Number)
      }]
    });
    const inspectedResult = inspected.result as {
      pages: Array<{ textLength: number }>;
    };
    expect(inspectedResult.pages[0]?.textLength).toBeGreaterThan(0);
    expect(inspected.observedEffects).toEqual(["filesystem.read"]);
    expect(await readdir(workspace)).toEqual(["scan.pdf"]);
  }, 60_000);

  it("rejects unsupported bytes and oversized documents before parsing", async () => {
    const workspace = await temporaryDirectory("sigma-document-reject-");
    await writeFile(path.join(workspace, "not-pdf.bin"), "not a PDF", "utf8");
    await writeFile(
      path.join(workspace, "oversized.pdf"),
      Buffer.concat([
        Buffer.from("%PDF-1.4\n", "ascii"),
        Buffer.alloc(MAX_DOCUMENT_INSPECTION_BYTES, 0)
      ])
    );
    const tools = registerBuiltinTools(new EffectToolRegistry());

    await expect(tools.execute(
      request("not-pdf", { path: "not-pdf.bin" }),
      context(workspace)
    )).rejects.toMatchObject({ code: "document_inspection_unsupported_format" });
    await expect(tools.execute(
      request("oversized", { path: "oversized.pdf" }),
      context(workspace)
    )).rejects.toMatchObject({ code: "workspace_read_too_large" });
  });

  it("keeps host PDFs behind the existing external-read grant", async () => {
    const workspace = await temporaryDirectory("sigma-document-workspace-");
    const external = await temporaryDirectory("sigma-document-external-");
    const inputPath = path.join(external, "input.pdf");
    await writeFile(inputPath, textPdf(["External input"]));
    const strict = registerBuiltinTools(new EffectToolRegistry(), { readScope: "workspace" });

    await expect(strict.prepare(request("strict-document", { path: inputPath }), {
      sessionId: "document-inspection-session",
      runId: "document-inspection-run",
      workspacePath: workspace,
      runMode: "analyze"
    })).rejects.toMatchObject({ code: "policy_denied" });

    const host = registerBuiltinTools(new EffectToolRegistry(), { readScope: "host" });
    const call = request("host-document", { path: inputPath });
    const plan = await host.prepare(call, {
      sessionId: "document-inspection-session",
      runId: "document-inspection-run",
      workspacePath: workspace,
      runMode: "analyze"
    });
    await expect(host.execute(call, { ...context(workspace), callPlan: plan }))
      .rejects.toMatchObject({ code: "per_call_approval_required" });
  });
});
