import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  assertManagedBoundaryTopology,
  attestationPreimage,
  completeAttestation,
  labelsDigest,
  TargetAttestor,
  targetBrokerExecSpec
} from "../portable/harbor/sigma-oci-broker.mjs";

function volume(name: string, destination: string, RW: boolean) {
  return { Type: "volume", Name: name, Source: `/var/lib/docker/volumes/${name}/_data`, Destination: destination, RW };
}

function bind(source: string, destination: string, RW: boolean) {
  return { Type: "bind", Source: source, Destination: destination, RW };
}

function managedTopology() {
  const target: any = {
    Config: { Env: ["PATH=/usr/bin"] },
    HostConfig: { Privileged: false, ReadonlyRootfs: false, NetworkMode: "default" },
    Mounts: [
      volume("workspace", "/app", true),
      volume("helper", "/opt/sigma-helper", false),
      volume("artifacts", "/run/sigma-oci/artifacts", true),
      bind("/host/trial/verifier", "/logs/verifier", true),
      bind("/host/trial/agent", "/logs/agent", true),
      bind("/host/trial/artifacts", "/logs/artifacts", true)
    ]
  };
  const control: any = {
    Config: { Env: ["PATH=/usr/bin", "HOME=/var/lib/sigma"] },
    HostConfig: { Privileged: false, ReadonlyRootfs: true, NetworkMode: "default" },
    Mounts: [
      bind("/host/agent-cli.tgz", "/opt/sigma-package/agent-cli.tgz", false),
      volume("workspace", "/app", true),
      volume("control-state", "/var/lib/sigma", true),
      volume("control-runtime", "/opt/sigma-control", true),
      volume("helper", "/opt/sigma-helper", false),
      volume("ipc", "/run/sigma-oci", false),
      volume("artifacts", "/run/sigma-oci/artifacts", true)
    ]
  };
  const broker: any = {
    Config: { Env: ["PATH=/usr/bin"] },
    HostConfig: { Privileged: false, ReadonlyRootfs: true, NetworkMode: "none" },
    Mounts: [
      bind("/var/run/docker.sock", "/var/run/docker.sock", true),
      bind("/host/sigma-oci-broker.mjs", "/opt/sigma-broker/sigma-oci-broker.mjs", false),
      bind("/host/agent-cli.tgz", "/opt/sigma-package/agent-cli.tgz", false),
      volume("helper", "/opt/sigma-helper", true),
      volume("ipc", "/run/sigma-oci", true),
      volume("artifacts", "/run/sigma-oci/artifacts", true)
    ]
  };
  return { target, control, broker };
}

function attestorFixture(version: unknown = { Platform: { Name: "Docker Engine - Community" } }) {
  const containers = managedTopology();
  const project = "trial-project";
  const runId = "trial-run";
  const definitions = [
    [containers.target, "target-id", "main", "com.sigma.oci-target", "managed-main-v1"],
    [containers.control, "control-id", "sigma-control", "com.sigma.control-plane", "v1"],
    [containers.broker, "broker-id", "sigma-oci-broker", "com.sigma.oci-broker", "v1"]
  ] as const;
  for (const [container, id, service, proofLabel, proofValue] of definitions) {
    container.Id = id;
    container.Image = `sha256:${service === "main" ? "a" : "b".repeat(64)}`;
    container.State = { Running: true, StartedAt: "2026-07-19T06:00:00.000000000Z" };
    container.Config.Labels = {
      "com.docker.compose.project": project,
      "com.docker.compose.service": service,
      "com.sigma.harbor-run": runId,
      [proofLabel]: proofValue
    };
  }
  containers.target.Image = `sha256:${"a".repeat(64)}`;
  const byId = new Map(definitions.map(([container, id]) => [id, container]));
  const api = {
    async json(_method: string, requestPath: string) {
      if (requestPath.startsWith("/containers/json?")) {
        return [...byId.entries()].map(([Id, container]) => ({ Id, Labels: container.Config.Labels }));
      }
      if (requestPath === "/version") return version;
      const containerMatch = /^\/containers\/([^/]+)\/json$/u.exec(requestPath);
      if (containerMatch) return byId.get(decodeURIComponent(containerMatch[1]!));
      if (requestPath.startsWith("/images/")) return { RepoDigests: [`fixture@sha256:${"c".repeat(64)}`] };
      throw new Error(`unexpected fake Docker API path: ${requestPath}`);
    }
  };
  const proof = {
    project, runId, engine: "docker",
    bindSourceIdentityMode: "exact",
    targetId: "target-id", controlId: "control-id", brokerId: "broker-id"
  };
  const helperAttestation = {
    digest: `sha256:${"d".repeat(64)}`,
    observed: `sha256:${"d".repeat(64)}`,
    async verify() { return this.observed; }
  };
  return { containers, byId, api, proof, helperAttestation };
}

describe("Harbor OCI broker attestation", () => {
  it("uses the launcher protocol's exact canonical digest preimage", () => {
    const partial = {
      engine: "docker" as const,
      selector: "compose:trial/service:main/run:sample",
      targetId: "a".repeat(64),
      targetStartedAt: "2026-07-19T05:00:00.000000000Z",
      imageId: `sha256:${"b".repeat(64)}`,
      labelsDigest: `sha256:${"c".repeat(64)}`,
      helperDigest: `sha256:${"d".repeat(64)}`
    };
    const preimage = attestationPreimage(partial);

    expect(preimage).toBe(JSON.stringify({
      protocolVersion: 1,
      engine: "docker",
      selector: partial.selector,
      targetId: partial.targetId,
      targetStartedAt: partial.targetStartedAt,
      imageId: partial.imageId,
      imageDigest: null,
      labelsDigest: partial.labelsDigest,
      helperDigest: partial.helperDigest
    }));
    expect(completeAttestation(partial)).toEqual({
      protocolVersion: 1,
      ...partial,
      attestationDigest: `sha256:${createHash("sha256").update(preimage).digest("hex")}`
    });
  });

  it("hashes labels independently of object insertion order", () => {
    expect(labelsDigest({ z: "last", a: "first" })).toBe(labelsDigest({ a: "first", z: "last" }));
  });

  it("accepts only the isolated three-service mount topology", () => {
    expect(() => assertManagedBoundaryTopology(managedTopology())).not.toThrow();
  });

  it("accepts only proven Docker Desktop Windows bind aliases", async () => {
    const fixture = attestorFixture({ Platform: { Name: "Docker Desktop 4.43.2 (Windows)" } });
    fixture.containers.control.Mounts.find(
      (mount: { Destination: string }) => mount.Destination === "/opt/sigma-package/agent-cli.tgz"
    ).Source = "/run/desktop/mnt/host/d/software/sigma/agent-cli.tgz";
    fixture.containers.broker.Mounts.find(
      (mount: { Destination: string }) => mount.Destination === "/opt/sigma-package/agent-cli.tgz"
    ).Source = "D:/software/sigma/agent-cli.tgz";
    const previousHostname = process.env.HOSTNAME;
    process.env.HOSTNAME = "broker-id";
    try {
      const pinned = await new TargetAttestor(fixture.api, fixture.helperAttestation).discover();
      expect(pinned.proof.bindSourceIdentityMode).toBe("docker-desktop-windows");
    } finally {
      if (previousHostname === undefined) delete process.env.HOSTNAME;
      else process.env.HOSTNAME = previousHostname;
    }

    const ordinaryEngine = attestorFixture({
      Platform: { Name: "Docker Engine - Community" },
      Components: [{ Name: "Docker Desktop" }]
    });
    ordinaryEngine.containers.control.Mounts.find(
      (mount: { Destination: string }) => mount.Destination === "/opt/sigma-package/agent-cli.tgz"
    ).Source = "/run/desktop/mnt/host/d/software/sigma/agent-cli.tgz";
    ordinaryEngine.containers.broker.Mounts.find(
      (mount: { Destination: string }) => mount.Destination === "/opt/sigma-package/agent-cli.tgz"
    ).Source = "D:/software/sigma/agent-cli.tgz";
    process.env.HOSTNAME = "broker-id";
    try {
      await expect(
        new TargetAttestor(ordinaryEngine.api, ordinaryEngine.helperAttestation).discover()
      ).rejects.toThrow(/not the same host bind/iu);
    } finally {
      if (previousHostname === undefined) delete process.env.HOSTNAME;
      else process.env.HOSTNAME = previousHostname;
    }
  });

  it("keeps Docker Desktop bind alias matching path-exact and prefix-exact", () => {
    const options = { bindSourceIdentityMode: "docker-desktop-windows" };
    const legacyAlias = managedTopology();
    legacyAlias.control.Mounts.find(
      (mount) => mount.Destination === "/opt/sigma-package/agent-cli.tgz"
    )!.Source = "/host_mnt/d/software/sigma/agent-cli.tgz";
    legacyAlias.broker.Mounts.find(
      (mount) => mount.Destination === "/opt/sigma-package/agent-cli.tgz"
    )!.Source = "D:/software/sigma/agent-cli.tgz";
    expect(() => assertManagedBoundaryTopology(legacyAlias, options)).not.toThrow();

    for (const alternate of [
      "E:/software/sigma/agent-cli.tgz",
      "D:/software/other/agent-cli.tgz",
      "/run/desktop/mnt/hostile/d/software/sigma/agent-cli.tgz"
    ]) {
      const mismatch = structuredClone(legacyAlias);
      mismatch.broker.Mounts.find(
        (mount: { Destination: string }) => mount.Destination === "/opt/sigma-package/agent-cli.tgz"
      ).Source = alternate;
      expect(() => assertManagedBoundaryTopology(mismatch, options)).toThrow(/not the same host bind/iu);
    }
  });

  it("rejects an alias mode proof not supported by the current Engine version", async () => {
    const fixture = attestorFixture({ Platform: { Name: "Docker Engine - Community" } });
    const forgedProof = {
      ...fixture.proof,
      bindSourceIdentityMode: "docker-desktop-windows"
    };
    await expect(
      new TargetAttestor(fixture.api, fixture.helperAttestation).inspectBoundary(forgedProof, false)
    ).rejects.toThrow(/differs from the current Engine \/version/iu);
  });

  it("canonicalizes Docker Desktop aliases for sensitive and engine source isolation", () => {
    const options = { bindSourceIdentityMode: "docker-desktop-windows" };
    const sensitiveAlias = managedTopology();
    sensitiveAlias.control.Mounts.find(
      (mount) => mount.Destination === "/opt/sigma-package/agent-cli.tgz"
    )!.Source = "D:/trusted/agent-cli.tgz";
    sensitiveAlias.broker.Mounts.find(
      (mount) => mount.Destination === "/opt/sigma-package/agent-cli.tgz"
    )!.Source = "/run/desktop/mnt/host/d/trusted/agent-cli.tgz";
    sensitiveAlias.target.Mounts.find(
      (mount) => mount.Destination === "/logs/agent"
    )!.Source = "/host_mnt/d/trusted/agent-cli.tgz";
    expect(() => assertManagedBoundaryTopology(sensitiveAlias, options)).toThrow(
      /aliases a control-plane-only source/iu
    );

    const engineAlias = managedTopology();
    engineAlias.broker.Mounts.find(
      (mount) => mount.Destination === "/var/run/docker.sock"
    )!.Source = "D:/engine/desktop-proxy";
    engineAlias.target.Mounts.find(
      (mount) => mount.Destination === "/logs/agent"
    )!.Source = "/run/desktop/mnt/host/d/engine/desktop-proxy";
    expect(() => assertManagedBoundaryTopology(engineAlias, options)).toThrow(/engine socket/iu);
  });

  it("allows Harbor convention binds while rejecting other host, engine, or secret exposure", () => {
    expect(() => assertManagedBoundaryTopology(managedTopology())).not.toThrow();

    const socketConflict = managedTopology();
    socketConflict.target.Mounts.push(bind("/var/run/docker.sock", "/tmp/engine", true));
    expect(() => assertManagedBoundaryTopology(socketConflict)).toThrow(/engine socket/iu);

    const opaqueBindConflict = managedTopology();
    opaqueBindConflict.target.Mounts.push(bind("/opaque/desktop/proxy", "/tmp/opaque", false));
    expect(() => assertManagedBoundaryTopology(opaqueBindConflict)).toThrow(/unexpected host bind mount/iu);

    const secretConflict = managedTopology();
    secretConflict.target.Config.Env.push("DEEPSEEK_API_KEY=must-not-enter-main");
    expect(() => assertManagedBoundaryTopology(secretConflict)).toThrow(/forbidden control\/engine environment/iu);
  });

  it("rejects writable control IPC and injected control/broker mounts", () => {
    const writableIpc = managedTopology();
    writableIpc.control.Mounts.find((mount) => mount.Destination === "/run/sigma-oci")!.RW = true;
    expect(() => assertManagedBoundaryTopology(writableIpc)).toThrow(/must be read-only/iu);

    const injected = managedTopology();
    injected.broker.Mounts.push(bind("/host/injected", "/injected", false));
    expect(() => assertManagedBoundaryTopology(injected)).toThrow(/trusted topology/iu);

    const writableHelper = managedTopology();
    writableHelper.control.Mounts.find((mount) => mount.Destination === "/opt/sigma-helper")!.RW = true;
    expect(() => assertManagedBoundaryTopology(writableHelper)).toThrow(/must be read-only/iu);
  });

  it("starts the target helper explicitly as container root for non-root task images", () => {
    expect(targetBrokerExecSpec({
      attestation: { targetId: "target-id" },
      workspace: "/app"
    })).toMatchObject({
      Cmd: ["/opt/sigma-helper/bin/sigma-exec"],
      User: "0:0",
      WorkingDir: "/app",
      Privileged: false
    });
  });

  it("reselects and revalidates all three service proofs before every request", async () => {
    const fixture = attestorFixture();
    const attestor = new TargetAttestor(fixture.api, fixture.helperAttestation);
    const pinned = await attestor.inspectBoundary(fixture.proof, false);

    const replacement = structuredClone(fixture.containers.control);
    replacement.Id = "replacement-control-id";
    fixture.byId.delete("control-id");
    fixture.byId.set("replacement-control-id", replacement);
    await expect(attestor.reattest(pinned)).rejects.toThrow(/controlId changed/iu);

    fixture.byId.delete("replacement-control-id");
    fixture.byId.set("control-id", fixture.containers.control);
    fixture.containers.control.Mounts.find(
      (mount: { Destination: string }) => mount.Destination === "/run/sigma-oci"
    ).RW = true;
    await expect(attestor.reattest(pinned)).rejects.toThrow(/must be read-only/iu);
  });

  it("rejects a helper mutation before attaching another target process", async () => {
    const fixture = attestorFixture();
    const attestor = new TargetAttestor(fixture.api, fixture.helperAttestation);
    const pinned = await attestor.inspectBoundary(fixture.proof, false);

    fixture.helperAttestation.observed = `sha256:${"e".repeat(64)}`;
    await expect(attestor.reattest(pinned)).rejects.toThrow(/helper digest changed/iu);
  });
});
