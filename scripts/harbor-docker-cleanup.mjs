#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const runLabel = "com.sigma.harbor-run";

function docker(args, timeout = 30_000) {
  const result = spawnSync("docker", args, {
    encoding: "utf8",
    windowsHide: true,
    timeout,
    maxBuffer: 8 * 1024 * 1024
  });
  return {
    args,
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? result.error?.message ?? ""
  };
}

function ids(kind, runId) {
  const args = kind === "container"
    ? ["ps", "-aq", "--filter", `label=${runLabel}=${runId}`]
    : ["network", "ls", "-q", "--filter", `label=${runLabel}=${runId}`];
  const result = docker(args);
  if (result.exitCode !== 0) {
    throw new Error(`docker ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean);
}

export function cleanupHarborDockerResources(runId) {
  if (!/^[A-Za-z0-9_.-]+$/u.test(runId)) throw new Error("Harbor Docker run id is invalid.");
  const commands = [];
  try {
    const version = docker(["version", "--format", "{{.Server.Version}}"]);
    commands.push(version);
    if (version.exitCode !== 0) throw new Error(version.stderr || "Docker server is unavailable.");

    const containers = ids("container", runId);
    if (containers.length > 0) commands.push(docker(["rm", "-f", ...containers], 60_000));

    const networks = ids("network", runId);
    if (networks.length > 0) commands.push(docker(["network", "rm", ...networks], 60_000));

    const remaining = {
      containers: ids("container", runId),
      networks: ids("network", runId)
    };
    const commandFailure = commands.find((command) => command.exitCode !== 0);
    return {
      schemaVersion: 1,
      runId,
      clean: !commandFailure && remaining.containers.length === 0 && remaining.networks.length === 0,
      removed: { containers, networks },
      remaining,
      commands
    };
  } catch (error) {
    return {
      schemaVersion: 1,
      runId,
      clean: false,
      removed: { containers: [], networks: [] },
      remaining: null,
      commands,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}
