import type { BrokerDoctorReport } from "./types.js";
import type { VerifiedTargetExecutableEnvironment } from "./broker-request-policy.js";

export const verifiedShellExecutables = (report: BrokerDoctorReport | undefined): string[] =>
  report?.capabilities.shells
    ?.filter((shell) => shell.verified)
    .map((shell) => shell.executable) ?? [];

export const verifiedTargetExecutableEnvironment = (
  executionBackend: "native" | "oci" | undefined,
  report: BrokerDoctorReport | undefined
): VerifiedTargetExecutableEnvironment | undefined => executionBackend === "oci" && report
  ? {
      platform: report.platform,
      searchPaths: report.capabilities.executableSearchPaths ?? []
    }
  : undefined;
