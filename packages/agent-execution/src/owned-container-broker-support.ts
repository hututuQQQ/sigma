import { randomBytes } from "node:crypto";
import type { Duplex } from "node:stream";
import { SigmaExecBrokerClient } from "./broker-client.js";
import {
  BrokerCancelledError,
  BrokerTimeoutError,
  ContainerAttestationInvalidError,
  ContainerUnavailableError
} from "./errors.js";
import { OciEngineApiError } from "./owned-oci-engine.js";
import type { OwnedOciEnginePort } from "./owned-oci-engine.js";
import type { ContainerExecutionConfig, ExecutionBroker } from "./types.js";

interface OwnedContainerConfig extends ContainerExecutionConfig {
  target: "owned";
  image: string;
}

export interface OwnedContainerExecutionBrokerOptions {
  config: OwnedContainerConfig;
  workspace: string;
  helperPath: string;
  sandboxHelperPath: string;
  engine: OwnedOciEnginePort;
  clientFactory?: (stream: Duplex, artifactParent: string) => ExecutionBroker;
  nameFactory?: () => string;
}

export function ownedTargetName(factory?: () => string): string {
  return factory?.() ?? `sigma-owned-${process.pid}-${randomBytes(12).toString("hex")}`;
}

export function ownedProofLabels(): Record<string, string> {
  return {
    "com.sigma.oci-owned": "v1",
    "com.sigma.oci-owner": randomBytes(24).toString("hex")
  };
}

export function ownedContainerFailure(error: unknown, message: string): Error {
  if (error instanceof BrokerCancelledError || error instanceof BrokerTimeoutError
    || error instanceof ContainerUnavailableError || error instanceof ContainerAttestationInvalidError) return error;
  if ((error as { name?: unknown }).name === "AbortError") {
    return new BrokerCancelledError("Owned OCI provisioning was cancelled.", {
      cause: error instanceof Error ? error : undefined
    });
  }
  return new ContainerUnavailableError(message, {
    engineError: error instanceof OciEngineApiError
      ? { operation: error.operation, statusCode: error.statusCode ?? null }
      : { type: typeof error }
  }, { cause: error instanceof Error ? error : undefined });
}

export function defaultOwnedClient(stream: Duplex, artifactParent: string): ExecutionBroker {
  return new SigmaExecBrokerClient({
    trustedStream: stream,
    executionBackend: "oci",
    artifactRootParent: artifactParent,
    sandboxMode: "required",
    trustedToolchains: []
  });
}
