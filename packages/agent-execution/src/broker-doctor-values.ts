import path from "node:path";
import { BrokerProtocolError } from "./errors.js";
import { protocolRecord } from "./protocol.js";
import {
  booleanValue,
  brokerArchitecture,
  brokerPlatform,
  stringValue
} from "./broker-value-primitives.js";
import { BROKER_PROTOCOL_VERSION, type BrokerDoctorReport } from "./types.js";

function verifiedShells(
  input: unknown,
  platform: string
): NonNullable<BrokerDoctorReport["capabilities"]["shells"]> | undefined {
  if (input === undefined) return undefined;
  if (!Array.isArray(input) || input.length > 8) {
    throw new BrokerProtocolError("Broker verified shells are invalid.");
  }
  const seen = new Set<string>();
  return input.map((raw, index) => {
    const shell = protocolRecord(raw, `Broker verified shell[${index}]`);
    if (shell.kind !== "powershell" && shell.kind !== "cmd" && shell.kind !== "bash") {
      throw new BrokerProtocolError("Broker verified shell kind is invalid.");
    }
    const executable = stringValue(shell.executable, "Broker verified shell executable");
    const absolute = platform === "windows" || platform === "win32"
      ? path.win32.isAbsolute(executable) : path.posix.isAbsolute(executable);
    if (!executable || executable.includes("\0") || !absolute || seen.has(shell.kind) || shell.verified !== true) {
      throw new BrokerProtocolError("Broker verified shell entry is invalid or duplicated.");
    }
    seen.add(shell.kind);
    const supportsChildProcesses = shell.supportsChildProcesses;
    if (supportsChildProcesses !== undefined && typeof supportsChildProcesses !== "boolean") {
      throw new BrokerProtocolError("Broker verified shell child-process capability is invalid.");
    }
    return {
      kind: shell.kind,
      executable,
      verified: true as const,
      ...(supportsChildProcesses === undefined ? {} : { supportsChildProcesses })
    };
  });
}

function verifiedRuntimeCommands(input: unknown): string[] | undefined {
  if (input === undefined) return undefined;
  if (!Array.isArray(input) || input.length > 128
    || input.some((value) => typeof value !== "string"
      || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u.test(value))) {
    throw new BrokerProtocolError("Broker runtimeCommands are invalid.");
  }
  return [...new Set(input as string[])];
}

function executableSearchPaths(input: unknown, platform: string): string[] | undefined {
  if (input === undefined) return undefined;
  if (!Array.isArray(input) || input.length > 128) {
    throw new BrokerProtocolError("Broker executableSearchPaths are invalid.");
  }
  const paths = input.map((value) => {
    if (typeof value !== "string" || !value || value.length > 4_096 || value.includes("\0")) {
      throw new BrokerProtocolError("Broker executableSearchPaths are invalid.");
    }
    const absolute = platform === "windows" || platform === "win32"
      ? path.win32.isAbsolute(value) : path.posix.isAbsolute(value);
    if (!absolute) throw new BrokerProtocolError("Broker executableSearchPaths must be absolute.");
    return value;
  });
  return [...new Set(paths)];
}

function managedEnvironmentCapability(
  input: unknown
): BrokerDoctorReport["capabilities"]["managedEnvironment"] | undefined {
  if (input === undefined) return undefined;
  const value = protocolRecord(input, "Broker managed environment capability");
  return {
    available: booleanValue(value.available, "capabilities.managedEnvironment.available"),
    prepare: booleanValue(value.prepare, "capabilities.managedEnvironment.prepare")
  };
}

function parseDoctorHardening(input: unknown): BrokerDoctorReport["sandbox"]["hardening"] | undefined {
  if (input === undefined) return undefined;
  const hardening = protocolRecord(input, "Broker sandbox hardening");
  const landlockAbi = hardening.landlockAbi;
  if (landlockAbi !== undefined && landlockAbi !== null
    && (!Number.isSafeInteger(landlockAbi) || Number(landlockAbi) < 1)) {
    throw new BrokerProtocolError("Broker Landlock ABI is invalid.");
  }
  return {
    ...(typeof landlockAbi === "number" ? { landlockAbi } : {}),
    noNewPrivileges: booleanValue(hardening.noNewPrivileges, "sandbox.hardening.noNewPrivileges"),
    seccompFilter: booleanValue(hardening.seccompFilter, "sandbox.hardening.seccompFilter"),
    lessPrivilegedAppContainer: booleanValue(
      hardening.lessPrivilegedAppContainer,
      "sandbox.hardening.lessPrivilegedAppContainer"
    ),
    mountNamespace: booleanValue(hardening.mountNamespace, "sandbox.hardening.mountNamespace"),
    pidNamespace: booleanValue(hardening.pidNamespace, "sandbox.hardening.pidNamespace"),
    networkNamespace: booleanValue(hardening.networkNamespace, "sandbox.hardening.networkNamespace")
  };
}

function parseDoctorSandbox(input: unknown): BrokerDoctorReport["sandbox"] {
  const sandbox = protocolRecord(input, "Broker sandbox report");
  const hardening = parseDoctorHardening(sandbox.hardening);
  const lease = sandbox.lease === undefined || sandbox.lease === null
    ? undefined : protocolRecord(sandbox.lease, "Broker sandbox lease");
  if (lease && (lease.protocolVersion !== 1
    || lease.readStrategy !== "persistent_workspace_root"
    || lease.writerStrategy !== "root_lease_checkpointed"
    || lease.recoveryJournal !== "writes_only")) {
    throw new BrokerProtocolError("Broker sandbox lease metadata is invalid.");
  }
  return {
    available: booleanValue(sandbox.available, "sandbox.available"),
    backend: stringValue(sandbox.backend, "sandbox.backend"),
    selfTestPassed: booleanValue(sandbox.selfTestPassed, "sandbox.selfTestPassed"),
    setupRequired: booleanValue(sandbox.setupRequired, "sandbox.setupRequired"),
    ...(typeof sandbox.reason === "string" ? { reason: sandbox.reason } : {}),
    ...(lease ? { lease: {
      protocolVersion: 1,
      readStrategy: "persistent_workspace_root",
      writerStrategy: "root_lease_checkpointed",
      recoveryJournal: "writes_only"
    } } : {}),
    ...(hardening ? { hardening } : {})
  };
}

function parseDoctorCapabilities(input: unknown, platform: string): BrokerDoctorReport["capabilities"] {
  const capabilities = protocolRecord(input, "Broker capabilities");
  const networkModes = capabilities.networkModes;
  if (!Array.isArray(networkModes) || networkModes.some((mode) =>
    mode !== "none" && mode !== "loopback" && mode !== "full")) {
    throw new BrokerProtocolError("Broker networkModes are invalid.");
  }
  const shells = verifiedShells(capabilities.shells, platform);
  const runtimeCommands = verifiedRuntimeCommands(capabilities.runtimeCommands);
  const runtimeCommandSnapshotComplete = capabilities.runtimeCommandSnapshotComplete === undefined
    ? undefined : booleanValue(
      capabilities.runtimeCommandSnapshotComplete,
      "capabilities.runtimeCommandSnapshotComplete"
    );
  const searchPaths = executableSearchPaths(capabilities.executableSearchPaths, platform);
  const managedEnvironment = managedEnvironmentCapability(capabilities.managedEnvironment);
  return {
    foreground: booleanValue(capabilities.foreground, "capabilities.foreground"),
    background: booleanValue(capabilities.background, "capabilities.background"),
    stdin: booleanValue(capabilities.stdin, "capabilities.stdin"),
    pty: booleanValue(capabilities.pty, "capabilities.pty"),
    ...(capabilities.processHandoff === undefined ? {} : {
      processHandoff: booleanValue(capabilities.processHandoff, "capabilities.processHandoff")
    }),
    networkModes: networkModes as Array<"none" | "loopback" | "full">,
    ...(capabilities.executionRoots === undefined ? {} : {
      executionRoots: booleanValue(capabilities.executionRoots, "capabilities.executionRoots")
    }),
    ...(shells ? { shells } : {}),
    ...(runtimeCommands ? { runtimeCommands } : {}),
    ...(runtimeCommandSnapshotComplete === undefined ? {} : { runtimeCommandSnapshotComplete }),
    ...(searchPaths ? { executableSearchPaths: searchPaths } : {}),
    ...(managedEnvironment ? { managedEnvironment } : {})
  };
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return stringValue(value, label);
}

function addContainerStrings(
  target: NonNullable<BrokerDoctorReport["container"]>,
  values: Array<[keyof NonNullable<BrokerDoctorReport["container"]>, string | undefined]>
): void {
  for (const [key, value] of values) {
    if (value !== undefined) Object.assign(target, { [key]: value });
  }
}

function parseDoctorContainer(input: unknown): NonNullable<BrokerDoctorReport["container"]> {
  const container = protocolRecord(input, "Broker container report");
  const engine = optionalString(container.engine, "container.engine");
  if (engine !== undefined && engine !== "docker" && engine !== "podman") {
    throw new BrokerProtocolError("Broker container engine is invalid.");
  }
  const target = optionalString(container.target, "container.target");
  if (target !== undefined && target !== "owned" && target !== "managed") {
    throw new BrokerProtocolError("Broker container target is invalid.");
  }
  if (container.backend !== "oci") throw new BrokerProtocolError("Broker container backend must be 'oci'.");
  const parsed: NonNullable<BrokerDoctorReport["container"]> = {
    available: booleanValue(container.available, "container.available"),
    backend: "oci"
  };
  addContainerStrings(parsed, [
    ["engine", engine], ["target", target], ["targetId", optionalString(container.targetId, "container.targetId")],
    ["targetStartedAt", optionalString(container.targetStartedAt, "container.targetStartedAt")],
    ["imageId", optionalString(container.imageId, "container.imageId")],
    ["imageDigest", optionalString(container.imageDigest, "container.imageDigest")],
    ["helperDigest", optionalString(container.helperDigest, "container.helperDigest")],
    ["attestationDigest", optionalString(container.attestationDigest, "container.attestationDigest")],
    ["reason", optionalString(container.reason, "container.reason")]
  ]);
  return parsed;
}

export function parseDoctor(input: unknown): BrokerDoctorReport {
  const value = protocolRecord(input, "Broker doctor result");
  if (value.protocolVersion !== BROKER_PROTOCOL_VERSION) throw new BrokerProtocolError("Broker doctor version mismatch.");
  const platform = brokerPlatform(value.platform);
  return {
    protocolVersion: BROKER_PROTOCOL_VERSION,
    brokerVersion: stringValue(value.brokerVersion, "Broker version"),
    platform,
    architecture: brokerArchitecture(value.architecture),
    sandbox: parseDoctorSandbox(value.sandbox),
    capabilities: parseDoctorCapabilities(value.capabilities, platform),
    ...(value.container === undefined ? {} : { container: parseDoctorContainer(value.container) })
  };
}
