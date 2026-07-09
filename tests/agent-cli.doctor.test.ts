import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { runDoctorCommand } from "../packages/agent-cli/src/commands/doctor.js";

class MemoryWritable extends Writable {
  readonly chunks: string[] = [];

  _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk);
    callback();
  }

  text(): string {
    return this.chunks.join("");
  }
}

async function workspace(): Promise<string> {
  return await mkdtemp(path.join(os.tmpdir(), "sigma-cli-doctor-"));
}

function withoutProviderKeys<T>(fn: () => Promise<T>): Promise<T> {
  const previous = {
    DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
    GLM_API_KEY: process.env.GLM_API_KEY,
    ZAI_API_KEY: process.env.ZAI_API_KEY,
    BIGMODEL_API_KEY: process.env.BIGMODEL_API_KEY
  };
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.GLM_API_KEY;
  delete process.env.ZAI_API_KEY;
  delete process.env.BIGMODEL_API_KEY;
  return fn().finally(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

describe("agent-cli doctor", () => {
  it("prints structured readiness JSON with checks", async () => {
    await withoutProviderKeys(async () => {
      const dir = await workspace();
      const stdout = new MemoryWritable();

      await expect(runDoctorCommand(["--workspace", dir, "--provider", "deepseek", "--json"], { stdout })).resolves.toBe(0);

      const report = JSON.parse(stdout.text()) as {
        status: string;
        strict: boolean;
        workspace: { accessible: boolean };
        checks: Array<{ name: string; status: string; recommendation?: string }>;
      };
      expect(report.status).toBe("warning");
      expect(report.strict).toBe(false);
      expect(report.workspace.accessible).toBe(true);
      expect(report.checks).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "workspace", status: "ok" }),
        expect.objectContaining({ name: "provider_key", status: "warning" }),
        expect.objectContaining({ name: "api", status: "skipped" })
      ]));
    });
  });

  it("returns non-zero for warnings in strict mode", async () => {
    await withoutProviderKeys(async () => {
      const dir = await workspace();
      const stdout = new MemoryWritable();

      await expect(runDoctorCommand(["--workspace", dir, "--provider", "deepseek", "--strict", "--json"], { stdout })).resolves.toBe(1);

      const report = JSON.parse(stdout.text()) as { status: string; strict: boolean };
      expect(report).toMatchObject({ status: "warning", strict: true });
    });
  });

  it("returns an error readiness status for inaccessible workspaces", async () => {
    const missing = path.join(os.tmpdir(), `sigma-missing-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const stdout = new MemoryWritable();

    await expect(runDoctorCommand(["--workspace", missing, "--json"], { stdout })).resolves.toBe(1);

    const report = JSON.parse(stdout.text()) as {
      status: string;
      workspace: { accessible: boolean };
      checks: Array<{ name: string; status: string }>;
    };
    expect(report.status).toBe("error");
    expect(report.workspace.accessible).toBe(false);
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "workspace", status: "error" })
    ]));
  });

  it("prints doctor help", async () => {
    const stdout = new MemoryWritable();

    await expect(runDoctorCommand(["--help"], { stdout })).resolves.toBe(0);

    expect(stdout.text()).toContain("agent doctor [flags]");
    expect(stdout.text()).toContain("--strict");
  });
});
