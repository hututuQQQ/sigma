import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  readCredentialBridgeStore,
  SIGMA_CREDENTIAL_UPDATE_PREFIX
} from "../packages/agent-pi/src/credential-bridge.js";

const nonce = "0123456789abcdef0123456789abcdef";
const initial = {
  type: "oauth" as const,
  access: "initial-access",
  refresh: "initial-refresh",
  expires: 1
};

function bootstrap(credential = initial): string {
  return JSON.stringify({
    version: 1,
    nonce,
    provider: "openai-codex",
    credential
  });
}

function outputSink(write: (line: string, callback: (error?: Error | null) => void) => void):
NodeJS.WritableStream {
  return {
    write(chunk: string | Uint8Array, callback?: (error?: Error | null) => void) {
      write(String(chunk), callback ?? (() => undefined));
      return true;
    }
  } as unknown as NodeJS.WritableStream;
}

function update(line: string): Record<string, unknown> {
  const prefix = `${SIGMA_CREDENTIAL_UPDATE_PREFIX}${nonce}:`;
  expect(line.startsWith(prefix)).toBe(true);
  return JSON.parse(
    Buffer.from(line.slice(prefix.length).trim(), "base64url").toString("utf8")
  ) as Record<string, unknown>;
}

describe("credential stdio bridge", () => {
  it("scopes reads and emits ordered replace/delete updates without leaking state", async () => {
    const lines: string[] = [];
    const store = await readCredentialBridgeStore({
      input: Readable.from([bootstrap()]),
      output: outputSink((line, callback) => {
        lines.push(line);
        callback();
      })
    });

    expect(await store.read("openai-codex")).toEqual(initial);
    expect(await store.read("deepseek")).toBeUndefined();
    expect(await store.list()).toEqual([{ providerId: "openai-codex", type: "oauth" }]);
    await expect(store.modify("deepseek", async () => initial)).rejects.toThrow(
      "credential_bridge_scope_violation"
    );

    const rotated = { ...initial, access: "rotated-access", refresh: "rotated-refresh" };
    await expect(store.modify("openai-codex", async () => rotated)).resolves.toEqual(rotated);
    await store.delete("openai-codex");

    expect(update(lines[0]!)).toEqual({
      version: 1,
      sequence: 1,
      operation: "replace",
      provider: "openai-codex",
      credential: rotated
    });
    expect(update(lines[1]!)).toEqual({
      version: 1,
      sequence: 2,
      operation: "delete",
      provider: "openai-codex"
    });
    expect(await store.read("openai-codex")).toBeUndefined();
  });

  it("does not mutate memory or consume a sequence when stdout rejects an update", async () => {
    const lines: string[] = [];
    let attempts = 0;
    const store = await readCredentialBridgeStore({
      input: Readable.from([bootstrap()]),
      output: outputSink((line, callback) => {
        attempts += 1;
        if (attempts === 1) callback(new Error("launcher pipe closed"));
        else {
          lines.push(line);
          callback();
        }
      })
    });
    const rejected = { ...initial, access: "must-not-stick" };
    await expect(store.modify("openai-codex", async () => rejected)).rejects.toThrow(
      "launcher pipe closed"
    );
    expect(await store.read("openai-codex")).toEqual(initial);

    const accepted = { ...initial, access: "accepted" };
    await expect(store.modify("openai-codex", async () => accepted)).resolves.toEqual(accepted);
    expect(update(lines[0]!)).toMatchObject({ sequence: 1, credential: accepted });
  });

  it("rejects malformed and oversized bootstraps", async () => {
    await expect(readCredentialBridgeStore({
      input: Readable.from(["not-json"]),
      output: outputSink((_line, callback) => callback())
    })).rejects.toThrow("bootstrap is not valid JSON");
    await expect(readCredentialBridgeStore({
      input: Readable.from(["x".repeat(1_048_577)]),
      output: outputSink((_line, callback) => callback())
    })).rejects.toThrow("bootstrap exceeds the size limit");
  });
});
