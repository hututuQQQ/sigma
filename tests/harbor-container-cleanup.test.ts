import { describe, expect, it } from "vitest";
import { cleanupHarborDockerResources } from "../scripts/harbor-docker-cleanup.mjs";

type SpawnResult = { status: number | null; stdout?: string; stderr?: string; error?: Error };

describe("Harbor run-scoped container cleanup", () => {
  it("uses the explicitly selected Podman server and removes only exact run-labelled resources", () => {
    const remaining = { container: ["ctr-1"], network: ["net-1"], volume: ["vol-1"] };
    const calls: Array<{ engine: string; args: string[] }> = [];
    const spawn = (engine: string, args: string[]): SpawnResult => {
      calls.push({ engine, args });
      if (args[0] === "version") {
        return engine === "podman" ? { status: 0, stdout: "5.0" } : { status: 1, stderr: "missing" };
      }
      const kind = args[0] === "ps" ? "container" : args[0];
      if (args.includes("ls") || args[0] === "ps") {
        return { status: 0, stdout: `${remaining[kind as keyof typeof remaining].join("\n")}\n` };
      }
      if (args[0] === "rm") remaining.container = [];
      if (args[0] === "network" && args[1] === "rm") remaining.network = [];
      if (args[0] === "volume" && args[1] === "rm") remaining.volume = [];
      return { status: 0, stdout: "" };
    };

    const result = cleanupHarborDockerResources("run-123", "podman", spawn as never);

    expect(result.clean).toBe(true);
    expect(result.removed).toEqual({
      containers: ["podman:ctr-1"], networks: ["podman:net-1"], volumes: ["podman:vol-1"]
    });
    expect(calls.filter((call) => call.engine === "podman").every((call) =>
      call.args[0] === "version" || call.args.some((value) => value.includes("com.sigma.harbor-run=run-123"))
        || call.args.includes("ctr-1") || call.args.includes("net-1") || call.args.includes("vol-1"))).toBe(true);
  });

  it("fails closed when no selected container engine is available", () => {
    const result = cleanupHarborDockerResources("run-123", "auto", (() => ({
      status: null, stdout: "", stderr: "", error: new Error("missing")
    })) as never);
    expect(result.clean).toBe(false);
    expect(result.error).toMatch(/no Docker or Podman server/iu);
  });

  it("bounds all engine commands by one total cleanup deadline", () => {
    const sleeps = new Int32Array(new SharedArrayBuffer(4));
    const spawn = () => {
      Atomics.wait(sleeps, 0, 0, 8);
      return { status: 0, stdout: "" };
    };
    const startedAt = Date.now();
    const result = cleanupHarborDockerResources("run-123", "docker", spawn as never, 20);
    expect(Date.now() - startedAt).toBeLessThan(80);
    expect(result.clean).toBe(false);
    expect(result.error).toMatch(/total deadline/iu);
  });

  it("rejects broad or malformed cleanup selectors", () => {
    expect(() => cleanupHarborDockerResources("../all")).toThrow(/run id is invalid/iu);
  });
});
