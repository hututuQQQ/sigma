import {
  mkdir,
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
  MAX_IMAGE_INSPECTION_BYTES,
  readStableWorkspaceFile,
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
    sessionId: "image-inspection-session",
    runId: "image-inspection-run",
    workspacePath,
    runMode: "analyze",
    signal: new AbortController().signal,
    heartbeat: () => undefined,
    progress: async () => undefined,
    createArtifact: async ({ name }) => name
  };
}

function request(callId: string, argumentsValue: JsonValue): ToolRequest {
  return { callId, name: "inspect_image", arguments: argumentsValue };
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

function portableBitmap(text: string): Buffer {
  const scale = 12;
  const padding = 30;
  const width = padding * 2 + (text.length * 6 - 1) * scale;
  const height = padding * 2 + 7 * scale;
  const pixels = Array.from({ length: height }, () => Array<number>(width).fill(0));
  for (const [index, character] of [...text].entries()) {
    const glyph = glyphs[character];
    if (!glyph) throw new Error(`Missing test glyph '${character}'.`);
    for (const [row, pattern] of glyph.entries()) {
      for (const [column, enabled] of [...pattern].entries()) {
        if (enabled !== "1") continue;
        for (let y = 0; y < scale; y += 1) {
          for (let x = 0; x < scale; x += 1) {
            pixels[padding + row * scale + y]![padding + index * 6 * scale + column * scale + x] = 1;
          }
        }
      }
    }
  }
  return Buffer.from(
    `P1\n${width} ${height}\n${pixels.map((row) => row.join(" ")).join("\n")}\n`,
    "ascii"
  );
}

describe("local image inspection", () => {
  it("registers an objective read-only, offline tool contract", async () => {
    const workspace = await temporaryDirectory("sigma-image-contract-");
    await writeFile(path.join(workspace, "input.pbm"), portableBitmap("OCR 314"));
    const tools = registerBuiltinTools(new EffectToolRegistry());
    const descriptor = tools.descriptor("inspect_image");
    expect(descriptor).toMatchObject({
      approval: "auto",
      possibleEffects: ["filesystem.read"],
      maximumEffects: ["filesystem.read", "filesystem.read.external"],
      idempotent: true
    });

    const call = request("image-plan", { path: "input.pbm" });
    await expect(tools.prepare(call, {
      sessionId: "image-inspection-session",
      runId: "image-inspection-run",
      workspacePath: workspace,
      runMode: "analyze"
    })).resolves.toMatchObject({
      exactEffects: ["filesystem.read"],
      readPaths: ["input.pbm"],
      writePaths: [],
      network: "none",
      processMode: "none",
      idempotence: "read_only"
    });
  });

  it("extracts text with bundled language data without modifying the workspace", async () => {
    const workspace = await temporaryDirectory("sigma-image-ocr-");
    await writeFile(path.join(workspace, "input.pbm"), portableBitmap("OCR 314"));
    const tools = registerBuiltinTools(new EffectToolRegistry());

    const result = await tools.execute(
      request("image-ocr", { path: "input.pbm", layout: "single_block" }),
      context(workspace)
    );

    expect(result.output.trim().length).toBeGreaterThan(0);
    expect(result.result).toMatchObject({
      status: "inspected",
      path: "input.pbm",
      scope: "workspace",
      format: "pnm",
      mediaType: "image/x-portable-anymap",
      engine: "tesseract.js",
      language: "eng",
      layout: "single_block",
      byteLength: expect.any(Number),
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      confidence: expect.any(Number),
      textLength: expect.any(Number)
    });
    expect(result.observedEffects).toEqual(["filesystem.read"]);
    expect(await readdir(workspace)).toEqual(["input.pbm"]);
  }, 30_000);

  it("reads arbitrary bytes through the same stable containment primitive", async () => {
    const workspace = await temporaryDirectory("sigma-image-bytes-");
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00]);
    await writeFile(path.join(workspace, "binary.dat"), bytes);

    const loaded = await readStableWorkspaceFile(
      workspace,
      "binary.dat",
      new AbortController().signal
    );

    expect(loaded.bytes.equals(bytes)).toBe(true);
    expect(loaded).toMatchObject({
      byteLength: bytes.byteLength,
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/u)
    });
  });

  it("rejects unsupported bytes and oversized media before invoking OCR", async () => {
    const workspace = await temporaryDirectory("sigma-image-reject-");
    await writeFile(path.join(workspace, "not-image.bin"), "not an image", "utf8");
    await writeFile(
      path.join(workspace, "oversized.png"),
      Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.alloc(MAX_IMAGE_INSPECTION_BYTES, 0)
      ])
    );
    const tools = registerBuiltinTools(new EffectToolRegistry());

    await expect(tools.execute(
      request("not-image", { path: "not-image.bin" }),
      context(workspace)
    )).rejects.toMatchObject({ code: "image_inspection_unsupported_format" });
    await expect(tools.execute(
      request("oversized", { path: "oversized.png" }),
      context(workspace)
    )).rejects.toMatchObject({ code: "workspace_read_too_large" });
  });

  it("keeps host inputs behind the existing external-read grant", async () => {
    const workspace = await temporaryDirectory("sigma-image-workspace-");
    const external = await temporaryDirectory("sigma-image-external-");
    const inputPath = path.join(external, "input.pbm");
    await mkdir(path.join(workspace, "nested"));
    await writeFile(inputPath, portableBitmap("OCR 314"));
    const strict = registerBuiltinTools(new EffectToolRegistry(), { readScope: "workspace" });
    await expect(strict.prepare(request("strict-image", { path: inputPath }), {
      sessionId: "image-inspection-session",
      runId: "image-inspection-run",
      workspacePath: workspace,
      runMode: "analyze"
    })).rejects.toMatchObject({ code: "policy_denied" });

    const host = registerBuiltinTools(new EffectToolRegistry(), { readScope: "host" });
    const call = request("host-image", { path: inputPath });
    const plan = await host.prepare(call, {
      sessionId: "image-inspection-session",
      runId: "image-inspection-run",
      workspacePath: workspace,
      runMode: "analyze"
    });
    await expect(host.execute(call, { ...context(workspace), callPlan: plan }))
      .rejects.toMatchObject({ code: "per_call_approval_required" });
  });
});
