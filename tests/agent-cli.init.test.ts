import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { loadCliConfig } from "../packages/agent-cli/src/config.js";
import { runInitCommand } from "../packages/agent-cli/src/commands/init.js";

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
  return await mkdtemp(path.join(os.tmpdir(), "sigma-cli-init-"));
}

describe("agent-cli init", () => {
  it("creates a local workspace config that loadCliConfig can consume", async () => {
    const dir = await workspace();
    const stdout = new MemoryWritable();

    const code = await runInitCommand([
      "--workspace",
      dir,
      "--provider",
      "glm",
      "--model",
      "glm-test",
      "--validation-mode",
      "auto"
    ], { stdout });

    expect(code).toBe(0);
    expect(stdout.text()).toContain("initialized");
    expect(stdout.text()).toContain("profile=local");

    const configPath = path.join(dir, ".agent", "config.toml");
    const text = await readFile(configPath, "utf8");
    expect(text).toContain('provider = "glm"');
    expect(text).toContain('model = "glm-test"');
    expect(text).toContain('permission_mode = "ask"');

    const config = loadCliConfig({ workspace: dir });
    expect(config.provider).toBe("glm");
    expect(config.model).toBe("glm-test");
    expect(config.permissionMode).toBe("ask");
    expect(config.validationMode).toBe("auto");
  });

  it("refuses to overwrite existing config unless --force is supplied", async () => {
    const dir = await workspace();
    await mkdir(path.join(dir, ".agent"), { recursive: true });
    const first = new MemoryWritable();
    const second = new MemoryWritable();
    const third = new MemoryWritable();

    await expect(runInitCommand(["--workspace", dir], { stdout: first })).resolves.toBe(0);
    await expect(runInitCommand(["--workspace", dir], { stderr: second })).resolves.toBe(1);
    expect(second.text()).toContain("already exists");

    await expect(runInitCommand(["--workspace", dir, "--profile", "team", "--force", "--json"], { stdout: third })).resolves.toBe(0);
    const report = JSON.parse(third.text()) as { ok: boolean; profile: string; sandboxRequired: boolean };
    expect(report).toMatchObject({ ok: true, profile: "team", sandboxRequired: true });
  });

  it("writes CI profile defaults for automation", async () => {
    const dir = await workspace();
    const stdout = new MemoryWritable();

    await expect(runInitCommand(["--workspace", dir, "--profile", "ci"], { stdout })).resolves.toBe(0);

    const text = await readFile(path.join(dir, ".agent", "config.toml"), "utf8");
    expect(text).toContain("# Profile: ci");
    expect(text).toContain('permission_mode = "yolo"');
    expect(text).toContain("required = true");
    expect(text).toContain('output_format = "json"');
    expect(text).toContain("quiet = true");
  });
});
