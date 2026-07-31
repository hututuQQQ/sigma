import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { runModelsCommand } from "../packages/agent-cli/src/commands/models.js";

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
}

const catalog = {
  schemaVersion: 1 as const,
  piVersion: "0.82.1",
  providers: [{
    id: "example",
    name: "Example",
    dynamic: true,
    authMethods: [{
      id: "api-key",
      label: "API key",
      kind: "api_key" as const,
      billingMode: "unpriced" as const
    }],
    status: "authenticated" as const,
    authType: "api_key" as const,
    source: "environment"
  }],
  models: [{
    provider: "example",
    id: "model",
    slug: "example/model",
    name: "Example Model",
    api: "openai-completions",
    contextWindowTokens: 32_000,
    maxOutputTokens: 8_000,
    reasoning: false,
    imageInput: false,
    billingModes: ["unpriced" as const],
    activeBillingMode: "unpriced" as const,
    isRecommended: false
  }]
};

describe("sigma models machine protocol", () => {
  it("lists the offline catalog and active billing type as one JSON document", async () => {
    const stdout = new Capture();
    const stderr = new Capture();
    expect(await runModelsCommand(
      ["list", "--json"],
      { stdout, stderr, catalog: async () => catalog }
    )).toBe(0);
    expect(JSON.parse(stdout.text())).toEqual(catalog);
    expect(stderr.text()).toBe("");
  });

  it("refreshes only an explicitly selected provider", async () => {
    const stdout = new Capture();
    const stderr = new Capture();
    const refresh = vi.fn(async () => 17);
    expect(await runModelsCommand(
      ["refresh", "radius", "--json"],
      { stdout, stderr, refresh }
    )).toBe(0);
    expect(refresh).toHaveBeenCalledWith("radius");
    expect(JSON.parse(stdout.text())).toEqual({
      type: "completed",
      provider: "radius",
      modelCount: 17
    });
    expect(stderr.text()).toBe("");
  });

  it("does not expose provider URLs, response bodies, or credentials on refresh failure", async () => {
    const stdout = new Capture();
    const stderr = new Capture();
    const secret = "provider-secret-token";
    expect(await runModelsCommand(
      ["refresh", "radius", "--json"],
      {
        stdout,
        stderr,
        refresh: async () => {
          throw new Error(`https://provider.example.test/models failed with ${secret}`);
        }
      }
    )).toBe(2);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toBe("The model provider response could not be processed.\n");
    expect(stderr.text()).not.toContain(secret);
    expect(stderr.text()).not.toContain("provider.example.test");
  });
});
