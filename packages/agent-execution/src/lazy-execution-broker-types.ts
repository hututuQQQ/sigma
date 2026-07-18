import type {
  BrokerDoctorReport,
  ExecutionBroker,
  TrustedToolchainManifestEntry
} from "./types.js";

export interface LazyExecutionBrokerOptions {
  sandboxMode: "required";
  helperPath?: string;
  env?: NodeJS.ProcessEnv;
  trustedToolchains?: TrustedToolchainManifestEntry[];
  clientFactory?: () => ExecutionBroker;
}

export interface BrokerGeneration {
  readonly id: number;
  readonly client: ExecutionBroker;
  connecting?: Promise<BrokerDoctorReport>;
  failure?: Error;
  retiring?: boolean;
  retired?: boolean;
}

export interface ConnectedGeneration {
  readonly generation: BrokerGeneration;
  readonly report: BrokerDoctorReport;
}

export interface GenerationResult<T> {
  readonly generation: BrokerGeneration;
  readonly value: T;
}
