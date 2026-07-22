import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DockerCompatibleOciEngine,
  type OwnedOciCreateSpec
} from "../packages/agent-execution/src/index.js";

const roots: string[] = [];
const DIGEST = `sha256:${"d".repeat(64)}`;
const IMAGE_ID = `sha256:${"a".repeat(64)}`;
const TARGET_ID = "b".repeat(64);

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

function json(response: import("node:http").ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function multiplex(payload: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header[0] = 1;
  header.writeUInt32BE(payload.byteLength, 4);
  return Buffer.concat([header, payload]);
}

describe("DockerCompatibleOciEngine", () => {
  it.skipIf(process.platform === "win32")(
    "uses the fixed Docker-compatible Unix API for create, attach, inspect, and remove",
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "sigma-owned-engine-api-"));
      roots.push(root);
      const socketPath = path.join(root, "engine.sock");
      let createBody: Record<string, unknown> | undefined;
      let removed = false;
      let attachedInput = "";
      const server = createServer((request, response) => {
        const route = request.url ?? "";
        if (route === "/version") return json(response, 200, { ApiVersion: "1.52" });
        if (route.includes("/images/") && route.endsWith("/json")) {
          return json(response, 200, { Id: IMAGE_ID, RepoDigests: [`registry.example/image@${DIGEST}`] });
        }
        if (route.startsWith("/v1.52/containers/create?")) {
          const chunks: Buffer[] = [];
          request.on("data", (chunk: Buffer) => chunks.push(chunk));
          request.on("end", () => {
            createBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
            json(response, 201, { Id: TARGET_ID });
          });
          return;
        }
        if (route.endsWith(`/containers/${TARGET_ID}/start`)) {
          response.writeHead(204).end();
          return;
        }
        if (route.endsWith(`/containers/${TARGET_ID}/json`)) {
          return json(response, 200, {
            Id: TARGET_ID,
            Image: IMAGE_ID,
            State: { Running: true, StartedAt: "2026-07-19T08:00:00.000000000Z" },
            Config: { Labels: { "com.sigma.oci-owned": "v1" } },
            HostConfig: {
              NetworkMode: "none", CapAdd: ["CAP_SYS_ADMIN"], SecurityOpt: ["seccomp=unconfined"]
            },
            NetworkSettings: { Networks: { none: {} } },
            Mounts: [{ Type: "bind", Source: "/workspace", Destination: "/workspace", RW: true }]
          });
        }
        if (request.method === "DELETE" && route.includes(`/containers/${TARGET_ID}?`)) {
          removed = true;
          response.writeHead(204).end();
          return;
        }
        json(response, 404, { message: `unexpected route ${route}` });
      });
      server.on("upgrade", (request, socket) => {
        expect(request.url).toContain(`/containers/${TARGET_ID}/attach?`);
        socket.write("HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n");
        socket.once("data", (chunk) => {
          attachedInput = chunk.toString("utf8");
          socket.write(multiplex(Buffer.from("pong", "utf8")));
        });
      });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, resolve);
      });
      let attachedStream: import("node:stream").Duplex | undefined;
      try {
        const engine = new DockerCompatibleOciEngine("docker", socketPath);
        await expect(engine.probe()).resolves.toMatchObject({ apiVersion: "1.52" });
        await expect(engine.inspectImage(`registry.example/image@${DIGEST}`, DIGEST)).resolves.toEqual({
          imageId: IMAGE_ID,
          imageDigest: DIGEST
        });
        const spec: OwnedOciCreateSpec = {
          name: "sigma-owned-api-fixture",
          image: `registry.example/image@${DIGEST}`,
          workspace: "/workspace",
          helperPath: "/host/sigma-exec",
          helperTarget: "/opt/sigma-helper/sigma-exec",
          sandboxHelperPath: "/host/bwrap",
          sandboxHelperTarget: "/usr/local/bin/bwrap",
          artifactParent: "/tmp/sigma-artifacts",
          network: "none",
          labels: { "com.sigma.oci-owned": "v1" }
        };
        await expect(engine.createContainer(spec)).resolves.toBe(TARGET_ID);
        expect(createBody).toMatchObject({
          Image: spec.image,
          Entrypoint: [spec.helperTarget],
          WorkingDir: spec.workspace,
          Env: [`TMPDIR=${spec.artifactParent}`],
          User: "0:0",
          HostConfig: {
            NetworkMode: "none",
            CapAdd: ["SYS_ADMIN"],
            SecurityOpt: ["seccomp=unconfined"]
          }
        });
        const mounts = (createBody?.HostConfig as { Mounts?: unknown[] }).Mounts;
        expect(mounts).toEqual(expect.arrayContaining([
          { Type: "bind", Source: spec.helperPath, Target: spec.helperTarget, ReadOnly: true },
          {
            Type: "bind", Source: spec.sandboxHelperPath,
            Target: spec.sandboxHelperTarget, ReadOnly: true
          },
          { Type: "bind", Source: spec.workspace, Target: spec.workspace, ReadOnly: false }
        ]));
        expect(JSON.stringify(createBody)).not.toContain("API_KEY");
        await engine.startContainer(TARGET_ID);
        await expect(engine.inspectContainer(TARGET_ID)).resolves.toMatchObject({
          targetId: TARGET_ID,
          imageId: IMAGE_ID,
          networkMode: "none",
          networkNames: ["none"],
          capAdd: ["CAP_SYS_ADMIN"],
          securityOpt: ["seccomp=unconfined"]
        });
        attachedStream = await engine.attachContainer(TARGET_ID);
        const output = new Promise<string>((resolve) =>
          attachedStream!.once("data", (chunk) => resolve(chunk.toString("utf8"))));
        attachedStream.write("ping");
        await expect(output).resolves.toBe("pong");
        expect(attachedInput).toBe("ping");
        await engine.removeContainer(TARGET_ID);
        expect(removed).toBe(true);
      } finally {
        attachedStream?.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }
  );
});
