import type { Duplex } from "node:stream";
import type { NetworkPolicy, ResolvedContainerEngine } from "./types.js";

export interface OwnedOciEngineCapabilities {
  networkModes: NetworkPolicy[];
  apiVersion: string;
}

export interface OwnedOciImageIdentity {
  imageId: string;
  imageDigest: string;
}

export interface OwnedOciMountInspection {
  source: string;
  target: string;
  readOnly: boolean;
}

export interface OwnedOciContainerInspection {
  targetId: string;
  targetStartedAt: string;
  imageId: string;
  running: boolean;
  labels: Record<string, string>;
  mounts: OwnedOciMountInspection[];
  networkMode: string;
  networkNames: string[];
  capAdd: string[];
  securityOpt: string[];
}

export interface OwnedOciCreateSpec {
  name: string;
  image: string;
  workspace: string;
  helperPath: string;
  helperTarget: string;
  sandboxHelperPath: string;
  sandboxHelperTarget: string;
  artifactParent: string;
  network: NetworkPolicy;
  labels: Record<string, string>;
}

export interface OwnedOciEnginePort {
  readonly engine: ResolvedContainerEngine;
  probe(signal?: AbortSignal): Promise<OwnedOciEngineCapabilities>;
  inspectImage(image: string, expectedDigest: string, signal?: AbortSignal): Promise<OwnedOciImageIdentity>;
  createContainer(spec: OwnedOciCreateSpec, signal?: AbortSignal): Promise<string>;
  startContainer(target: string, signal?: AbortSignal): Promise<void>;
  attachContainer(target: string, signal?: AbortSignal): Promise<Duplex>;
  inspectContainer(target: string, signal?: AbortSignal): Promise<OwnedOciContainerInspection>;
  removeContainer(target: string, signal?: AbortSignal): Promise<void>;
}
