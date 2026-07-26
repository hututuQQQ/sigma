import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import { BrokerPolicyError, BrokerProtocolError } from "../packages/agent-execution/src/errors.js";
import type { BrokerTransport } from "../packages/agent-execution/src/broker-transport.js";
import { requestBrokerWeb } from "../packages/agent-execution/src/broker-client-web.js";
import { SecretRedactor } from "../packages/agent-execution/src/redaction.js";
import type { WebRequest } from "../packages/agent-execution/src/types.js";

function transportResponse(value: unknown): {
  transport: BrokerTransport;
  request: ReturnType<typeof vi.fn>;
} {
  const request = vi.fn().mockResolvedValue(value);
  return { transport: { request } as unknown as BrokerTransport, request };
}

function pageRequest(overrides: Partial<WebRequest> = {}): WebRequest {
  return {
    url: "https://example.com/article",
    method: "GET",
    headers: { accept: "text/html", "user-agent": "Sigma-Code-Web/1" },
    networkTargets: [{ origin: "https://example.com", method: "GET" }],
    networkApproved: true,
    ...overrides
  };
}

function response(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: 200,
    finalUrl: "https://example.com/article",
    headers: { "content-type": "text/plain" },
    bodyBase64: Buffer.from("secret-value", "utf8").toString("base64"),
    truncated: false,
    redacted: true,
    ...overrides
  };
}

describe("broker Web request boundary", () => {
  it("binds the exact origin and redacts response bytes", async () => {
    const fixture = transportResponse(response());
    const value = await requestBrokerWeb(
      fixture.transport,
      new SecretRedactor({ provider: "secret-value" }),
      pageRequest(),
      { timeoutMs: 30_000 }
    );

    expect(fixture.request).toHaveBeenCalledWith("web.request", expect.objectContaining({
      url: "https://example.com/article",
      method: "GET",
      bodyBase64: "",
      networkTargets: [{ origin: "https://example.com", method: "GET" }],
      networkApproved: true
    }), { timeoutMs: 30_000 });
    expect(Buffer.from(value.body).toString("utf8")).toBe("[REDACTED:provider]");
  });

  it("rejects widened methods, origins, ports, bodies, and headers before dispatch", async () => {
    const fixture = transportResponse(response());
    const invalid = [
      pageRequest({ method: "POST" }),
      pageRequest({ networkApproved: false }),
      pageRequest({ networkTargets: [{ origin: "https://other.example", method: "GET" }] }),
      pageRequest({ url: "https://example.com:8443/article" }),
      pageRequest({ body: Buffer.from("not allowed") }),
      pageRequest({ headers: { cookie: "session=secret" } }),
      pageRequest({ headers: { "x-api-key": "secret" } })
    ];
    for (const request of invalid) {
      await expect(requestBrokerWeb(
        fixture.transport, new SecretRedactor(), request, {}
      )).rejects.toBeInstanceOf(BrokerPolicyError);
    }
    expect(fixture.request).not.toHaveBeenCalled();
  });

  it("permits provider headers only on the fixed Exa POST endpoint", async () => {
    const fixture = transportResponse(response({
      finalUrl: "https://mcp.exa.ai/mcp",
      bodyBase64: Buffer.from("{}", "utf8").toString("base64")
    }));
    await expect(requestBrokerWeb(
      fixture.transport,
      new SecretRedactor(),
      {
        url: "https://mcp.exa.ai/mcp",
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "mcp-protocol-version": "2025-06-18",
          "x-api-key": "secret"
        },
        body: Buffer.from("{}"),
        networkTargets: [{ origin: "https://mcp.exa.ai", method: "POST" }],
        networkApproved: true
      },
      {}
    )).resolves.toMatchObject({ status: 200 });

    await expect(requestBrokerWeb(
      fixture.transport,
      new SecretRedactor(),
      {
        url: "https://example.com/mcp",
        method: "POST",
        body: Buffer.from("{}"),
        networkTargets: [{ origin: "https://example.com", method: "POST" }],
        networkApproved: true
      },
      {}
    )).rejects.toBeInstanceOf(BrokerPolicyError);

    for (const url of [
      "https://mcp.exa.ai/mcp?tools=web_search_exa",
      "https://mcp.exa.ai/mcp?tools=web_search_exa,web_search_advanced_exa,web_fetch_exa"
    ]) {
      await expect(requestBrokerWeb(
        fixture.transport,
        new SecretRedactor(),
        {
          url,
          method: "POST",
          body: Buffer.from("{}"),
          networkTargets: [{ origin: "https://mcp.exa.ai", method: "POST" }],
          networkApproved: true
        },
        {}
      )).rejects.toBeInstanceOf(BrokerPolicyError);
    }
  });

  it("rejects malformed or oversized broker responses", async () => {
    for (const value of [
      response({ status: 99 }),
      response({ bodyBase64: "not base64" }),
      response({ headers: { "content-type": 42 } }),
      response({ bodyBase64: Buffer.alloc(5 * 1_024 * 1_024 + 1).toString("base64") })
    ]) {
      const fixture = transportResponse(value);
      await expect(requestBrokerWeb(
        fixture.transport, new SecretRedactor(), pageRequest(), {}
      )).rejects.toBeInstanceOf(BrokerProtocolError);
    }
  });
});
