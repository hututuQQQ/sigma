import { PassThrough, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type {
  AuthEvent,
  AuthPrompt,
  PiLoginInteraction
} from "../packages/agent-pi/src/index.js";
import { runAuthCommand } from "../packages/agent-cli/src/commands/auth.js";

class Capture extends Writable {
  readonly chunks: Buffer[] = [];

  _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void
  ): void {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    callback();
  }

  text(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }

  jsonLines(): Array<Record<string, unknown>> {
    return this.text().trim().split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }
}

describe("sigma auth machine protocol", () => {
  it("reports local status and logout as JSON without diagnostics on stdout", async () => {
    const stdout = new Capture();
    const stderr = new Capture();
    const status = vi.fn(async () => ({
      provider: "openai-codex" as const,
      status: "authenticated" as const,
      email: "person@example.test",
      expiresAt: 123
    }));
    const logout = vi.fn(async () => undefined);

    expect(await runAuthCommand(
      ["status", "openai-codex", "--json"],
      { stdout, stderr, status }
    )).toBe(0);
    expect(stdout.jsonLines()).toEqual([{
      provider: "openai-codex",
      status: "authenticated",
      email: "person@example.test",
      expiresAt: 123
    }]);
    expect(stderr.text()).toBe("");

    const logoutOutput = new Capture();
    expect(await runAuthCommand(
      ["logout", "openai-codex", "--json"],
      { stdout: logoutOutput, stderr, logout }
    )).toBe(0);
    expect(logoutOutput.jsonLines()).toEqual([{
      type: "completed",
      provider: "openai-codex",
      status: "unauthenticated"
    }]);
    expect(logout).toHaveBeenCalledOnce();
  });

  it("streams browser URL, manual-code input, progress, and completion as JSONL", async () => {
    const stdin = new PassThrough();
    const stdout = new Capture();
    const stderr = new Capture();
    const login = vi.fn(async (
      provider: string,
      method: string,
      interaction: PiLoginInteraction
    ) => {
      expect(provider).toBe("openai-codex");
      expect(method).toBe("browser");
      interaction.notify({
        type: "auth_url",
        url: "https://auth.example.test/authorize?state=ephemeral",
        instructions: "Open the browser."
      });
      interaction.notify({ type: "progress", message: "Waiting for callback." });
      const code = await interaction.prompt({
        type: "manual_code",
        message: "Paste the authorization code.",
        placeholder: "code#state"
      });
      expect(code).toBe("manual-code-secret");
      return {
        provider: "openai-codex" as const,
        status: "authenticated" as const,
        email: "person@example.test"
      };
    });

    const operation = runAuthCommand(
      ["login", "openai-codex", "--method", "browser", "--json"],
      { stdin, stdout, stderr, login }
    );
    await vi.waitFor(() => {
      expect(stdout.jsonLines().some((event) => event.type === "input_required")).toBe(true);
    });
    const prompt = stdout.jsonLines().find((event) => event.type === "input_required")!;
    stdin.write(`${JSON.stringify({
      type: "input_response",
      promptId: prompt.promptId,
      value: "manual-code-secret"
    })}\n`);

    expect(await operation).toBe(0);
    expect(stdout.jsonLines()).toEqual([
      {
        type: "auth_url",
        url: "https://auth.example.test/authorize?state=ephemeral",
        instructions: "Open the browser."
      },
      { type: "progress", message: "Waiting for callback." },
      {
        type: "input_required",
        promptId: expect.any(String),
        inputType: "manual_code",
        message: "Paste the authorization code.",
        placeholder: "code#state"
      },
      {
        type: "completed",
        provider: "openai-codex",
        status: "authenticated",
        email: "person@example.test"
      }
    ]);
    expect(stdout.text()).not.toContain("manual-code-secret");
    expect(stderr.text()).toBe("");
  });

  it("supports device-code events and cancellation without leaking provider errors", async () => {
    const stdin = new PassThrough();
    const stdout = new Capture();
    const stderr = new Capture();
    const login = vi.fn(async (
      provider: string,
      method: string,
      interaction: PiLoginInteraction
    ) => {
      expect(provider).toBe("openai-codex");
      expect(method).toBe("device-code");
      const event: AuthEvent = {
        type: "device_code",
        userCode: "ABCD-EFGH",
        verificationUri: "https://auth.example.test/device",
        intervalSeconds: 5,
        expiresInSeconds: 900
      };
      interaction.notify(event);
      const prompt: AuthPrompt = { type: "text", message: "Waiting." };
      await interaction.prompt(prompt);
      throw new Error("provider-secret-that-must-not-escape");
    });

    const operation = runAuthCommand(
      ["login", "openai-codex", "--method", "device-code", "--json"],
      { stdin, stdout, stderr, login }
    );
    await vi.waitFor(() => {
      expect(stdout.jsonLines().some((event) => event.type === "input_required")).toBe(true);
    });
    stdin.write(`${JSON.stringify({ type: "cancel" })}\n`);

    expect(await operation).toBe(130);
    expect(stdout.jsonLines()).toEqual([
      {
        type: "device_code",
        userCode: "ABCD-EFGH",
        verificationUri: "https://auth.example.test/device",
        intervalSeconds: 5,
        expiresInSeconds: 900
      },
      {
        type: "input_required",
        promptId: expect.any(String),
        inputType: "text",
        message: "Waiting."
      },
      {
        type: "error",
        code: "cancelled",
        message: "Authentication was cancelled.",
        retryable: false
      }
    ]);
    expect(stdout.text()).not.toContain("provider-secret-that-must-not-escape");
    expect(stderr.text()).toBe("");
  });
});
