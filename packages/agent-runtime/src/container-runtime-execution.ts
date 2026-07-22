import {
  AttestedContainerExecutionBroker,
  assertContainerExecutionConfig,
  ContainerAttestationInvalidError,
  ContainerUnavailableError,
  LazyExecutionBroker,
  loadFixedContainerLauncher,
  loadFixedOwnedContainerLauncher,
  type ContainerEngine,
  type ContainerTarget,
  type ExecutionBroker,
  type TrustedContainerLauncherV1
} from "agent-execution";
import type { RuntimeCompositionConfig, RuntimeFactoryDeps } from "./configured-runtime.js";

export async function configuredExecutionBroker(
  config: RuntimeCompositionConfig,
  deps: RuntimeFactoryDeps,
  workspace: string
): Promise<ExecutionBroker> {
  if (config.executionMode !== "container") {
    return deps.executionBroker ?? new LazyExecutionBroker({ sandboxMode: "required" });
  }
  const target = config.containerTarget ?? "managed";
  const containerConfig = {
    engine: config.containerEngine ?? "auto",
    target,
    network: config.networkMode ?? "none",
    ...(config.containerImage ? { image: config.containerImage } : {})
  } as const;
  if (containerConfig.target === "owned") assertContainerExecutionConfig(containerConfig);
  const launcher = await resolveContainerLauncher(deps, containerConfig, workspace);
  if (!launcher) {
    throw new ContainerUnavailableError(
      "The OCI execution backend is not installed for this Sigma build; host execution is never used as a fallback."
    );
  }
  assertTrustedLauncher(launcher, deps.executionBroker);
  if (containerConfig.target === "managed" && !launcher.managedAttestation) {
    throw new ContainerAttestationInvalidError(
      "Managed container mode requires a trusted launcher target selector and attestation."
    );
  }
  assertContainerExecutionConfig(containerConfig, launcher.managedAttestation);
  const broker = launcher.createBroker({
    workspace,
    config: containerConfig,
    ...(launcher.managedAttestation ? { managedAttestation: launcher.managedAttestation } : {})
  });
  return new AttestedContainerExecutionBroker(broker, {
    config: containerConfig,
    workspace,
    managedEnvironmentMode: config.managedEnvironmentMode ?? "disabled",
    ...(launcher.managedAttestation ? { managedAttestation: launcher.managedAttestation } : {})
  });
}

function assertTrustedLauncher(
  launcher: TrustedContainerLauncherV1,
  genericBroker: ExecutionBroker | undefined
): void {
  if (genericBroker) {
    throw new ContainerAttestationInvalidError(
      "A generic executionBroker cannot satisfy container mode. Supply only the trusted containerLauncher."
    );
  }
  if (launcher.protocolVersion !== 1) {
    throw new ContainerAttestationInvalidError("The trusted container launcher protocol version is unsupported.");
  }
}

async function resolveContainerLauncher(
  deps: RuntimeFactoryDeps,
  config: { engine: ContainerEngine; target: ContainerTarget },
  workspace: string
): Promise<TrustedContainerLauncherV1 | undefined> {
  if (deps.containerLauncher) return deps.containerLauncher;
  try {
    return config.target === "managed"
      ? await loadFixedContainerLauncher(workspace)
      : await loadFixedOwnedContainerLauncher(workspace, config.engine);
  } catch (error) {
    if ((error as { code?: unknown }).code !== "container_unavailable") throw error;
    throw new ContainerUnavailableError(
      "The OCI execution backend is not installed for this Sigma build; host execution is never used as a fallback.",
      { fixedBoundaryFailure: error instanceof Error ? error.message : String(error) },
      { cause: error }
    );
  }
}
