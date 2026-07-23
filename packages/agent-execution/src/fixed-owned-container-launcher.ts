import { constants } from "node:fs";
import { access, lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { assertContainerExecutionConfig } from "./container-execution-broker.js";
import {
  ContainerAttestationInvalidError,
  ContainerUnavailableError
} from "./errors.js";
import { defaultSigmaExecPath } from "./lazy-execution-broker-runtime.js";
import { OwnedContainerExecutionBroker } from "./owned-container-execution-broker.js";
import { DockerCompatibleOciEngine } from "./owned-oci-engine.js";
import type {
  ContainerEngine,
  ResolvedContainerEngine,
  TrustedContainerLauncherV1
} from "./types.js";

export const FIXED_DOCKER_ENGINE_SOCKET = "/var/run/docker.sock";
export const FIXED_ROOT_PODMAN_ENGINE_SOCKET = "/run/podman/podman.sock";

interface EngineCandidate {
  engine: ResolvedContainerEngine;
  socketPath: string;
}

function podmanSocketCandidates(uid: number | undefined): EngineCandidate[] {
  return [
    { engine: "podman", socketPath: FIXED_ROOT_PODMAN_ENGINE_SOCKET },
    ...(uid === undefined ? [] : [{ engine: "podman" as const, socketPath: `/run/user/${uid}/podman/podman.sock` }])
  ];
}

function engineCandidates(engine: ContainerEngine): EngineCandidate[] {
  const docker = { engine: "docker" as const, socketPath: FIXED_DOCKER_ENGINE_SOCKET };
  const podman = podmanSocketCandidates(process.getuid?.());
  if (engine === "docker") return [docker];
  if (engine === "podman") return podman;
  return [docker, ...podman];
}

function trustedOwner(uid: number | undefined): (value: number) => boolean {
  return (value) => value === 0 || (uid !== undefined && value === uid);
}

async function assertTrustedEngineSocket(candidate: EngineCandidate): Promise<void> {
  const info = await lstat(candidate.socketPath).catch(() => undefined);
  if (!info?.isSocket() || info.isSymbolicLink()) {
    throw new ContainerUnavailableError(`Fixed ${candidate.engine} engine socket is unavailable.`, {
      engine: candidate.engine
    });
  }
  if (!trustedOwner(process.getuid?.())(info.uid) || (info.mode & 0o002) !== 0) {
    throw new ContainerAttestationInvalidError(`Fixed ${candidate.engine} engine socket permissions are unsafe.`, {
      engine: candidate.engine,
      mode: info.mode & 0o777
    });
  }
}

async function assertTrustedExecutable(executablePath: string, label: string): Promise<string> {
  const raw = await lstat(executablePath).catch(() => undefined);
  if (!raw?.isFile() || raw.isSymbolicLink()) {
    throw new ContainerUnavailableError(`The ${label} is unavailable.`);
  }
  const canonical = await realpath(executablePath).catch(() => undefined);
  if (!canonical) throw new ContainerUnavailableError(`The ${label} is unavailable.`);
  const info = await lstat(canonical);
  if (!info.isFile() || !trustedOwner(process.getuid?.())(info.uid)
    || (info.mode & 0o022) !== 0) {
    throw new ContainerAttestationInvalidError(`The ${label} is not trusted.`);
  }
  await access(canonical, constants.X_OK).catch((error: unknown) => {
    throw new ContainerUnavailableError(`The ${label} is not executable.`, undefined, {
      cause: error instanceof Error ? error : undefined
    });
  });
  return canonical;
}

async function trustedSandboxHelper(helperPath: string): Promise<string> {
  const candidates = [path.join(path.dirname(helperPath), "bwrap"),
    "/usr/bin/bwrap", "/bin/bwrap", "/usr/local/bin/bwrap"];
  for (const candidate of candidates) {
    if (await lstat(candidate).catch(() => undefined)) {
      return await assertTrustedExecutable(candidate, "bubblewrap OCI sandbox helper");
    }
  }
  throw new ContainerUnavailableError("The bubblewrap OCI sandbox helper is unavailable.");
}

async function selectEngine(engine: ContainerEngine): Promise<DockerCompatibleOciEngine> {
  const failures: Array<{ engine: string; reason: string }> = [];
  let unsafeBoundary: ContainerAttestationInvalidError | undefined;
  for (const candidate of engineCandidates(engine)) {
    try {
      await assertTrustedEngineSocket(candidate);
      const api = new DockerCompatibleOciEngine(candidate.engine, candidate.socketPath);
      await api.probe();
      return api;
    } catch (error) {
      if (error instanceof ContainerAttestationInvalidError) unsafeBoundary ??= error;
      failures.push({
        engine: candidate.engine,
        reason: error instanceof Error ? error.message : String(error)
      });
    }
  }
  if (unsafeBoundary) throw unsafeBoundary;
  throw new ContainerUnavailableError("No trusted Docker or Podman API is available for owned OCI execution.", {
    requestedEngine: engine,
    attempts: failures
  });
}

/** Loads only fixed local engine sockets and the packaged read-only helper. */
export async function loadFixedOwnedContainerLauncher(
  workspace: string,
  engine: ContainerEngine,
  platform: NodeJS.Platform = process.platform
): Promise<TrustedContainerLauncherV1 | undefined> {
  if (platform !== "linux") return undefined;
  const canonicalWorkspace = await realpath(workspace);
  const helperPath = await assertTrustedExecutable(defaultSigmaExecPath({}), "packaged sigma-exec OCI helper");
  const sandboxHelperPath = await trustedSandboxHelper(helperPath);
  const engineApi = await selectEngine(engine);
  return {
    protocolVersion: 1,
    createBroker: (request) => {
      if (request.config.target !== "owned") {
        throw new ContainerAttestationInvalidError("The fixed owned launcher cannot attach to managed targets.");
      }
      assertContainerExecutionConfig(request.config, request.managedAttestation);
      if (path.resolve(request.workspace) !== canonicalWorkspace) {
        throw new ContainerAttestationInvalidError("Owned OCI broker request escaped its trusted workspace.");
      }
      if (request.config.engine !== "auto" && request.config.engine !== engineApi.engine) {
        throw new ContainerAttestationInvalidError("Owned OCI engine differs from the trusted fixed launcher.");
      }
      return new OwnedContainerExecutionBroker({
        config: { ...request.config, target: "owned", image: request.config.image! },
        workspace: canonicalWorkspace,
        helperPath,
        sandboxHelperPath,
        engine: engineApi
      });
    }
  };
}
