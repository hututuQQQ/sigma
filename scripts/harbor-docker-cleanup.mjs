#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const runLabel = "com.sigma.harbor-run";

function remainingTimeout(deadline, requested) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("Container cleanup exceeded its total deadline.");
  return Math.max(1, Math.min(requested, remaining));
}

function engineCommand(engine, args, timeout, deadline, spawn = spawnSync) {
  const result = spawn(engine, args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: remainingTimeout(deadline, timeout),
    maxBuffer: 8 * 1024 * 1024
  });
  return {
    engine,
    args,
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? result.error?.message ?? ""
  };
}

function ids(engine, kind, runId, deadline, spawn) {
  const args = kind === "container"
    ? ["ps", "-aq", "--filter", `label=${runLabel}=${runId}`]
    : kind === "network"
      ? ["network", "ls", "-q", "--filter", `label=${runLabel}=${runId}`]
      : ["volume", "ls", "-q", "--filter", `label=${runLabel}=${runId}`];
  const result = engineCommand(engine, args, 30_000, deadline, spawn);
  if (result.exitCode !== 0) {
    throw new Error(`${engine} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean);
}

function cleanupEngineResources(engine, runId, deadline, spawn) {
  const commands = [];
  const version = engineCommand(
    engine, ["version", "--format", "{{.Server.Version}}"], 30_000, deadline, spawn
  );
  commands.push(version);
  if (version.exitCode !== 0) return { available: false, clean: false, commands };

  const containers = ids(engine, "container", runId, deadline, spawn);
  if (containers.length > 0) {
    commands.push(engineCommand(engine, ["rm", "-f", ...containers], 60_000, deadline, spawn));
  }
  const networks = ids(engine, "network", runId, deadline, spawn);
  if (networks.length > 0) {
    commands.push(engineCommand(engine, ["network", "rm", ...networks], 60_000, deadline, spawn));
  }
  // Targets are selected again by the exact per-run label after containers
  // are gone, so only benchmark-owned ephemeral volumes are removed.
  const volumes = ids(engine, "volume", runId, deadline, spawn);
  if (volumes.length > 0) {
    commands.push(engineCommand(engine, ["volume", "rm", ...volumes], 60_000, deadline, spawn));
  }
  const remaining = {
    containers: ids(engine, "container", runId, deadline, spawn),
    networks: ids(engine, "network", runId, deadline, spawn),
    volumes: ids(engine, "volume", runId, deadline, spawn)
  };
  const commandFailure = commands.find((command) => command.exitCode !== 0);
  return {
    available: true,
    clean: !commandFailure && Object.values(remaining).every((values) => values.length === 0),
    removed: { containers, networks, volumes },
    remaining,
    commands
  };
}

export function cleanupHarborDockerResources(
  runId,
  preferredEngine = "docker",
  spawn = spawnSync,
  totalTimeoutMs = 120_000
) {
  if (!/^[A-Za-z0-9_.-]+$/u.test(runId)) throw new Error("Harbor container run id is invalid.");
  if (!["auto", "docker", "podman"].includes(preferredEngine)) {
    throw new Error("Harbor container engine must be auto, docker, or podman.");
  }
  if (!Number.isSafeInteger(totalTimeoutMs) || totalTimeoutMs < 1 || totalTimeoutMs > 10 * 60 * 1_000) {
    throw new Error("Container cleanup timeout must be an integer between 1 and 600000 milliseconds.");
  }
  const deadline = Date.now() + totalTimeoutMs;
  const commands = [];
  try {
    const engines = preferredEngine === "auto" ? ["docker", "podman"] : [preferredEngine];
    const results = engines.map((engine) => ({
      engine,
      ...cleanupEngineResources(engine, runId, deadline, spawn)
    }));
    const available = results.filter((result) => result.available);
    commands.push(...results.flatMap((result) => result.commands));
    if (available.length === 0) throw new Error("No Docker or Podman server is available for cleanup.");
    const aggregate = (field, kind) => available.flatMap((result) =>
      result[field][kind].map((id) => `${result.engine}:${id}`));
    return {
      schemaVersion: 1,
      runId,
      clean: results.every((result) => result.available && result.clean),
      engines: results,
      removed: Object.fromEntries(["containers", "networks", "volumes"]
        .map((kind) => [kind, aggregate("removed", kind)])),
      remaining: Object.fromEntries(["containers", "networks", "volumes"]
        .map((kind) => [kind, aggregate("remaining", kind)])),
      commands
    };
  } catch (error) {
    return {
      schemaVersion: 1,
      runId,
      clean: false,
      removed: { containers: [], networks: [], volumes: [] },
      remaining: null,
      commands,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}
