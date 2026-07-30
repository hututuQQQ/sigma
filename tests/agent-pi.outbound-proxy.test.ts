import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  configureOutboundProxy,
  resolveOutboundProxyEnvironment
} from "../packages/agent-pi/src/index.js";

afterEach(() => {
  configureOutboundProxy({});
});

describe("outbound provider proxy", () => {
  it("uses valid protocol-specific proxies without failing on malformed siblings", () => {
    expect(resolveOutboundProxyEnvironment({
      http_proxy: "htpp://127.0.0.1:1",
      https_proxy: "http://secure-proxy.example:8443",
      all_proxy: "fallback-proxy.example:8080",
      no_proxy: "internal.example"
    })).toEqual({
      HTTP_PROXY: "http://fallback-proxy.example:8080",
      HTTPS_PROXY: "http://secure-proxy.example:8443",
      NO_PROXY: "internal.example,localhost,127.0.0.1,::1"
    });
  });

  it("applies HTTP_PROXY to HTTPS and always bypasses loopback traffic", () => {
    expect(resolveOutboundProxyEnvironment({
      HTTP_PROXY: "http://proxy.example:8080"
    })).toEqual({
      HTTP_PROXY: "http://proxy.example:8080",
      HTTPS_PROXY: "http://proxy.example:8080",
      NO_PROXY: "localhost,127.0.0.1,::1"
    });
    expect(resolveOutboundProxyEnvironment({
      HTTPS_PROXY: "socks5://proxy.example:1080",
      NO_PROXY: "*"
    })).toBeUndefined();
  });

  it("routes global fetch through the configured proxy", async () => {
    const requests: string[] = [];
    const proxy = createServer((request, response) => {
      requests.push(request.url ?? "");
      response.writeHead(204);
      response.end();
    });
    proxy.on("connect", (request, socket) => {
      requests.push(request.url ?? "");
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      socket.once("data", (data) => {
        requests.push(data.toString("utf8").split("\r\n", 1)[0] ?? "");
        socket.end(
          "HTTP/1.1 204 No Content\r\n"
          + "Content-Length: 0\r\n"
          + "Connection: close\r\n\r\n"
        );
      });
    });
    await new Promise<void>((resolve, reject) => {
      proxy.once("error", reject);
      proxy.listen(0, "127.0.0.1", resolve);
    });
    const address = proxy.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP proxy address.");

    try {
      configureOutboundProxy({
        HTTP_PROXY: `http://127.0.0.1:${address.port}`
      });
      const response = await fetch("http://provider.invalid/probe");
      expect(response.status).toBe(204);
      expect(requests).toEqual(["provider.invalid:80", "GET /probe HTTP/1.1"]);
    } finally {
      configureOutboundProxy({});
      await new Promise<void>((resolve, reject) => {
        proxy.close((error) => error ? reject(error) : resolve());
      });
    }
  });
});
