import http from "node:http";
import type { Socket } from "node:net";
import { Duplex } from "node:stream";
import { BrokerCancelledError, BrokerProtocolError } from "./errors.js";
import { OciEngineApiError, OciEngineCapabilityError } from "./oci-engine-errors.js";
import type {
  OwnedOciContainerInspection,
  OwnedOciCreateSpec,
  OwnedOciEngineCapabilities,
  OwnedOciEnginePort,
  OwnedOciImageIdentity,
  OwnedOciMountInspection
} from "./owned-oci-types.js";
import type { NetworkPolicy, ResolvedContainerEngine } from "./types.js";

export { OciEngineApiError, OciEngineCapabilityError } from "./oci-engine-errors.js";
export type * from "./owned-oci-types.js";

const MAX_ENGINE_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_MULTIPLEX_BUFFER_BYTES = 16 * 1024 * 1024;
const ENGINE_REQUEST_TIMEOUT_MS = 10_000;

interface EngineResponse {
  statusCode: number;
  body: Buffer;
}

function jsonRecord(source: Buffer, operation: string): Record<string, unknown> {
  try {
    const value = JSON.parse(source.toString("utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
    return value as Record<string, unknown>;
  } catch (error) {
    throw new OciEngineApiError(`OCI engine returned invalid JSON for ${operation}.`, operation, undefined, {
      cause: error
    });
  }
}

function errorMessage(body: Buffer): string {
  try {
    const parsed = JSON.parse(body.toString("utf8")) as { message?: unknown };
    if (typeof parsed.message === "string" && parsed.message) return parsed.message.slice(0, 4_096);
  } catch { /* use bounded text below */ }
  return body.toString("utf8").trim().slice(0, 4_096);
}

function createFailureCapability(spec: OwnedOciCreateSpec, body: Buffer): string | undefined {
  const detail = errorMessage(body);
  if (/\b(network|bridge|slirp4netns|pasta)\b/iu.test(detail)) return `network.${spec.network}`;
  if (/\b(CAP_SYS_ADMIN|SYS_ADMIN|seccomp|capabilit(?:y|ies))\b/iu.test(detail)) {
    return "sandbox.nested_isolation";
  }
  return undefined;
}

function assertStatus(response: EngineResponse, allowed: readonly number[], operation: string): void {
  if (allowed.includes(response.statusCode)) return;
  const detail = errorMessage(response.body);
  throw new OciEngineApiError(
    `OCI engine ${operation} failed with HTTP ${response.statusCode}${detail ? `: ${detail}` : ""}.`,
    operation,
    response.statusCode
  );
}

function networkMode(network: NetworkPolicy): string {
  return network === "full" ? "bridge" : "none";
}

function mountPayload(spec: OwnedOciCreateSpec): object[] {
  return [
    { Type: "bind", Source: spec.workspace, Target: spec.workspace, ReadOnly: false },
    { Type: "bind", Source: spec.helperPath, Target: spec.helperTarget, ReadOnly: true },
    { Type: "bind", Source: spec.sandboxHelperPath, Target: spec.sandboxHelperTarget, ReadOnly: true },
    { Type: "bind", Source: spec.artifactParent, Target: spec.artifactParent, ReadOnly: false }
  ];
}

function createPayload(spec: OwnedOciCreateSpec): object {
  return {
    Image: spec.image,
    Entrypoint: [spec.helperTarget],
    Cmd: [],
    WorkingDir: spec.workspace,
    Env: [`TMPDIR=${spec.artifactParent}`],
    Labels: spec.labels,
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    OpenStdin: true,
    StdinOnce: false,
    Tty: false,
    User: "0:0",
    HostConfig: {
      NetworkMode: networkMode(spec.network),
      Mounts: mountPayload(spec),
      CapAdd: ["SYS_ADMIN"],
      SecurityOpt: ["seccomp=unconfined"]
    }
  };
}

function parseLabels(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] =>
    typeof entry[1] === "string"));
}

function parseMounts(value: unknown): OwnedOciMountInspection[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const mount = raw as Record<string, unknown>;
    if (mount.Type !== "bind" || typeof mount.Source !== "string"
      || typeof mount.Destination !== "string" || typeof mount.RW !== "boolean") return [];
    return [{ source: mount.Source, target: mount.Destination, readOnly: !mount.RW }];
  });
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

class DockerMultiplexDuplex extends Duplex {
  private buffered = Buffer.alloc(0);

  constructor(private readonly socket: Socket, head: Buffer) {
    super();
    socket.on("data", (chunk: Buffer) => this.consume(chunk));
    socket.on("end", () => this.push(null));
    socket.on("error", (error) => this.destroy(error));
    socket.on("close", () => this.destroy());
    if (head.byteLength > 0) this.consume(head);
  }

  override _read(): void { /* data is pushed by the engine socket */ }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.socket.write(chunk, callback);
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.socket.end(callback);
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    if (!this.socket.destroyed) this.socket.destroy();
    callback(error);
  }

  private consume(chunk: Buffer): void {
    this.buffered = this.buffered.byteLength === 0 ? Buffer.from(chunk) : Buffer.concat([this.buffered, chunk]);
    if (this.buffered.byteLength > MAX_MULTIPLEX_BUFFER_BYTES) {
      this.destroy(new BrokerProtocolError("OCI engine multiplex buffer exceeded its limit."));
      return;
    }
    while (this.buffered.byteLength >= 8) {
      const stream = this.buffered[0];
      const length = this.buffered.readUInt32BE(4);
      if ((stream !== 1 && stream !== 2)
        || this.buffered[1] !== 0 || this.buffered[2] !== 0 || this.buffered[3] !== 0
        || length > MAX_MULTIPLEX_BUFFER_BYTES) {
        this.destroy(new BrokerProtocolError("OCI engine emitted an invalid multiplex frame."));
        return;
      }
      if (this.buffered.byteLength < 8 + length) return;
      const payload = this.buffered.subarray(8, 8 + length);
      this.buffered = this.buffered.subarray(8 + length);
      if (stream === 1 && payload.byteLength > 0) this.push(payload);
    }
  }
}

/** Minimal Docker-compatible API client used only by the trusted owned launcher. */
export class DockerCompatibleOciEngine implements OwnedOciEnginePort {
  private apiPrefix?: string;

  constructor(
    readonly engine: ResolvedContainerEngine,
    private readonly socketPath: string,
    private readonly requestTimeoutMs = ENGINE_REQUEST_TIMEOUT_MS
  ) {}

  async probe(signal?: AbortSignal): Promise<OwnedOciEngineCapabilities> {
    const response = await this.request("GET", "/version", undefined, signal);
    assertStatus(response, [200], "version probe");
    const value = jsonRecord(response.body, "version probe");
    const apiVersion = value.ApiVersion;
    if (typeof apiVersion !== "string" || !/^\d+\.\d+$/.test(apiVersion)) {
      throw new OciEngineApiError("OCI engine reported an invalid Docker API version.", "version probe");
    }
    this.apiPrefix = `/v${apiVersion}`;
    return { apiVersion, networkModes: ["none", "loopback", "full"] };
  }

  async inspectImage(image: string, expectedDigest: string, signal?: AbortSignal): Promise<OwnedOciImageIdentity> {
    const response = await this.apiRequest("GET", `/images/${encodeURIComponent(image)}/json`, undefined, signal);
    assertStatus(response, [200], "image inspect");
    const value = jsonRecord(response.body, "image inspect");
    const imageId = value.Id;
    const digests = value.RepoDigests;
    if (typeof imageId !== "string" || !/^sha256:[a-f0-9]{64}$/i.test(imageId)
      || !Array.isArray(digests) || !digests.some((item) =>
        typeof item === "string" && item.toLowerCase().endsWith(`@${expectedDigest}`))) {
      throw new OciEngineApiError("OCI image identity does not match its immutable digest reference.", "image inspect");
    }
    return { imageId: imageId.toLowerCase(), imageDigest: expectedDigest };
  }

  async createContainer(spec: OwnedOciCreateSpec, signal?: AbortSignal): Promise<string> {
    const response = await this.apiRequest(
      "POST", `/containers/create?name=${encodeURIComponent(spec.name)}`, createPayload(spec), signal
    );
    const capability = response.statusCode === 201 ? undefined : createFailureCapability(spec, response.body);
    if (capability) {
      throw new OciEngineCapabilityError(
        capability, "OCI engine cannot provide a required owned-container capability.",
        "container create", response.statusCode
      );
    }
    assertStatus(response, [201], "container create");
    const id = jsonRecord(response.body, "container create").Id;
    if (typeof id !== "string" || !/^[a-f0-9]{12,64}$/i.test(id)) {
      throw new OciEngineApiError("OCI engine returned an invalid container ID.", "container create");
    }
    return id;
  }

  async startContainer(target: string, signal?: AbortSignal): Promise<void> {
    const response = await this.apiRequest(
      "POST", `/containers/${encodeURIComponent(target)}/start`, undefined, signal
    );
    assertStatus(response, [204, 304], "container start");
  }

  async attachContainer(target: string, signal?: AbortSignal): Promise<Duplex> {
    await this.ensureApi(signal);
    const route = `${this.apiPrefix}/containers/${encodeURIComponent(target)}`
      + "/attach?logs=0&stream=1&stdin=1&stdout=1&stderr=1";
    const { socket, head } = await this.upgrade(route, signal);
    return new DockerMultiplexDuplex(socket, head);
  }

  async inspectContainer(target: string, signal?: AbortSignal): Promise<OwnedOciContainerInspection> {
    const response = await this.apiRequest(
      "GET", `/containers/${encodeURIComponent(target)}/json`, undefined, signal
    );
    assertStatus(response, [200], "container inspect");
    return this.containerInspection(jsonRecord(response.body, "container inspect"));
  }

  async removeContainer(target: string, signal?: AbortSignal): Promise<void> {
    const response = await this.apiRequest(
      "DELETE", `/containers/${encodeURIComponent(target)}?force=1&v=1`, undefined, signal
    );
    assertStatus(response, [204, 404], "container remove");
  }

  private containerInspection(value: Record<string, unknown>): OwnedOciContainerInspection {
    const state = value.State as Record<string, unknown> | undefined;
    const config = value.Config as Record<string, unknown> | undefined;
    const host = value.HostConfig as Record<string, unknown> | undefined;
    const networkSettings = value.NetworkSettings as Record<string, unknown> | undefined;
    const networks = networkSettings?.Networks;
    if (typeof value.Id !== "string" || typeof value.Image !== "string"
      || typeof state?.Running !== "boolean" || typeof state.StartedAt !== "string") {
      throw new OciEngineApiError("OCI container inspect response is incomplete.", "container inspect");
    }
    return {
      targetId: value.Id,
      targetStartedAt: state.StartedAt,
      imageId: value.Image.toLowerCase(),
      running: state.Running,
      labels: parseLabels(config?.Labels),
      mounts: parseMounts(value.Mounts),
      networkMode: typeof host?.NetworkMode === "string" ? host.NetworkMode : "",
      networkNames: networks && typeof networks === "object" && !Array.isArray(networks)
        ? Object.keys(networks) : [],
      capAdd: stringArray(host?.CapAdd),
      securityOpt: stringArray(host?.SecurityOpt)
    };
  }

  private async ensureApi(signal?: AbortSignal): Promise<void> {
    if (!this.apiPrefix) await this.probe(signal);
  }

  private async apiRequest(
    method: string,
    route: string,
    body?: object,
    signal?: AbortSignal
  ): Promise<EngineResponse> {
    await this.ensureApi(signal);
    return await this.request(method, `${this.apiPrefix}${route}`, body, signal);
  }

  private async request(
    method: string,
    route: string,
    body?: object,
    signal?: AbortSignal
  ): Promise<EngineResponse> {
    if (signal?.aborted) throw new BrokerCancelledError("OCI engine request cancelled.", { cause: signal.reason });
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), "utf8");
    return await new Promise<EngineResponse>((resolve, reject) => {
      const request = http.request({
        socketPath: this.socketPath, path: route, method, signal,
        headers: payload ? { "content-type": "application/json", "content-length": payload.byteLength } : undefined
      }, (response) => this.collectResponse(response, resolve, reject));
      request.setTimeout(this.requestTimeoutMs, () => request.destroy(
        new OciEngineApiError(`OCI engine ${method} ${route} timed out.`, "request timeout")
      ));
      request.on("error", reject);
      if (payload) request.write(payload);
      request.end();
    });
  }

  private collectResponse(
    response: http.IncomingMessage,
    resolve: (value: EngineResponse) => void,
    reject: (reason: unknown) => void
  ): void {
    const chunks: Buffer[] = [];
    let size = 0;
    response.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > MAX_ENGINE_RESPONSE_BYTES) {
        response.destroy(new OciEngineApiError("OCI engine response exceeded 4 MiB.", "response read"));
      } else chunks.push(chunk);
    });
    response.on("error", reject);
    response.on("end", () => resolve({ statusCode: response.statusCode ?? 0, body: Buffer.concat(chunks) }));
  }

  private async upgrade(route: string, signal?: AbortSignal): Promise<{ socket: Socket; head: Buffer }> {
    if (signal?.aborted) throw new BrokerCancelledError("OCI engine attach cancelled.", { cause: signal.reason });
    return await new Promise((resolve, reject) => {
      const request = http.request({
        socketPath: this.socketPath, path: route, method: "POST", signal,
        headers: { connection: "Upgrade", upgrade: "tcp" }
      });
      request.setTimeout(this.requestTimeoutMs, () => request.destroy(
        new OciEngineApiError("OCI engine attach timed out.", "container attach")
      ));
      request.once("upgrade", (response, socket, head) => {
        if (response.statusCode !== 101) {
          socket.destroy();
          reject(new OciEngineApiError(
            `OCI engine attach returned HTTP ${response.statusCode}.`, "container attach", response.statusCode
          ));
          return;
        }
        resolve({ socket, head });
      });
      request.once("response", (response) => {
        response.resume();
        reject(new OciEngineApiError(
          `OCI engine refused stream upgrade with HTTP ${response.statusCode}.`,
          "container attach",
          response.statusCode
        ));
      });
      request.once("error", reject);
      request.end();
    });
  }
}
