import { BrokerTransport } from "./broker-transport.js";
import {
  assertRequiredSandbox,
  DEFAULT_SANDBOX_SETUP_TIMEOUT_MS,
  DEFAULT_STARTUP_TIMEOUT_MS
} from "./broker-client-support.js";
import { redactionSecrets } from "./broker-request-policy.js";
import {
  assertTrustedToolchainsAvailable,
  type NormalizedTrustedToolchain
} from "./trusted-toolchains.js";
import type {
  BrokerDoctorReport,
  SigmaExecBrokerClientOptions
} from "./types.js";
import { parseDoctor, parseHello } from "./values.js";

export interface BrokerClientStartupResult {
  instanceId: string;
  report: BrokerDoctorReport;
}

export async function startBrokerClient(
  transport: BrokerTransport,
  options: SigmaExecBrokerClientOptions,
  trustedToolchains: NormalizedTrustedToolchain[],
  initialReport: "doctor" | "sandbox.setup",
  configureArtifactRoot: (artifactRoot: string | undefined) => Promise<void>,
  signal?: AbortSignal
): Promise<BrokerClientStartupResult> {
  assertTrustedToolchainsAvailable(trustedToolchains, options.sandboxMode);
  transport.start();
  const hello = parseHello(await transport.request("hello", {
    clientVersion: "3.0.0",
    redactionSecrets: redactionSecrets(options.secrets)
  }, { signal, timeoutMs: 5_000 }));
  await configureArtifactRoot(hello.artifactRoot);
  const report = parseDoctor(await transport.request(initialReport, {}, {
    signal,
    timeoutMs: options.startupTimeoutMs ?? options.requestTimeoutMs
      ?? (initialReport === "sandbox.setup" ? DEFAULT_SANDBOX_SETUP_TIMEOUT_MS : DEFAULT_STARTUP_TIMEOUT_MS)
  }));
  assertRequiredSandbox(report, options.sandboxMode);
  return {
    instanceId: hello.instanceId,
    report
  };
}
